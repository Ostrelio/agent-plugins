import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ErrorCodes, OstrelioApprovalExpired, OstrelioApprovalRejected, OstrelioApprovalTimeout, OstrelioDenied,
  OstrelioError, type Ostrelio, type Proposal,
} from '@ostrelio/sdk';
import type { ActionMapping, GatewayConfig, UpstreamConfig } from './config.js';
import { MappingError, buildProposal, callHash } from './mapping.js';
import { UpstreamPool } from './upstreams.js';
import { VERSION } from './version.js';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const write = (level: string, msg: string): void => {
  process.stderr.write(`[ostrelio-gateway] ${level} ${msg}\n`);
};

/** Logs to stderr only: stdout belongs to MCP frames. */
export const stderrLogger: Logger = {
  info: (msg) => write('info', msg),
  warn: (msg) => write('warn', msg),
  error: (msg) => write('error', msg),
};

export interface GatewayOptions {
  config: GatewayConfig;
  client: Ostrelio;
  logger?: Logger;
  /** Override how upstreams are connected (tests). */
  connectUpstream?: (upstream: UpstreamConfig) => Promise<Client>;
}

/** Thrown inside the guarded callback so Ostrelio records FAILED while the caller still gets the upstream's own result. */
class UpstreamToolError extends Error {
  readonly result: CallToolResult;

  constructor(result: CallToolResult) {
    super('The upstream tool reported an error.');
    this.name = 'UpstreamToolError';
    this.result = result;
  }
}

const errorResult = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** MCP server that authorizes every mapped tool call with Ostrelio before forwarding it upstream. */
export class OstrelioGateway {
  readonly server: Server;
  readonly #config: GatewayConfig;
  readonly #client: Ostrelio;
  readonly #logger: Logger;
  readonly #pool: UpstreamPool;
  readonly #actions: Map<string, ActionMapping>;
  /** Idempotency key of calls still waiting on an approval, by call hash. */
  readonly #pending = new Map<string, string>();
  /** Bumped after every final outcome so an identical later call is a new action. */
  readonly #generation = new Map<string, number>();
  /**
   * Call hashes with a call in progress. Identical calls share an idempotency key, so running two at
   * once could forward one decision (or one approval) twice; the second is refused instead.
   */
  readonly #inFlight = new Set<string>();
  #executionId: string | null = null;
  #executionStarting: Promise<string> | null = null;

  constructor(options: GatewayOptions) {
    this.#config = options.config;
    this.#client = options.client;
    this.#logger = options.logger ?? stderrLogger;
    this.#pool = new UpstreamPool(
      options.config.upstreams, this.#logger,
      options.connectUpstream ? { connect: options.connectUpstream } : {},
    );
    this.#actions = new Map(options.config.actions.map((a) => [a.tool, a]));
    this.server = new Server({ name: 'ostrelio-gateway', version: VERSION }, { capabilities: { tools: {} } });
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.#pool.listTools() }));
    this.server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.callTool(request.params.name, request.params.arguments ?? {}));
  }

  /** Registers the agent, opens an execution when possible, then starts the upstreams. */
  async start(): Promise<void> {
    const { agent } = this.#config;
    const registered = await this.#client.registerAgent({
      externalKey: agent.externalKey, name: agent.name, runtime: 'mcp-gateway', version: VERSION,
    });
    this.#logger.info(`Agent ${registered.displayKey} "${agent.name}" is ${registered.status}.`);
    try {
      await this.#ensureExecution();
    } catch (error) {
      if (!isAgentStopped(error)) throw error;
      this.#logger.warn(`Agent "${agent.externalKey}" is ${registered.status === 'REVOKED' ? 'revoked' : 'paused'}; the execution will start when a call needs it.`);
    }
    await this.#pool.start();
  }

  /** Authorizes and forwards one tool call. Expected failures come back as `isError` results, never throws. */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const target = this.#pool.resolve(name);
    if (!target) return errorResult(`Unknown tool "${name}".`);

    const forward = () => this.#pool.callTool(target.upstream, target.tool, args);
    const action = this.#actions.get(name);
    if (!action) {
      if (this.#config.unmappedTools === 'deny') {
        return errorResult(`Ostrelio refused "${name}": it is not mapped to an Ostrelio action in ostrelio.gateway.json and unmappedTools is "deny".`);
      }
      this.#logger.warn(`Forwarding unmapped tool "${name}" without authorization (unmappedTools: "allow").`);
      try {
        return await forward();
      } catch (error) {
        return this.#upstreamFailure(name, error);
      }
    }

    let proposal;
    try {
      proposal = buildProposal(action, name, args);
    } catch (error) {
      if (error instanceof MappingError) return errorResult(error.message);
      throw error;
    }

    const base = callHash(name, args);
    if (this.#inFlight.has(base)) {
      return errorResult(`An identical "${name}" call is already in progress. Wait for it to finish, then call again if needed.`);
    }
    this.#inFlight.add(base);
    try {
      return await this.#authorizeAndForward(name, base, proposal, forward);
    } finally {
      this.#inFlight.delete(base);
    }
  }

  async #authorizeAndForward(
    name: string, base: string, proposal: Proposal, forward: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const key = this.#pending.get(base) ?? `mcp:${base}:${this.#generation.get(base) ?? 0}`;
    let ran = false;
    try {
      const executionId = await this.#ensureExecution();
      const result = await this.#client.guard(executionId, proposal, async () => {
        ran = true;
        const upstream = await forward();
        if (upstream.isError) throw new UpstreamToolError(upstream);
        return upstream;
      }, {
        idempotencyKey: key,
        approvalTimeoutMs: this.#config.approvalWaitSeconds * 1000,
        onOutcomeError: (error) => {
          this.#logger.warn(`"${name}" ran but reporting its outcome to Ostrelio failed: ${errorText(error)}`);
        },
      });
      this.#settle(base);
      return result;
    } catch (error) {
      if (error instanceof UpstreamToolError) {
        this.#settle(base);
        return error.result;
      }
      if (error instanceof OstrelioApprovalTimeout) {
        this.#pending.set(base, key);
        return errorResult(
          `Approval required: ${error.decision.reason.replace(/\.+$/, '')}. Approval id ${error.approval.approvalId}. Ask a human to approve in the Ostrelio dashboard, then call this tool again with the same arguments.`,
        );
      }
      if (error instanceof OstrelioDenied) {
        this.#settle(base);
        return errorResult(`Denied by Ostrelio: ${error.decision.reason}`);
      }
      if (error instanceof OstrelioApprovalRejected) {
        this.#settle(base);
        return errorResult(`A reviewer denied this action in Ostrelio (approval ${error.approval.approvalId}). Do not retry it.`);
      }
      if (error instanceof OstrelioApprovalExpired) {
        this.#settle(base);
        return errorResult('The Ostrelio approval for this action expired. Call the tool again to request a new approval.');
      }
      if (ran) {
        this.#settle(base);
        return this.#upstreamFailure(name, error);
      }
      if (error instanceof OstrelioError) {
        const { externalKey } = this.#config.agent;
        if (error.code === ErrorCodes.AGENT_PAUSED) {
          return errorResult(`Agent "${externalKey}" is paused in Ostrelio, so the gateway refuses every action. Resume it in the Ostrelio dashboard.`);
        }
        if (error.code === ErrorCodes.AGENT_REVOKED) {
          return errorResult(`Agent "${externalKey}" is revoked in Ostrelio, so the gateway refuses every action. Its access was revoked; ask an Ostrelio admin.`);
        }
        this.#logger.error(`Ostrelio could not authorize "${name}": ${errorText(error)}`);
        return errorResult(
          `Ostrelio could not authorize "${name}" (${error.code}): ${error.message}${error.requestId ? ` Request id ${error.requestId}.` : ''}`,
        );
      }
      this.#logger.error(`Unexpected error calling "${name}": ${errorText(error)}`);
      return errorResult(`Ostrelio could not authorize "${name}": ${errorText(error)}`);
    }
  }

  async close(): Promise<void> {
    await this.#pool.close();
    await this.server.close().catch(() => undefined);
  }

  /** A final outcome: the next identical call is a new action with a fresh idempotency key. */
  #settle(base: string): void {
    this.#pending.delete(base);
    this.#generation.set(base, (this.#generation.get(base) ?? 0) + 1);
  }

  #upstreamFailure(name: string, error: unknown): CallToolResult {
    this.#logger.error(`Upstream tool "${name}" failed: ${errorText(error)}`);
    return errorResult(`Upstream tool "${name}" failed: ${errorText(error)}`);
  }

  /** The session execution, started once and shared by concurrent callers. */
  #ensureExecution(): Promise<string> {
    if (this.#executionId) return Promise.resolve(this.#executionId);
    this.#executionStarting ??= this.#client.startExecution({
      agentId: this.#config.agent.externalKey,
      principalId: this.#config.agent.principalId ?? 'mcp-client',
      objective: 'MCP gateway session',
      ...(this.#config.agent.companyId ? { companyId: this.#config.agent.companyId } : {}),
    }).then((execution) => {
      this.#executionId = execution.id;
      return execution.id;
    }).finally(() => { this.#executionStarting = null; });
    return this.#executionStarting;
  }
}

const isAgentStopped = (error: unknown): boolean =>
  error instanceof OstrelioError && (error.code === ErrorCodes.AGENT_PAUSED || error.code === ErrorCodes.AGENT_REVOKED);

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

