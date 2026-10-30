import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main, parseUpstream } from './cli.ts';
import { writeHarness } from './harness.ts';
import { installDefaultPolicies, policyAuth } from './policies.ts';

const KEY = 'ost_test_abcdef123456';
const URL_ = 'http://127.0.0.1:3100';
const tmp = () => mkdtempSync(join(tmpdir(), 'ostrelio-connect-'));
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const mode = (path: string) => statSync(path).mode & 0o777;

/** A packages/ folder with the pieces the CLI points at. */
function fakePackages(): string {
  const dir = tmp();
  mkdirSync(join(dir, 'claude-code-plugin'));
  mkdirSync(join(dir, 'omp-plugin'));
  mkdirSync(join(dir, 'gateway', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'gateway', 'dist', 'cli.js'), '');
  mkdirSync(join(dir, 'agent-guard'));
  writeFileSync(join(dir, 'agent-guard', 'default-policies.json'), JSON.stringify([
    { displayKey: 'POL-AGT-01', category: 'Agent tools', name: 'Reads', rule: { actionTypes: ['agent.read'], decision: 'ALLOW', reason: 'ok' } },
    { displayKey: 'POL-AGT-02', category: 'Agent tools', name: 'Edits', rule: { actionTypes: ['file.write'], decision: 'ALLOW', reason: 'ok' } },
  ]));
  return dir;
}

test('claude-code merges key and URL into settings.local.json and keeps other settings', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, env: { KEEP: '1' } }));
  const packagesDir = fakePackages();
  const result = writeHarness({ harness: 'claude-code', dir, baseUrl: URL_, apiKey: KEY, companyId: 'co-1', packagesDir });
  const file = join(dir, '.claude', 'settings.local.json');
  assert.deepEqual(json(file), {
    permissions: { allow: ['Bash(ls)'] },
    env: { KEEP: '1', OSTRELIO_API_KEY: KEY, OSTRELIO_BASE_URL: URL_, OSTRELIO_COMPANY_ID: 'co-1' },
  });
  assert.equal(mode(file), 0o600);
  assert.deepEqual(result.files, [file]);
  assert.equal(result.start, `claude --plugin-dir ${join(packagesDir, 'claude-code-plugin')}`);
});

test('claude-code refuses a settings file that is not JSON instead of overwriting it', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'settings.local.json'), '{ nope');
  assert.throws(() => writeHarness({ harness: 'claude-code', dir, baseUrl: URL_, apiKey: KEY, packagesDir: fakePackages() }), /not a JSON object/);
});

test('omp writes a private env file, ignores it in git and prints a start line that sources it', () => {
  const dir = tmp();
  writeFileSync(join(dir, '.gitignore'), 'node_modules');
  const packagesDir = fakePackages();
  const result = writeHarness({ harness: 'omp', dir, baseUrl: 'https://acme.example.com', apiKey: KEY, packagesDir });
  const envFile = join(dir, '.ostrelio-you', 'connect.env');
  assert.equal(readFileSync(envFile, 'utf8'), `OSTRELIO_API_KEY=${KEY}\nOSTRELIO_BASE_URL=https://acme.example.com\n`);
  assert.equal(mode(envFile), 0o600);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules\n.ostrelio-you/\n');
  assert.match(result.start, new RegExp(`^\\(set -a; \\. .*connect\\.env; set \\+a; omp -e .*ostrelio\\.ts --config .*omp-config\\.yml --tools `));
  assert.equal(result.start.includes(KEY), false);
  // Running it again does not duplicate the ignore line.
  writeHarness({ harness: 'omp', dir, baseUrl: URL_, apiKey: KEY, packagesDir });
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules\n.ostrelio-you/\n');
});

test('mcp writes the gateway config and adds an ostrelio entry beside existing servers', () => {
  const dir = tmp();
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  const packagesDir = fakePackages();
  const upstreams = [parseUpstream('files=npx -y @modelcontextprotocol/server-filesystem .')];
  const result = writeHarness({ harness: 'mcp', dir, baseUrl: URL_, apiKey: KEY, upstreams, packagesDir });
  const config = json(join(dir, 'ostrelio.gateway.json'));
  assert.deepEqual(config.upstreams, [{ name: 'files', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }]);
  assert.equal(config.unmappedTools, 'deny');
  assert.deepEqual(config.agent, { externalKey: 'mcp-agent', name: 'MCP agent' });
  const client = json(join(dir, '.mcp.json'));
  assert.deepEqual(client.mcpServers.other, { command: 'x' });
  assert.deepEqual(client.mcpServers.ostrelio, {
    command: 'node',
    args: [join(packagesDir, 'gateway', 'dist', 'cli.js'), '--config', join(dir, 'ostrelio.gateway.json')],
    env: { OSTRELIO_API_KEY: KEY, OSTRELIO_BASE_URL: URL_ },
  });
  assert.equal(mode(join(dir, '.mcp.json')), 0o600);
  assert.equal(result.files.length, 2);
  assert.ok(result.notes.some((note) => /denied until you map/.test(note)));

  // An existing gateway config (with the person's mappings) is left alone.
  config.actions = [{ tool: 'files.delete_path', actionType: 'file.delete', resourceType: 'path' }];
  writeFileSync(join(dir, 'ostrelio.gateway.json'), JSON.stringify(config));
  writeHarness({ harness: 'mcp', dir, baseUrl: URL_, apiKey: KEY, upstreams, packagesDir });
  assert.equal(json(join(dir, 'ostrelio.gateway.json')).actions.length, 1);
});

test('mcp needs an upstream and a built gateway', () => {
  const packagesDir = fakePackages();
  assert.throws(() => writeHarness({ harness: 'mcp', dir: tmp(), baseUrl: URL_, apiKey: KEY, packagesDir }), /--upstream/);
  assert.throws(() => writeHarness({ harness: 'mcp', dir: tmp(), baseUrl: URL_, apiKey: KEY, upstreams: [parseUpstream('a=b')], packagesDir: tmp() }), /does not exist/);
});

test('policy pack: published when the workspace has none, left alone when it has them', async () => {
  const packagesDir = fakePackages();
  const calls: string[] = [];
  let listed: unknown[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const path = url.replace(URL_, '');
    calls.push(`${init.method} ${path}`);
    assert.equal((init.headers as Record<string, string>)['x-operator-api-key'], 'dev-operator-a');
    if (path === '/v1/policies' && init.method === 'GET') return Response.json({ policies: listed });
    if (path === '/v1/policies') return Response.json({ versions: [{ id: 'v1' }] }, { status: 201 });
    return Response.json({});
  }) as unknown as typeof fetch;

  assert.deepEqual(await installDefaultPolicies({ baseUrl: URL_, env: {}, fetchFn, packagesDir }), { status: 'installed', count: 2 });
  assert.equal(calls.filter((call) => call === 'POST /v1/policy-versions/v1/publish').length, 2);

  calls.length = 0;
  listed = [{ id: 'p', displayKey: 'POL-AGT-01', source: 'WORKSPACE' }];
  assert.deepEqual(await installDefaultPolicies({ baseUrl: URL_, env: {}, fetchFn, packagesDir }), { status: 'present' });
  assert.deepEqual(calls, ['GET /v1/policies']);
});

test('a hosted workspace needs an admin session for policies; the session wins over the operator key', () => {
  assert.equal(policyAuth('https://acme.example.com', {}), null);
  assert.deepEqual(policyAuth('https://acme.example.com', { OSTRELIO_SESSION: 's', OSTRELIO_CSRF: 'c' }), { 'x-reviewer-session': 's', 'x-csrf-token': 'c' });
  assert.deepEqual(policyAuth(URL_, { OSTRELIO_SESSION: 's' }), { 'x-reviewer-session': 's', 'x-csrf-token': '' });
});

function run(argv: string[], env: NodeJS.ProcessEnv, status = 200) {
  const out: string[] = [];
  const err: string[] = [];
  const seen: string[] = [];
  const fetchFn = (async (url: string) => {
    seen.push(url);
    return Response.json(url.includes('/v1/executions') ? { executions: [] } : { policies: [{ id: 'p', displayKey: 'POL-AGT-01', source: 'WORKSPACE' }] }, { status: url.includes('/v1/executions') ? status : 200 });
  }) as unknown as typeof fetch;
  return main(argv, env, { out: (line) => out.push(line), err: (line) => err.push(line), fetchFn }).then((code) => ({ code, out: out.join('\n'), err: err.join('\n'), seen }));
}

test('cli: connects claude-code end to end and never prints the key', async () => {
  const dir = tmp();
  const result = await run(['claude-code', '--dir', dir, '--url', `${URL_}/`], { OSTRELIO_API_KEY: KEY });
  assert.equal(result.code, 0, result.err);
  assert.equal(json(join(dir, '.claude', 'settings.local.json')).env.OSTRELIO_BASE_URL, URL_);
  assert.match(result.out, /Connected to http:\/\/127\.0\.0\.1:3100/);
  assert.match(result.out, /already in this workspace/);
  assert.match(result.out, /Start your agent:\n  claude --plugin-dir /);
  assert.equal((result.out + result.err).includes(KEY), false);
});

test('cli: explains a missing key, a rejected key and a bad harness', async () => {
  assert.match((await run(['omp'], {})).err, /No API key/);
  const rejected = await run(['omp', '--dir', tmp()], { OSTRELIO_API_KEY: KEY }, 401);
  assert.equal(rejected.code, 1);
  assert.match(rejected.err, /rejected the API key/);
  assert.match((await run(['vim'], { OSTRELIO_API_KEY: KEY })).err, /Choose a harness/);
});

test('parseUpstream splits the command and rejects bad names', () => {
  assert.deepEqual(parseUpstream('db=node server.mjs --x=1'), { name: 'db', command: 'node', args: ['server.mjs', '--x=1'] });
  assert.throws(() => parseUpstream('bad name=node x'), /name=command/);
  assert.throws(() => parseUpstream('nocommand'), /name=command/);
});
