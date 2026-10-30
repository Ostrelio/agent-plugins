import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from '../src/config.js';

// Tests poke at arbitrary shapes on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

const valid = () => ({
  agent: { externalKey: 'gw', name: 'Gateway' },
  upstreams: [{ name: 'fake', command: 'node' }],
  actions: [{ tool: 'fake.create_refund', actionType: 'refund.create', resourceType: 'charge', map: { resourceId: '$.charge' } }],
});

/** Parses `mutate(valid())` and returns the ConfigError message. */
const failure = (mutate: (raw: Raw) => void): string => {
  const raw = valid() as Raw;
  mutate(raw);
  try {
    parseConfig(raw, 'cfg.json');
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('parseConfig did not throw');
};

describe('parseConfig', () => {
  it('applies defaults to a minimal valid config', () => {
    const config = parseConfig(valid());
    expect(config.unmappedTools).toBe('deny');
    expect(config.approvalWaitSeconds).toBe(0);
    expect(config.agent).toEqual({ externalKey: 'gw', name: 'Gateway', principalId: 'mcp-client' });
    expect(config.upstreams).toEqual([{ name: 'fake', command: 'node', args: [], env: {} }]);
    expect(config.actions).toEqual([
      { tool: 'fake.create_refund', actionType: 'refund.create', resourceType: 'charge', map: { resourceId: '$.charge' } },
    ]);
  });

  it('keeps agent.companyId when it is a UUID and omits it otherwise', () => {
    const companyId = '0b6f3f0e-4a0c-4d57-9d5e-2f8a9a1c7e11';
    const raw = valid() as Raw;
    expect(parseConfig(raw).agent).not.toHaveProperty('companyId');
    raw.agent.companyId = companyId;
    expect(parseConfig(raw).agent.companyId).toBe(companyId);
  });

  it('keeps explicit values', () => {
    const raw = valid() as Raw;
    raw.agent.principalId = 'ops';
    raw.upstreams[0] = { name: 'fake', command: 'node', args: ['a.mjs'], env: { K: 'v' }, cwd: '/tmp' };
    raw.unmappedTools = 'allow';
    raw.approvalWaitSeconds = 900;
    const config = parseConfig(raw);
    expect(config.agent.principalId).toBe('ops');
    expect(config.upstreams[0]).toEqual({ name: 'fake', command: 'node', args: ['a.mjs'], env: { K: 'v' }, cwd: '/tmp' });
    expect(config.unmappedTools).toBe('allow');
    expect(config.approvalWaitSeconds).toBe(900);
  });

  it('allows omitting actions', () => {
    const raw = valid() as Raw;
    delete raw.actions;
    expect(parseConfig(raw).actions).toEqual([]);
  });

  it('accepts resourceType supplied through map and context targets', () => {
    const raw = valid() as Raw;
    raw.actions[0] = {
      tool: 'fake.create_refund', actionType: 'refund.create',
      map: { resourceType: 'charge', 'context.a.b': '$.x.y', 'context.lit': 'literal', 'context.whole': '$' },
    };
    expect(parseConfig(raw).actions[0]?.map).toEqual({ resourceType: 'charge', 'context.a.b': '$.x.y', 'context.lit': 'literal', 'context.whole': '$' });
  });

  it('names the source in every error', () => {
    expect(failure((raw) => { raw.bogus = 1; })).toMatch(/^cfg\.json: /);
  });

  it('rejects a non-object root', () => {
    expect(() => parseConfig([])).toThrow(/\(root\) must be a JSON object/);
    expect(() => parseConfig(null)).toThrow(/\(root\) must be a JSON object/);
  });

  it('rejects an unknown top-level key', () => {
    expect(failure((raw) => { raw.unmapped = 'deny'; })).toContain('unmapped is not a known setting');
  });

  it('rejects an unknown agent key and bad agent fields', () => {
    expect(failure((raw) => { raw.agent.extra = 1; })).toContain('agent.extra is not a known setting');
    expect(failure((raw) => { raw.agent.name = ''; })).toContain('agent.name must be a non-empty string');
    expect(failure((raw) => { delete raw.agent.externalKey; })).toContain('agent.externalKey must be a non-empty string');
    expect(failure((raw) => { raw.agent.principalId = 3; })).toContain('agent.principalId must be a non-empty string');
    expect(failure((raw) => { raw.agent.companyId = 'acme'; })).toContain('agent.companyId must be a company id (a UUID)');
    expect(failure((raw) => { raw.agent.companyId = 7; })).toContain('agent.companyId must be a company id (a UUID)');
    expect(failure((raw) => { delete raw.agent; })).toContain('agent is required');
  });

  it('rejects a bad upstream name', () => {
    expect(failure((raw) => { raw.upstreams[0].name = 'my.server'; })).toContain('upstreams[0].name must be a string of letters, digits');
    expect(failure((raw) => { raw.upstreams[0].name = 'has space'; })).toContain('upstreams[0].name');
    expect(failure((raw) => { delete raw.upstreams[0].name; })).toContain('upstreams[0].name');
  });

  it('rejects duplicate upstream names', () => {
    const message = failure((raw) => { raw.upstreams.push({ name: 'fake', command: 'node' }); });
    expect(message).toContain('upstreams[1].name');
    expect(message).toContain('"fake" is used by another upstream');
  });

  it('rejects missing or empty upstreams and bad upstream fields', () => {
    expect(failure((raw) => { raw.upstreams = []; })).toContain('upstreams must be an array with at least one upstream');
    expect(failure((raw) => { delete raw.upstreams; })).toContain('upstreams must be an array');
    expect(failure((raw) => { raw.upstreams[0].command = ' '; })).toContain('upstreams[0].command must be a non-empty string');
    expect(failure((raw) => { raw.upstreams[0].args = [1]; })).toContain('upstreams[0].args must be an array of strings');
    expect(failure((raw) => { raw.upstreams[0].env = { K: 1 }; })).toContain('upstreams[0].env.K must be a string');
    expect(failure((raw) => { raw.upstreams[0].env = []; })).toContain('upstreams[0].env must be an object');
    expect(failure((raw) => { raw.upstreams[0].cwd = ''; })).toContain('upstreams[0].cwd must be a non-empty string');
    expect(failure((raw) => { raw.upstreams[0].extra = 1; })).toContain('upstreams[0].extra is not a known setting');
    expect(failure((raw) => { raw.upstreams[0] = 'x'; })).toContain('upstreams[0] must be an object');
  });

  it('rejects an action tool whose upstream is unknown', () => {
    const message = failure((raw) => { raw.actions[0].tool = 'ghost.create_refund'; });
    expect(message).toContain('actions[0].tool');
    expect(message).toContain('upstream "ghost"');
  });

  it('rejects malformed and duplicate action tools', () => {
    expect(failure((raw) => { raw.actions[0].tool = 'nodot'; })).toContain('actions[0].tool "nodot" must look like "<upstream>.<tool>"');
    expect(failure((raw) => { raw.actions[0].tool = 'fake.'; })).toContain('actions[0].tool');
    expect(failure((raw) => { raw.actions[0].tool = '.x'; })).toContain('actions[0].tool');
    const message = failure((raw) => { raw.actions.push({ ...raw.actions[0] }); });
    expect(message).toContain('actions[1].tool');
    expect(message).toContain('already mapped');
  });

  it('rejects a bad map target', () => {
    const message = failure((raw) => { raw.actions[0].map['amount.value'] = '$.amount'; });
    expect(message).toContain('actions[0].map.amount.value is not a valid target');
    expect(message).toContain('context.<path>');
    expect(failure((raw) => { raw.actions[0].map['context.'] = '$.a'; })).toContain('actions[0].map.context.');
    expect(failure((raw) => { raw.actions[0].map['context.a..b'] = '$.a'; })).toContain('actions[0].map.context.a..b');
  });

  it('rejects a non-string map value', () => {
    expect(failure((raw) => { raw.actions[0].map.resourceId = 5; })).toContain('actions[0].map.resourceId must be a string');
    // Typed sources are for context targets only.
    expect(failure((raw) => { raw.actions[0].map.resourceId = { from: '$.charge', type: 'string' }; })).toContain('actions[0].map.resourceId must be a string');
  });

  it('accepts a typed context source and rejects a bad one', () => {
    const raw = valid() as Raw;
    raw.actions[0].map['context.amount'] = { from: '$.amount', type: 'number' };
    expect(parseConfig(raw).actions[0]?.map['context.amount']).toEqual({ from: '$.amount', type: 'number' });
    expect(failure((r) => { r.actions[0].map['context.amount'] = { from: '$.amount', type: 'money' }; })).toContain('actions[0].map.context.amount.type must be one of string, number, integer');
    expect(failure((r) => { r.actions[0].map['context.amount'] = { from: 'USD', type: 'string' }; })).toContain('actions[0].map.context.amount.from must be a "$.path"');
    expect(failure((r) => { r.actions[0].map['context.amount'] = { from: '$.a..b', type: 'number' }; })).toContain('is not a valid argument path');
    expect(failure((r) => { r.actions[0].map['context.amount'] = { from: '$.amount', type: 'number', min: 0 }; })).toContain('context.amount.min is not a known setting');
  });

  it('rejects a bad JSONPath', () => {
    for (const bad of ['$charge', '$.', '$.a..b', '$.a b', '$.a[0]', '$.*']) {
      const message = failure((raw) => { raw.actions[0].map.resourceId = bad; });
      expect(message, bad).toContain('actions[0].map.resourceId');
      expect(message, bad).toContain('is not a valid argument path');
    }
  });

  it('rejects an action with no resourceType', () => {
    const message = failure((raw) => { delete raw.actions[0].resourceType; });
    expect(message).toContain('actions[0] needs a resourceType');
  });

  it('rejects bad action fields', () => {
    expect(failure((raw) => { raw.actions[0].actionType = ''; })).toContain('actions[0].actionType must be a non-empty string');
    expect(failure((raw) => { raw.actions[0].resourceType = ''; })).toContain('actions[0].resourceType must be a non-empty string');
    expect(failure((raw) => { raw.actions[0].extra = 1; })).toContain('actions[0].extra is not a known setting');
    expect(failure((raw) => { raw.actions[0].map = []; })).toContain('actions[0].map must be an object');
    expect(failure((raw) => { raw.actions = {}; })).toContain('actions must be an array');
    expect(failure((raw) => { raw.actions[0] = 3; })).toContain('actions[0] must be an object');
  });

  it('rejects a bad unmappedTools', () => {
    expect(failure((raw) => { raw.unmappedTools = 'maybe'; })).toContain('unmappedTools must be "deny" or "allow"');
  });

  it('rejects a bad approvalWaitSeconds', () => {
    for (const bad of [-1, 901, 1.5, '5']) {
      expect(failure((raw) => { raw.approvalWaitSeconds = bad; }), String(bad)).toContain('approvalWaitSeconds must be an integer from 0 to 900');
    }
  });
});

describe('loadConfig', () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'gateway-config-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('loads and validates a file', async () => {
    const path = join(dir, 'ok.json');
    await writeFile(path, JSON.stringify(valid()));
    const config = await loadConfig(path);
    expect(config.agent.principalId).toBe('mcp-client');
    expect(config.upstreams[0]?.name).toBe('fake');
  });

  it('explains a missing file', async () => {
    const path = join(dir, 'missing.json');
    const error = await loadConfig(path).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(`No gateway config at ${path}`);
    expect((error as Error).message).toContain('--config');
  });

  it('explains invalid JSON', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, '{ not json');
    const error = await loadConfig(path).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(`${path} is not valid JSON`);
  });

  it('reports validation errors with the file path as source', async () => {
    const path = join(dir, 'invalid.json');
    await writeFile(path, JSON.stringify({ ...valid(), unmappedTools: 'nope' }));
    await expect(loadConfig(path)).rejects.toThrow(`${path}: unmappedTools must be "deny" or "allow"`);
  });

  it('reports a read failure other than ENOENT', async () => {
    const path = join(dir, 'a-directory');
    await mkdir(path);
    const error = await loadConfig(path).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('Could not read');
  });
});
