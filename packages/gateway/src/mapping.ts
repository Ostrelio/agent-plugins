import { createHash } from 'node:crypto';
import type { Proposal } from '@ostrelio/sdk';
import type { ActionMapping, ContextType } from './config.js';

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MappingError';
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads `$` (the whole value) or `$.a.b` from plain objects. Missing segments give `undefined`. */
export function readPath(args: unknown, path: string): unknown {
  if (path === '$') return args;
  let current: unknown = args;
  for (const segment of path.slice(2).split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/** A mapped value: `$...` is an argument reference, anything else is a literal. */
const resolveValue = (value: string, args: Record<string, unknown>): unknown =>
  value.startsWith('$') ? readPath(args, value) : value;

/** Whether `value` has the declared type, or (no type declared) is a plain scalar. */
function hasContextType(value: unknown, type: ContextType | undefined): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    // Policies compare by type, so objects, arrays and null are only passed when a mapping asks for them.
    default: return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
  }
}

/** Builds the Ostrelio proposal for a tool call from its action mapping. */
export function buildProposal(action: ActionMapping, toolName: string, args: Record<string, unknown>): Proposal {
  const required = (target: 'resourceType' | 'resourceId', value: string): string => {
    const resolved = resolveValue(value, args);
    if (resolved === undefined || resolved === null) {
      throw new MappingError(`Argument ${value} is required for ${target}.`);
    }
    // Objects and arrays would stringify to colliding ids, so only scalars identify a resource.
    // An empty id names no resource; refuse it here with the argument's name instead of a bare 400.
    if (typeof resolved === 'string' && resolved.trim() === '') {
      throw new MappingError(`Argument ${value} must not be empty for ${target}.`);
    }
    if (typeof resolved === 'string' || (typeof resolved === 'number' && Number.isFinite(resolved))) return String(resolved);
    throw new MappingError(`Argument ${value} must be a string or a number for ${target}.`);
  };

  // parseConfig only allows plain strings for these two targets.
  const mappedType = action.map.resourceType as string | undefined;
  const resourceType = mappedType === undefined ? action.resourceType : required('resourceType', mappedType);
  if (resourceType === undefined) throw new MappingError(`Action for "${toolName}" has no resourceType.`);
  const mappedId = action.map.resourceId as string | undefined;
  const resourceId = mappedId === undefined ? toolName : required('resourceId', mappedId);

  const context: Record<string, unknown> = {};
  for (const [target, source] of Object.entries(action.map)) {
    if (!target.startsWith('context.')) continue;
    const value = typeof source === 'string' ? source : source.from;
    const type = typeof source === 'string' ? undefined : source.type;
    const resolved = resolveValue(value, args);
    // Policies must see every argument they were configured to check, so a missing one refuses the call.
    if (resolved === undefined) throw new MappingError(`Argument ${value} is required for ${target}.`);
    // A value of the wrong type would slip past a policy ("amount gt 1000" never matches the string "100000").
    if (!hasContextType(resolved, type)) {
      const expected = type ? `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}` : 'a string, number or boolean';
      throw new MappingError(`Argument ${value} must be ${expected} for ${target}.`);
    }
    const keys = target.slice(8).split('.');
    let node = context;
    for (const key of keys.slice(0, -1)) {
      const next = node[key];
      if (isPlainObject(next)) node = next;
      else {
        const created: Record<string, unknown> = {};
        node[key] = created;
        node = created;
      }
    }
    node[keys[keys.length - 1] as string] = resolved;
  }

  return { actionType: action.actionType, resourceType, resourceId, context };
}

/** JSON with object keys sorted recursively, so equal values serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

/** Hex SHA-256 identifying one tool call: its exposed name and canonical arguments. */
export function callHash(toolName: string, args: unknown): string {
  return createHash('sha256').update(`${toolName}\n${canonicalJson(args)}`).digest('hex');
}
