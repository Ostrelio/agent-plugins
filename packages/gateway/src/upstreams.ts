import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { UpstreamConfig } from './config.js';
import type { Logger } from './gateway.js';
import { VERSION } from './version.js';

/** The upstream is not running and could not be (re)started, or died during a call. */
export class UpstreamUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'UpstreamUnavailableError';
  }
}

export interface UpstreamPoolOptions {
  /** Override how an upstream is connected (tests). */
  connect?: (upstream: UpstreamConfig) => Promise<Client>;
}

interface UpstreamState {
  config: UpstreamConfig;
  client: Client | null;
  /** `null` until the tools were listed once. */
  tools: Tool[] | null;
  reconnecting: Promise<Client> | null;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One MCP client per upstream server, with lazy reconnect when a server dies. */
export class UpstreamPool {
  readonly #states = new Map<string, UpstreamState>();
  readonly #logger: Logger;
  readonly #connect: (upstream: UpstreamConfig) => Promise<Client>;
  #closed = false;

  constructor(upstreams: UpstreamConfig[], logger: Logger, options: UpstreamPoolOptions = {}) {
    this.#logger = logger;
    this.#connect = options.connect ?? defaultConnect;
    for (const config of upstreams) this.#states.set(config.name, { config, client: null, tools: null, reconnecting: null });
  }

  /** Connects every upstream and lists its tools. A failing upstream is logged and skipped. */
  async start(): Promise<void> {
    await Promise.all([...this.#states.values()].map(async (state) => {
      try {
        await this.#ensure(state);
      } catch (error) {
        this.#logger.error(`Upstream "${state.config.name}" failed to start: ${message(error)}`);
      }
    }));
  }

  /** Tools of every known upstream, named `<upstream>.<tool>`. Retries upstreams that never listed. */
  async listTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    for (const state of this.#states.values()) {
      if (state.tools === null) {
        try {
          await this.#ensure(state);
        } catch (error) {
          this.#logger.error(`Upstream "${state.config.name}" is unavailable: ${message(error)}`);
        }
      }
      for (const tool of state.tools ?? []) tools.push({ ...tool, name: `${state.config.name}.${tool.name}` });
    }
    return tools;
  }

  /** Splits an exposed name on its first dot; `null` unless the upstream is configured. */
  resolve(exposedName: string): { upstream: string; tool: string } | null {
    const dot = exposedName.indexOf('.');
    if (dot <= 0) return null;
    const upstream = exposedName.slice(0, dot);
    return this.#states.has(upstream) ? { upstream, tool: exposedName.slice(dot + 1) } : null;
  }

  async callTool(upstreamName: string, toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const state = this.#states.get(upstreamName);
    if (!state) throw new UpstreamUnavailableError(`Upstream "${upstreamName}" is not configured.`);
    let client: Client;
    try {
      client = await this.#ensure(state);
    } catch (error) {
      throw new UpstreamUnavailableError(`Upstream "${upstreamName}" is not running: ${message(error)}`, error);
    }
    try {
      return (await client.callTool({ name: toolName, arguments: args })) as CallToolResult;
    } catch (error) {
      this.#markDown(state, client);
      throw new UpstreamUnavailableError(`Upstream "${upstreamName}" stopped while running ${toolName}: ${message(error)}`, error);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#states.values()].map(async (state) => {
      const client = state.client;
      state.client = null;
      if (client) await client.close().catch(() => undefined);
    }));
  }

  #markDown(state: UpstreamState, client: Client): void {
    if (state.client === client) state.client = null;
    void client.close().catch(() => undefined);
  }

  /** The live client, connecting (and listing tools) first when it is down. Concurrent callers share one attempt. */
  #ensure(state: UpstreamState): Promise<Client> {
    if (state.client) return Promise.resolve(state.client);
    if (state.reconnecting) return state.reconnecting;
    const attempt = (async () => {
      if (this.#closed) throw new Error('the gateway is shutting down');
      const client = await this.#connect(state.config);
      try {
        const previous = client.onclose;
        client.onclose = () => {
          previous?.();
          if (state.client === client) {
            state.client = null;
            if (!this.#closed) this.#logger.warn(`Upstream "${state.config.name}" exited.`);
          }
        };
        state.tools = await listAll(client);
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
      state.client = client;
      return client;
    })();
    state.reconnecting = attempt;
    const clear = () => { if (state.reconnecting === attempt) state.reconnecting = null; };
    attempt.then(clear, clear);
    return attempt;
  }
}

async function listAll(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

/** Spawns the upstream over stdio with a minimal environment, so `OSTRELIO_API_KEY` is never inherited. */
async function defaultConnect(upstream: UpstreamConfig): Promise<Client> {
  const transport = new StdioClientTransport({
    command: upstream.command,
    args: upstream.args,
    env: { ...getDefaultEnvironment(), ...upstream.env },
    ...(upstream.cwd === undefined ? {} : { cwd: upstream.cwd }),
    stderr: 'inherit',
  });
  const client = new Client({ name: 'ostrelio-gateway', version: VERSION });
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  return client;
}
