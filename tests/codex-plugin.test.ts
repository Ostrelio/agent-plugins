/**
 * The built Codex plugin (plugins/ostrelio-codex), checked the way Codex uses it: manifests on disk,
 * hook commands that resolve inside the plugin root, and the vendored hook run as a real process with
 * PLUGIN_ROOT and PLUGIN_DATA set, against a fake Control Plane.
 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { staleFiles } from '../scripts/build-codex-plugin.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PLUGIN = join(ROOT, 'plugins', 'ostrelio-codex');
const read = (path: string) => JSON.parse(readFileSync(join(PLUGIN, path), 'utf8'));

test('the committed plugin matches a fresh build of packages/', () => {
  assert.deepEqual(staleFiles(), []);
});

test('manifests carry the fields Codex needs and point at files that exist', () => {
  const manifest = read('plugin.json');
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  for (const field of ['version', 'description']) assert.ok(manifest[field], field);
  assert.ok(manifest.author.name);
  const openai = manifest.extensions['com.openai'];
  assert.ok(existsSync(join(PLUGIN, openai.hooks)));
  assert.ok(openai.interface.displayName.length <= 30 && openai.interface.shortDescription.length <= 30);
  const legacy = read('.codex-plugin/plugin.json');
  assert.equal(legacy.name, manifest.name);
  assert.ok(existsSync(join(PLUGIN, legacy.skills, 'ostrelio', 'SKILL.md')));

  const marketplace = JSON.parse(readFileSync(join(ROOT, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  const entry = marketplace.plugins.find((plugin: { name: string }) => plugin.name === manifest.name);
  assert.ok(entry && entry.policy.installation && entry.policy.authentication && entry.category);
  assert.equal(resolve(ROOT, entry.source.path), PLUGIN);
});

test('every hook command runs the vendored hook through ${PLUGIN_ROOT}', () => {
  const { hooks } = read('hooks/hooks.json');
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreToolUse', 'UserPromptSubmit']);
  for (const groups of Object.values(hooks) as Array<Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>) {
    for (const entry of groups.flatMap((group) => group.hooks)) {
      assert.equal(entry.type, 'command');
      const [, path] = entry.command.match(/^node --experimental-strip-types "\$\{PLUGIN_ROOT\}\/([^"]+)"$/) ?? [];
      assert.ok(path && existsSync(join(PLUGIN, path)), entry.command);
    }
  }
  assert.equal(hooks.PreToolUse[0].hooks[0].timeout, 3600);
});

// A fake Control Plane on a real port: the spawned hook talks to it over HTTP.
let server: Server;
let baseUrl = '';
const authorized: Array<Record<string, unknown>> = [];
before(async () => {
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      let body: unknown = { id: 'exec-1' };
      if (request.url?.endsWith('/authorize')) {
        const proposal = JSON.parse(raw) as Record<string, unknown>;
        authorized.push(proposal);
        body = raw.includes('rm -rf') || proposal.actionType === 'agent.tamper'
          ? { id: 'dec-no', decision: 'DENY', reason: 'Recursively deleting files outside the workspace is not allowed.' }
          : { id: 'dec-ok', decision: 'ALLOW', reason: 'Allowed.' };
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** Runs the built hook exactly as hooks.json does, with ${PLUGIN_ROOT} expanded. */
function runHook(input: Record<string, unknown>, data: string): Promise<{ code: number | null; stdout: string }> {
  const { hooks } = read('hooks/hooks.json');
  const command: string = hooks.PreToolUse[0].hooks[0].command.replace('${PLUGIN_ROOT}', PLUGIN);
  const script = command.match(/"([^"]+)"$/)![1]!;
  const child = spawn(process.execPath, ['--experimental-strip-types', script], {
    env: { PATH: process.env.PATH, HOME: data, PLUGIN_ROOT: PLUGIN, PLUGIN_DATA: data, OSTRELIO_API_KEY: 'ost_test_x', OSTRELIO_BASE_URL: baseUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stdin.end(JSON.stringify(input));
  return new Promise((done) => child.on('close', (code) => done({ code, stdout })));
}

test('the installed hook allows a workspace listing and blocks rm -rf outside it', async () => {
  const data = mkdtempSync(join(tmpdir(), 'ostrelio-plugin-data-'));
  try {
    const base = { hook_event_name: 'PreToolUse', session_id: 's1', cwd: data, tool_name: 'Bash' };
    const allowed = await runHook({ ...base, tool_use_id: 'c1', tool_input: { command: 'ls -la' } }, data);
    assert.equal(allowed.code, 0);
    assert.equal(allowed.stdout, '');

    const denied = await runHook({ ...base, tool_use_id: 'c2', tool_input: { command: 'rm -rf /tmp/outside' } }, data);
    assert.equal(denied.code, 0);
    const answer = JSON.parse(denied.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(answer.hookSpecificOutput.permissionDecisionReason, /Ostrelio blocked this call: bash: rm -rf \/tmp\/outside/);
    assert.ok(existsSync(join(data, 'sessions')), 'session state is kept in PLUGIN_DATA');
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('editing the installed plugin is sent as agent.tamper', async () => {
  const data = mkdtempSync(join(tmpdir(), 'ostrelio-plugin-data-'));
  try {
    const target = join(PLUGIN, 'hooks', 'hooks.json');
    await runHook({ hook_event_name: 'PreToolUse', session_id: 's2', cwd: data, tool_name: 'apply_patch', tool_use_id: 'c3',
      tool_input: { command: `*** Begin Patch\n*** Update File: ${target}\n@@\n-a\n+b\n*** End Patch` } }, data);
    assert.equal(authorized.at(-1)!.actionType, 'agent.tamper');
  } finally { rmSync(data, { recursive: true, force: true }); }
});
