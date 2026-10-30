import type { GuardOptions, Ostrelio, RequestControl } from './client.js';
import {
  ErrorCodes, OstrelioApprovalExpired, OstrelioApprovalRejected, OstrelioApprovalTimeout, OstrelioDenied, OstrelioError,
  OstrelioHeld,
} from './errors.js';
import type { Proposal } from './types.js';

/**
 * How one tool maps to an Ostrelio action. The same shape as an entry of the gateway's
 * `ostrelio.gateway.json` `actions` list, without `tool`.
 */
export interface ToolActionRule {
  actionType: string;
  resourceType?: string;
  /** Targets (`resourceType`, `resourceId`, `context.<path>`) to `$.path` argument references or literals. */
  map?: Record<string, string>;
}

/**
 * Turns a tool call into a proposal. A function returns the proposal, or `undefined` for the default
 * naming; a record maps tool names to rules, and unlisted tools get the default naming.
 */
export type ToolMap =
  | ((toolName: string, args: unknown) => Proposal | undefined)
  | Record<string, ToolActionRule>;

/** Text the agent read that did not come from the person: a tool result, a web page, an email. */
export interface UntrustedInput { source: string; text: string }

export interface ToolAgent {
  /** The agent's stable key. Registered on the first call, then used as the execution's `agentId`. */
  externalKey: string;
  /** Display name. Defaults to `externalKey`. */
  name?: string;
  /** Defaults to `"node"`. */
  runtime?: string;
  /** The person or system the agent acts for. Defaults to `"sdk-user"`. */
  principalId?: string;
  /** The task, shown to reviewers. Defaults to the `request`, then to `"<name> session"`. */
  objective?: string;
  companyId?: string;
}

export interface ToolGuardOptions extends Pick<GuardOptions, 'onApprovalRequired' | 'onPending' | 'onOutcomeError'> {
  client: Ostrelio;
  /** The agent to open an execution for on the first call. Needed unless `executionId` is given. */
  agent?: ToolAgent;
  /** An execution you already started. Takes precedence over `agent`. */
  executionId?: string;
  map?: ToolMap;
  /**
   * How long a held call waits for a reviewer (default 15 minutes). `0` throws `OstrelioHeld`
   * at once; calling the tool again with the same arguments picks the approval back up.
   */
  approvalTimeoutMs?: number;
  /** The person's request, sent as `context.request`. A function is read on every call. */
  request?: string | (() => string | undefined);
  /** Extra untrusted text the agent read outside the wrapped tools, read on every call. */
  untrustedInputs?: () => UntrustedInput[];
  /** Send recent wrapped-tool results as `context.untrustedInputs` (default true). */
  trackResults?: boolean;
}

/** Matches the reviewers' limits in `Backend/src/domain/agent-review.ts` and the harness plugins. */
const MAX_UNTRUSTED = 5;
const MAX_UNTRUSTED_TEXT = 1_500;
const MAX_ARGS_TEXT = 2_000;
/** Held calls kept for resuming. The oldest is forgotten first; calling it again proposes anew. */
const MAX_PENDING = 500;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

function mappingError(message: string): OstrelioError {
  return new OstrelioError({ code: ErrorCodes.TOOL_MAPPING_ERROR, status: 0, message });
}

/** Reads `$` (the whole value) or `$.a.b` from plain objects, as the gateway's mapping does. */
function readPath(args: unknown, path: string): unknown {
  if (path === '$') return args;
  let current: unknown = args;
  for (const segment of path.slice(2).split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Builds a proposal from a gateway-style rule. A missing mapped argument refuses the call. */
export function proposalFromRule(rule: ToolActionRule, toolName: string, args: unknown): Proposal {
  const resolve = (value: string) => (value.startsWith('$') ? readPath(args, value) : value);
  const required = (target: 'resourceType' | 'resourceId', value: string): string => {
    const resolved = resolve(value);
    if (resolved === undefined || resolved === null) throw mappingError(`"${toolName}": argument ${value} is required for ${target}.`);
    // Only scalars identify a resource; objects would stringify to colliding ids.
    if (typeof resolved === 'string' && resolved.trim() === '') throw mappingError(`"${toolName}": argument ${value} must not be empty for ${target}.`);
    if (typeof resolved === 'string' || (typeof resolved === 'number' && Number.isFinite(resolved))) return String(resolved);
    throw mappingError(`"${toolName}": argument ${value} must be a string or a number for ${target}.`);
  };
  const map = rule.map ?? {};
  const resourceType = map.resourceType === undefined ? rule.resourceType : required('resourceType', map.resourceType);
  if (resourceType === undefined) throw mappingError(`"${toolName}": the rule has no resourceType.`);
  const resourceId = map.resourceId === undefined ? toolName : required('resourceId', map.resourceId);

  const context: Record<string, unknown> = { tool: toolName };
  for (const [target, value] of Object.entries(map)) {
    if (!target.startsWith('context.')) continue;
    const resolved = resolve(value);
    // Policies must see every argument they were configured to check.
    if (resolved === undefined) throw mappingError(`"${toolName}": argument ${value} is required for ${target}.`);
    const keys = target.slice(8).split('.');
    let node = context;
    for (const key of keys.slice(0, -1)) {
      const next = node[key];
      node = isPlainObject(next) ? next : (node[key] = {});
    }
    node[keys[keys.length - 1] as string] = resolved;
  }
  return { actionType: rule.actionType, resourceType, resourceId, context };
}

/**
 * The default naming, the same as the harness plugins give an MCP or other named tool: action type
 * `tool.<name>`, so a policy can target one tool exactly, with the arguments in context.
 */
export function defaultToolProposal(toolName: string, args: unknown): Proposal {
  const name = toolName.toLowerCase();
  const json = safeJson(args ?? {});
  return {
    actionType: `tool.${name}`, resourceType: 'tool', resourceId: name,
    context: { tool: toolName, args: json.length <= MAX_ARGS_TEXT ? (args ?? {}) : clip(json, MAX_ARGS_TEXT) },
  };
}

/**
 * Authorizes tool calls for one agent: maps each call to a proposal, adds the person's request and
 * recent tool results, and runs it through `Ostrelio.guard`. `wrapTools` uses one per tool set; use
 * one directly (`run`) when your loop dispatches plain tool definitions itself.
 */
export class ToolGuard {
  readonly #options: ToolGuardOptions;
  /** Distinguishes this guard's idempotency keys from another process's. */
  readonly #session = globalThis.crypto.randomUUID();
  #counter = 0;
  /** The idempotency key and proposal of calls not yet settled, by tool name and canonical arguments. */
  readonly #pending = new Map<string, { key: string; proposal: Proposal }>();
  /** Identical calls running at once get their own keys, so one approval never runs a tool twice. */
  readonly #inFlight = new Set<string>();
  #results: UntrustedInput[] = [];
  #executionId: string | null;
  #executionStarting: Promise<string> | null = null;

  constructor(options: ToolGuardOptions) {
    if (!options?.client) throw new TypeError('wrapTools: client is required.');
    if (!options.executionId && !options.agent?.externalKey) throw new TypeError('wrapTools: pass agent or executionId.');
    this.#options = options;
    this.#executionId = options.executionId ?? null;
  }

  /** The proposal a call maps to, before the request and untrusted inputs are added. */
  proposalFor(toolName: string, args: unknown): Proposal {
    const { map } = this.#options;
    if (typeof map === 'function') return map(toolName, args) ?? defaultToolProposal(toolName, args);
    const rule = map && Object.hasOwn(map, toolName) ? map[toolName] : undefined;
    return rule ? proposalFromRule(rule, toolName, args) : defaultToolProposal(toolName, args);
  }

  /** Records text the agent read so later calls carry it as an untrusted input. */
  recordInput(source: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.#results = [...this.#results, { source: clip(source, 200), text: clip(trimmed, MAX_UNTRUSTED_TEXT) }].slice(-MAX_UNTRUSTED);
  }

  /**
   * Authorizes one call and runs `execute` only when allowed. Throws `OstrelioDenied`,
   * `OstrelioApprovalRejected`, `OstrelioApprovalExpired`, or `OstrelioHeld` without running it.
   * If `execute` throws, `FAILED` is reported and its error rethrown.
   */
  async run<T>(toolName: string, args: unknown, execute: () => Promise<T> | T, control: RequestControl = {}): Promise<T> {
    const parsed = parseArgs(args);
    const callId = `${toolName}\n${canonicalJson(parsed)}`;
    const owner = !this.#inFlight.has(callId);
    // A retried held call reuses its key and proposal, so it resumes the same approval.
    const entry = (owner ? this.#pending.get(callId) : undefined)
      ?? { key: `tools:${this.#session}:${++this.#counter}`, proposal: this.#withContext(this.proposalFor(toolName, parsed)) };
    if (owner) {
      this.#pending.delete(callId);
      this.#pending.set(callId, entry);
      if (this.#pending.size > MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value as string);
      this.#inFlight.add(callId);
    }
    const settle = () => { if (owner) this.#pending.delete(callId); };

    let ran = false;
    try {
      const executionId = await this.#ensureExecution(control);
      const { approvalTimeoutMs, onApprovalRequired, onPending, onOutcomeError } = this.#options;
      const result = await this.#options.client.guard(executionId, entry.proposal, async () => {
        ran = true;
        return await execute();
      }, {
        idempotencyKey: entry.key,
        ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
        ...(onApprovalRequired ? { onApprovalRequired } : {}),
        ...(onPending ? { onPending } : {}),
        ...(onOutcomeError ? { onOutcomeError } : {}),
        ...(control.signal ? { signal: control.signal } : {}),
      });
      settle();
      if (this.#options.trackResults !== false) this.recordInput(sourceOf(toolName, parsed), textOf(result));
      return result;
    } catch (error) {
      if (error instanceof OstrelioApprovalTimeout) throw new OstrelioHeld(error.decision, error.approval, error);
      // Final answers: the next identical call is a new action. Anything else (network, a paused
      // agent) keeps the key, so a retry replays the same decision instead of proposing twice.
      if (ran || error instanceof OstrelioDenied || error instanceof OstrelioApprovalRejected || error instanceof OstrelioApprovalExpired) settle();
      throw error;
    } finally {
      if (owner) this.#inFlight.delete(callId);
    }
  }

  #withContext(proposal: Proposal): Proposal {
    const { request, untrustedInputs } = this.#options;
    const said = typeof request === 'function' ? request() : request;
    const untrusted = [...(untrustedInputs?.() ?? []), ...this.#results].slice(-MAX_UNTRUSTED);
    return {
      ...proposal,
      context: {
        ...proposal.context,
        ...(said?.trim() ? { request: said.trim() } : {}),
        ...(untrusted.length ? { untrustedInputs: untrusted } : {}),
      },
    };
  }

  /** The execution, started once on the first call and shared by concurrent calls. */
  #ensureExecution(control: RequestControl): Promise<string> {
    if (this.#executionId) return Promise.resolve(this.#executionId);
    const agent = this.#options.agent as ToolAgent;
    const { client, request } = this.#options;
    const name = agent.name ?? agent.externalKey;
    const signal = control.signal ? { signal: control.signal } : {};
    this.#executionStarting ??= (async () => {
      await client.registerAgent({ externalKey: agent.externalKey, name, runtime: agent.runtime ?? 'node' }, signal);
      const said = typeof request === 'function' ? request() : request;
      const execution = await client.startExecution({
        agentId: agent.externalKey,
        principalId: agent.principalId ?? 'sdk-user',
        objective: agent.objective ?? (said?.trim() || `${name} session`),
        ...(agent.companyId ? { companyId: agent.companyId } : {}),
      }, signal);
      this.#executionId = execution.id;
      return execution.id;
    })().finally(() => { this.#executionStarting = null; });
    return this.#executionStarting;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool functions take any arguments
type AnyFunction = (...args: any[]) => any;

/** Plain functions become async; tool objects keep their shape. */
export type WrappedTools<T> = {
  [K in keyof T]: T[K] extends AnyFunction ? (...args: Parameters<T[K]>) => Promise<Awaited<ReturnType<T[K]>>> : T[K];
};

/**
 * Wraps a tool set so every call is authorized by Ostrelio first. Accepts a record of functions, a
 * Vercel AI SDK tool record (`execute`), OpenAI `runTools` definitions (`function.function`), or
 * Anthropic tool-runner definitions (`run`), as a record or an array, and returns the same shape.
 *
 * ```ts
 * const tools = wrapTools({ read_file, run_shell, rotate_secret }, {
 *   client, agent: { externalKey: 'ops-agent' },
 *   map: { run_shell: { actionType: 'shell.exec', resourceType: 'shell', map: { resourceId: '$.command' } } },
 * });
 * ```
 *
 * A tool definition with no implementation throws `TypeError`: dispatch it with `ToolGuard.run`.
 */
export function wrapTools<T extends Record<string, unknown> | readonly unknown[]>(
  tools: T, options: ToolGuardOptions | ToolGuard,
): WrappedTools<T> {
  const guard = options instanceof ToolGuard ? options : new ToolGuard(options);
  if (Array.isArray(tools)) return tools.map((tool, i) => wrapOne(guard, tool, undefined, i)) as WrappedTools<T>;
  return Object.fromEntries(
    Object.entries(tools).map(([key, tool]) => [key, wrapOne(guard, tool, key, key)]),
  ) as WrappedTools<T>;
}

function wrapOne(guard: ToolGuard, tool: unknown, key: string | undefined, at: string | number): unknown {
  const named = (fallback: unknown) => {
    const name = key ?? (typeof fallback === 'string' ? fallback : undefined);
    if (!name) throw new TypeError(`wrapTools: tool ${at} has no name.`);
    return name;
  };
  if (typeof tool === 'function') return wrapFunction(guard, named(tool.name), tool as AnyFunction);
  if (!isPlainObject(tool)) throw new TypeError(`wrapTools: tool ${at} is not a function or a tool definition.`);
  // Vercel AI SDK: { execute(args, { abortSignal }) }.
  if (typeof tool.execute === 'function') {
    return { ...tool, execute: wrapFunction(guard, named(tool.name), tool.execute as AnyFunction, true) };
  }
  // OpenAI runTools: { type: 'function', function: { name, function(args) } }.
  const fn = tool.function;
  if (isPlainObject(fn) && typeof fn.function === 'function') {
    return { ...tool, function: { ...fn, function: wrapFunction(guard, named(fn.name), fn.function as AnyFunction) } };
  }
  // Anthropic tool runner: { name, input_schema, run(args) }.
  if (typeof tool.run === 'function') return { ...tool, run: wrapFunction(guard, named(tool.name), tool.run as AnyFunction) };
  throw new TypeError(`wrapTools: tool ${at} has no implementation (execute, run, or function.function). Dispatch it with ToolGuard.run.`);
}

function wrapFunction(guard: ToolGuard, name: string, fn: AnyFunction, aiSdk = false): AnyFunction {
  return async function wrapped(this: unknown, ...args: unknown[]) {
    const options = args[1];
    const signal = aiSdk && isPlainObject(options) && options.abortSignal instanceof AbortSignal ? options.abortSignal : undefined;
    return guard.run(name, args[0], () => fn.apply(this, args), signal ? { signal } : {});
  };
}

/** OpenAI passes arguments as a JSON string when the tool has no parser. */
function parseArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? {};
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return { raw: clip(args, MAX_ARGS_TEXT) };
  }
}

/** Where a result came from: the tool and its target, as the harness plugins label reads. */
function sourceOf(toolName: string, args: unknown): string {
  const record = isPlainObject(args) ? args : {};
  for (const key of ['path', 'file_path', 'file', 'url', 'command', 'query', 'id']) {
    if (typeof record[key] === 'string' && record[key]) return `${toolName} ${record[key] as string}`;
  }
  return toolName;
}

const textOf = (result: unknown): string => (typeof result === 'string' ? result : result === undefined ? '' : safeJson(result));

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** JSON with object keys sorted recursively, so equal arguments identify the same call. */
function canonicalJson(value: unknown): string {
  return safeJson(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  return value;
}
