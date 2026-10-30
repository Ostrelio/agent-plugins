// node --test --experimental-strip-types packages/claude-code-plugin/terminal.test.ts
// Live counts (status line), the Stop summary, the denial cache and held calls seen from a second terminal.
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleHook, type HookInput } from './src/hook.ts';
import { fileStore, memoryStore } from './src/session-store.ts';
import { statusLine } from './src/statusline.ts';

const cwd = '/work/app';
const env = { OSTRELIO_API_KEY: 'ost_test_x', OSTRELIO_BASE_URL: 'http://127.0.0.1:3100', OSTRELIO_DASHBOARD_URL: 'https://console.example.test', OSTRELIO_HOME: mkdtempSync(join(tmpdir(), 'ostrelio-home-')) };

const pre = (tool_name: string, tool_input: unknown, tool_use_id: string): HookInput => ({ hook_event_name: 'PreToolUse', session_id: 'sess-t', cwd, tool_name, tool_input, tool_use_id });

function install(decide: (path: string) => Record<string, unknown>) {
  const authorizeCalls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/authorize')) authorizeCalls.push(path);
    return new Response(JSON.stringify(path.endsWith('/authorize') ? decide(path) : path.startsWith('/v1/agent/approvals/') ? { status: 'APPROVED' } : { id: 'exec-9' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { authorizeCalls, restore: () => { globalThis.fetch = realFetch; } };
}

test('an identical denied call is answered from the session record, and Stop prints the summary with the timeline link', async () => {
  const store = memoryStore();
  const stderr = process.stderr.write.bind(process.stderr);
  const fake = install(() => ({ id: 'dec-x', decision: 'DENY', reason: 'Deleting outside the workspace.' }));
  try {
    await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-t', prompt: 'clean up' }, { env, store });
    const rm = { command: 'rm -rf ~/scratch' };
    const first = await handleHook(pre('Bash', rm, 'toolu_1'), { env, store }) as { hookSpecificOutput: { permissionDecisionReason: string } };
    const second = await handleHook(pre('Bash', rm, 'toolu_2'), { env, store }) as { hookSpecificOutput: { permissionDecisionReason: string } };
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /^Ostrelio blocked this call: bash: rm -rf ~\/scratch .*Why: Deleting outside the workspace\..*inside the workspace.*ask the person.*stop/);
    assert.match(second.hookSpecificOutput.permissionDecisionReason, /already blocked this identical call earlier in this session/);
    assert.equal(fake.authorizeCalls.length, 1, 'the repeat never reaches Ostrelio');

    const stop = await handleHook({ hook_event_name: 'Stop', session_id: 'sess-t' }, { env, store }) as { systemMessage: string };
    assert.match(stop.systemMessage, /Ostrelio session summary\n {2}0 allowed · 0 held · 1 denied · 1 repeated denied call answered locally\n {2}Timeline: https:\/\/console\.example\.test\/platform\/agents\/claude-code-agent\/sessions\/exec-9$/);

    // A new request starts a new run: counts for the run start over, the denial cache stays.
    await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-t', prompt: 'again' }, { env, store });
    assert.deepEqual(await handleHook({ hook_event_name: 'Stop', session_id: 'sess-t' }, { env, store }), {});
    const third = await handleHook(pre('Bash', rm, 'toolu_3'), { env, store }) as { hookSpecificOutput: { permissionDecisionReason: string } };
    assert.match(third.hookSpecificOutput.permissionDecisionReason, /already blocked/);
    assert.equal(fake.authorizeCalls.length, 1);
  } finally {
    fake.restore();
    process.stderr.write = stderr;
  }
});

test('a hold is recorded as waiting while it lasts, with the terminal command in the message', async () => {
  const store = memoryStore();
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const realFetch = globalThis.fetch;
  const written: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  globalThis.fetch = (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    let body: unknown = { id: 'exec-9' };
    if (path.endsWith('/authorize')) body = { id: 'dec-h', decision: 'REQUIRE_APPROVAL', reason: 'Outside the workspace.', approvalId: 'appr-77' };
    else if (path.startsWith('/v1/agent/approvals/')) { await released; body = { status: 'APPROVED' }; }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const held = handleHook(pre('Read', { file_path: '/etc/hosts' }, 'toolu_h'), { env, store });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const mid = await store.update('sess-t', (current) => ({ record: current, result: current.ledger }));
    assert.equal(mid.pending.length, 1);
    assert.equal(mid.pending[0]!.approvalId, 'appr-77');
    release();
    const output = await held as { hookSpecificOutput: { permissionDecision: string }; systemMessage: string };
    assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
    assert.match(output.systemMessage, /in this terminal: node --experimental-strip-types ".*cli\.ts" approve appr-77/);
    assert.match(written.join(''), /ostrelio login|cli\.ts" login/);
    const after = await store.update('sess-t', (current) => ({ record: current, result: current.ledger }));
    assert.equal(after.pending.length, 0);
    assert.equal(after.total.held, 1);
    assert.equal(after.total.approved, 1);
  } finally {
    globalThis.fetch = realFetch;
    process.stderr.write = realWrite;
  }
});

test('the status line prints the session counts and the last decision with its time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ostrelio-claude-'));
  const store = fileStore(root);
  const fake = install(() => ({ id: 'dec-a', decision: 'ALLOW', reason: 'ok' }));
  try {
    assert.match(await statusLine('sess-s', root), /^Ostrelio ✓ 0 allowed · ⏸ 0 held · ✗ 0 denied$/);
    await handleHook({ ...pre('Read', { file_path: 'README.md' }, 'toolu_s'), session_id: 'sess-s' }, { env, store });
    assert.match(await statusLine('sess-s', root), /^Ostrelio ✓ 1 allowed · ⏸ 0 held · ✗ 0 denied · last ✓ allowed read \(.+\) \d\d:\d\d:\d\d$/);
  } finally {
    fake.restore();
  }
});
