import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface UpstreamConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

/** The type a context target must have. Policies compare by type, so a string never matches a numeric rule. */
export type ContextType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
export const CONTEXT_TYPES: readonly ContextType[] = ['string', 'number', 'integer', 'boolean', 'object', 'array'];

/** A context target that pins the argument's type: `{ "from": "$.amount", "type": "number" }`. */
export interface TypedSource { from: string; type: ContextType }

export interface ActionMapping {
  /** Exposed tool name, `<upstream>.<tool>`. */
  tool: string;
  actionType: string;
  resourceType?: string;
  /**
   * Targets (`resourceType`, `resourceId`, `context.<path>`) to `$.path` argument references or literals.
   * A `context.<path>` target can instead be a `TypedSource`, which refuses calls whose value has another type.
   */
  map: Record<string, string | TypedSource>;
}

export interface GatewayConfig {
  agent: { externalKey: string; name: string; principalId?: string; companyId?: string };
  upstreams: UpstreamConfig[];
  actions: ActionMapping[];
  unmappedTools: 'deny' | 'allow';
  /** Seconds a REQUIRE_APPROVAL call blocks waiting for a reviewer (0..900). */
  approvalWaitSeconds: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const SEG_RE = /^[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_TARGETS = '"resourceType", "resourceId", or "context.<path>"';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Validates raw JSON and applies defaults. Every failure is a `ConfigError` naming the JSON path. */
export function parseConfig(raw: unknown, source = 'ostrelio.gateway.json'): GatewayConfig {
  const fail = (path: string, problem: string): never => {
    throw new ConfigError(`${source}: ${path} ${problem}`);
  };

  if (!isRecord(raw)) return fail('(root)', 'must be a JSON object');
  const known = ['agent', 'upstreams', 'actions', 'unmappedTools', 'approvalWaitSeconds'];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) fail(key, `is not a known setting (expected ${known.join(', ')})`);
  }

  // agent
  const rawAgent = raw.agent;
  if (!isRecord(rawAgent)) return fail('agent', 'is required and must be an object');
  for (const key of Object.keys(rawAgent)) {
    if (!['externalKey', 'name', 'principalId', 'companyId'].includes(key)) fail(`agent.${key}`, 'is not a known setting');
  }
  if (!isNonEmptyString(rawAgent.externalKey)) fail('agent.externalKey', 'must be a non-empty string');
  if (!isNonEmptyString(rawAgent.name)) fail('agent.name', 'must be a non-empty string');
  if (rawAgent.principalId !== undefined && !isNonEmptyString(rawAgent.principalId)) {
    fail('agent.principalId', 'must be a non-empty string');
  }
  if (rawAgent.companyId !== undefined && !(typeof rawAgent.companyId === 'string' && UUID_RE.test(rawAgent.companyId))) {
    fail('agent.companyId', 'must be a company id (a UUID)');
  }
  const agent: GatewayConfig['agent'] = {
    externalKey: rawAgent.externalKey as string,
    name: rawAgent.name as string,
    principalId: (rawAgent.principalId as string | undefined) ?? 'mcp-client',
    ...(rawAgent.companyId === undefined ? {} : { companyId: rawAgent.companyId as string }),
  };

  // upstreams
  if (!Array.isArray(raw.upstreams) || raw.upstreams.length === 0) fail('upstreams', 'must be an array with at least one upstream');
  const upstreams: UpstreamConfig[] = [];
  const names = new Set<string>();
  (raw.upstreams as unknown[]).forEach((item, i) => {
    const at = `upstreams[${i}]`;
    if (!isRecord(item)) return fail(at, 'must be an object');
    for (const key of Object.keys(item)) {
      if (!['name', 'command', 'args', 'env', 'cwd'].includes(key)) fail(`${at}.${key}`, 'is not a known setting');
    }
    if (typeof item.name !== 'string' || !NAME_RE.test(item.name)) {
      fail(`${at}.name`, 'must be a string of letters, digits, "_" or "-"');
    }
    const name = item.name as string;
    if (names.has(name)) fail(`${at}.name`, `"${name}" is used by another upstream; names must be unique`);
    names.add(name);
    if (!isNonEmptyString(item.command)) fail(`${at}.command`, 'must be a non-empty string');
    const args = item.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) fail(`${at}.args`, 'must be an array of strings');
    const env = item.env ?? {};
    if (!isRecord(env)) return fail(`${at}.env`, 'must be an object of string values');
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== 'string') fail(`${at}.env.${k}`, 'must be a string');
    }
    if (item.cwd !== undefined && !isNonEmptyString(item.cwd)) fail(`${at}.cwd`, 'must be a non-empty string');
    upstreams.push({
      name,
      command: item.command as string,
      args: args as string[],
      env: env as Record<string, string>,
      ...(item.cwd === undefined ? {} : { cwd: item.cwd as string }),
    });
  });

  // actions
  const rawActions = raw.actions ?? [];
  if (!Array.isArray(rawActions)) return fail('actions', 'must be an array');
  const actions: ActionMapping[] = [];
  const tools = new Set<string>();
  rawActions.forEach((item: unknown, i) => {
    const at = `actions[${i}]`;
    if (!isRecord(item)) return fail(at, 'must be an object');
    for (const key of Object.keys(item)) {
      if (!['tool', 'actionType', 'resourceType', 'map'].includes(key)) fail(`${at}.${key}`, 'is not a known setting');
    }
    if (!isNonEmptyString(item.tool)) return fail(`${at}.tool`, 'must be a non-empty string like "<upstream>.<tool>"');
    const tool = item.tool;
    const dot = tool.indexOf('.');
    if (dot <= 0 || dot === tool.length - 1) fail(`${at}.tool`, `"${tool}" must look like "<upstream>.<tool>"`);
    const upstream = tool.slice(0, dot);
    if (!names.has(upstream)) fail(`${at}.tool`, `"${tool}" names upstream "${upstream}", which is not in upstreams`);
    if (tools.has(tool)) fail(`${at}.tool`, `"${tool}" is already mapped by another action`);
    tools.add(tool);
    if (!isNonEmptyString(item.actionType)) fail(`${at}.actionType`, 'must be a non-empty string');
    if (item.resourceType !== undefined && !isNonEmptyString(item.resourceType)) {
      fail(`${at}.resourceType`, 'must be a non-empty string');
    }
    const map = item.map ?? {};
    if (!isRecord(map)) return fail(`${at}.map`, 'must be an object');
    for (const [target, value] of Object.entries(map)) {
      const tpath = `${at}.map.${target}`;
      const okTarget = target === 'resourceType' || target === 'resourceId' ||
        (target.startsWith('context.') && target.slice(8).split('.').every((s) => s !== ''));
      if (!okTarget) fail(tpath, `is not a valid target; allowed targets are ${ALLOWED_TARGETS}`);
      let path: string;
      if (isRecord(value) && target.startsWith('context.')) {
        for (const key of Object.keys(value)) {
          if (key !== 'from' && key !== 'type') fail(`${tpath}.${key}`, 'is not a known setting (expected from, type)');
        }
        if (!CONTEXT_TYPES.includes(value.type as ContextType)) fail(`${tpath}.type`, `must be one of ${CONTEXT_TYPES.join(', ')}`);
        if (typeof value.from !== 'string' || !value.from.startsWith('$')) return fail(`${tpath}.from`, 'must be a "$.path" argument reference');
        path = value.from;
      } else if (typeof value === 'string') {
        path = value;
      } else {
        return fail(tpath, target.startsWith('context.')
          ? 'must be a "$.path" argument reference, a literal string, or { "from": "$.path", "type": "number" }'
          : 'must be a string (a "$.path" argument reference or a literal)');
      }
      if (path.startsWith('$') && !(path === '$' || (path.startsWith('$.') && path.slice(2).split('.').every((s) => SEG_RE.test(s))))) {
        fail(tpath, `"${path}" is not a valid argument path; use "$" or "$.name.name" (letters, digits, "_" or "-")`);
      }
    }
    if (item.resourceType === undefined && !('resourceType' in map)) {
      fail(at, 'needs a resourceType, either as "resourceType" or as map.resourceType');
    }
    actions.push({
      tool,
      actionType: item.actionType as string,
      ...(item.resourceType === undefined ? {} : { resourceType: item.resourceType as string }),
      map: map as Record<string, string | TypedSource>,
    });
  });

  // unmappedTools / approvalWaitSeconds
  const unmappedTools = raw.unmappedTools ?? 'deny';
  if (unmappedTools !== 'deny' && unmappedTools !== 'allow') fail('unmappedTools', 'must be "deny" or "allow"');
  const wait = raw.approvalWaitSeconds ?? 0;
  if (typeof wait !== 'number' || !Number.isInteger(wait) || wait < 0 || wait > 900) {
    fail('approvalWaitSeconds', 'must be an integer from 0 to 900');
  }

  return {
    agent, upstreams, actions,
    unmappedTools: unmappedTools as 'deny' | 'allow',
    approvalWaitSeconds: wait as number,
  };
}

/** Reads and validates a gateway config file. */
export async function loadConfig(path: string): Promise<GatewayConfig> {
  const abs = resolve(path);
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(`No gateway config at ${abs}. Create ostrelio.gateway.json or pass --config <path>.`);
    }
    throw new ConfigError(`Could not read ${abs}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${abs} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(raw, path);
}
