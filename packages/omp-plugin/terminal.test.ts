// node --test --experimental-strip-types packages/omp-plugin/terminal.test.ts
// The terminal side of the plugin: approve from a prompt, live counts, the end-of-run summary and the denial cache.
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveReviewerSession } from '../agent-guard/reviewer.ts';
import ostrelio from './ostrelio.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;
type Command = { handler: (args: string, ctx: unknown) => Promise<void> };
const cwd = '/work/app';

function load() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  ostrelio({ on: (name: string, handler: Handler) => { handlers.set(name, handler); }, registerCommand: (name: string, command: Command) => { commands.set(name, command); } } as never);
  return { handlers, commands };
}

/** A stand-in for Ostrelio: `decide` answers each authorize call; `requests` records everything the plugin sent. */
function fakeOstrelio(decide: (body: { idempotencyKey: string; actionType: string }) => Record<string, unknown>, status: () => string = () => 'PENDING') {
  const requests: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    requests.push({ method: init?.method ?? 'GET', path, headers: { ...(init?.headers as Record<string, string>) } });
    let body: unknown = { id: 'exec-1' };
    if (path.endsWith('/authorize')) body = decide(JSON.parse(String(init?.body)));
    else if (path.startsWith('/v1/agent/approvals/')) { await new Promise((resolve) => setTimeout(resolve, 10)); body = { status: status() }; }
    else if (path.startsWith('/v1/approvals/')) body = { status: 'APPROVED' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = realFetch; } };
}

function recorder() {
  const notes: string[] = [];
  const statuses: string[] = [];
  const prompts: Array<{ title: string; options: string[] }> = [];
  return {
    notes, statuses, prompts,
    ui: (answer?: string) => ({
      notify: (message: string) => notes.push(message),
      setStatus: (_key: string, text: string | undefined) => { if (text) statuses.push(text); },
      select: async (title: string, options: string[], dialog?: { signal?: AbortSignal }) => {
        prompts.push({ title, options });
        if (answer) return answer;
        await new Promise<void>((resolve) => dialog?.signal?.addEventListener('abort', () => resolve()));
        return undefined;
      },
    }),
  };
}

test('a held call opens an Approve prompt, and approving acts as the reviewer, never with the agent key', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ostrelio-home-'));
  process.env.OSTRELIO_HOME = home;
  process.env.OSTRELIO_API_KEY = 'ost_test_agentkey';
  process.env.OSTRELIO_BASE_URL = 'http://ostrelio.test';
  await saveReviewerSession({ baseUrl: 'http://ostrelio.test', email: 'owner@example.com', sessionToken: 'rev-session', csrfToken: 'rev-csrf', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  let approved = false;
  const fake = fakeOstrelio(() => ({ id: 'dec-1', decision: 'REQUIRE_APPROVAL', reason: 'Outside the workspace.', approvalId: 'appr-1' }), () => (approved ? 'APPROVED' : 'PENDING'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (new URL(String(url)).pathname === '/v1/approvals/appr-1/approve') approved = true;
    return originalFetch(url, init);
  }) as typeof fetch;
  const { handlers } = load();
  const screen = recorder();
  try {
    const result = await handlers.get('tool_call')!({ toolName: 'read', toolCallId: 't1', input: { path: '/etc/hosts' } }, { cwd, ui: screen.ui('Approve') });
    assert.equal(result, undefined);
    assert.equal(screen.prompts.length, 1);
    assert.match(screen.prompts[0]!.title, /holding read: \/etc\/hosts/);
    assert.deepEqual(screen.prompts[0]!.options, ['Approve', 'Reject', 'Decide in the dashboard']);
    const review = fake.requests.find((request) => request.path === '/v1/approvals/appr-1/approve')!;
    assert.equal(review.method, 'POST');
    assert.equal(review.headers['x-reviewer-session'], 'rev-session');
    assert.equal(review.headers['x-csrf-token'], 'rev-csrf');
    assert.equal(review.headers['x-api-key'], undefined, 'the agent key must never reach an approval route');
    assert.match(screen.notes.join('\n'), /approved read: \/etc\/hosts from this terminal/);
  } finally {
    fake.restore();
    for (const name of ['OSTRELIO_HOME', 'OSTRELIO_API_KEY', 'OSTRELIO_BASE_URL']) delete process.env[name];
  }
});

test('the prompt closes by itself when the call is decided in the dashboard first', async () => {
  process.env.OSTRELIO_HOME = mkdtempSync(join(tmpdir(), 'ostrelio-home-'));
  process.env.OSTRELIO_API_KEY = 'ost_test_agentkey';
  await saveReviewerSession({ baseUrl: 'http://127.0.0.1:3100', email: 'owner@example.com', sessionToken: 's', csrfToken: 'c', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  let polls = 0;
  const fake = fakeOstrelio(() => ({ id: 'dec-1', decision: 'REQUIRE_APPROVAL', reason: 'Held.', approvalId: 'appr-2' }), () => (++polls < 2 ? 'PENDING' : 'APPROVED'));
  const { handlers } = load();
  const screen = recorder();
  try {
    // The prompt is never answered; the dashboard approval ends the hold and aborts it.
    assert.equal(await handlers.get('tool_call')!({ toolName: 'read', toolCallId: 't1', input: { path: '/etc/hosts' } }, { cwd, ui: screen.ui() }), undefined);
    assert.equal(screen.prompts.length, 1);
    assert.equal(fake.requests.some((request) => request.path.endsWith('/approve')), false);
  } finally {
    fake.restore();
    delete process.env.OSTRELIO_HOME;
    delete process.env.OSTRELIO_API_KEY;
  }
});

test('without a reviewer login the person is told how to sign in, and no prompt opens', async () => {
  process.env.OSTRELIO_HOME = mkdtempSync(join(tmpdir(), 'ostrelio-home-'));
  process.env.OSTRELIO_API_KEY = 'ost_test_agentkey';
  let polls = 0;
  const fake = fakeOstrelio(() => ({ id: 'dec-1', decision: 'REQUIRE_APPROVAL', reason: 'Held.', approvalId: 'appr-3' }), () => (++polls < 2 ? 'PENDING' : 'APPROVED'));
  const { handlers } = load();
  const screen = recorder();
  try {
    await handlers.get('tool_call')!({ toolName: 'read', toolCallId: 't1', input: { path: '/etc/hosts' } }, { cwd, ui: screen.ui('Approve') });
    assert.equal(screen.prompts.length, 0);
    assert.match(screen.notes.join('\n'), /ostrelio login/);
    assert.match(screen.notes[0]!, /in this terminal: node --experimental-strip-types ".*cli\.ts" approve appr-3/);
  } finally {
    fake.restore();
    delete process.env.OSTRELIO_HOME;
    delete process.env.OSTRELIO_API_KEY;
  }
});

test('an identical denied call is answered locally, and the summary and status line say so', async () => {
  process.env.OSTRELIO_API_KEY = 'ost_test_agentkey';
  process.env.OSTRELIO_DASHBOARD_URL = 'https://console.example.test';
  const fake = fakeOstrelio((body) => (body.actionType === 'shell.exec' ? { id: 'dec-d', decision: 'DENY', reason: 'Deleting outside the workspace.' } : { id: 'dec-a', decision: 'ALLOW', reason: 'ok' }));
  const { handlers, commands } = load();
  const screen = recorder();
  const ctx = { cwd, ui: screen.ui() };
  try {
    await handlers.get('before_agent_start')!({ prompt: 'clean up' }, ctx);
    const rm = { command: 'rm -rf ~/scratch' };
    const first = await handlers.get('tool_call')!({ toolName: 'bash', toolCallId: 'a', input: rm }, ctx) as { reason: string };
    const second = await handlers.get('tool_call')!({ toolName: 'bash', toolCallId: 'b', input: rm }, ctx) as { reason: string };
    await handlers.get('tool_call')!({ toolName: 'read', toolCallId: 'c', input: { path: 'README.md' } }, ctx);
    assert.match(first.reason, /Ostrelio blocked this call: bash: rm -rf ~\/scratch .*Why: Deleting outside the workspace\..*inside the workspace.*ask the person.*stop/);
    assert.match(second.reason, /already blocked this identical call earlier in this session/);
    assert.equal(fake.requests.filter((request) => request.path.endsWith('/authorize')).length, 2, 'the repeat never reaches Ostrelio');
    assert.match(screen.statuses.at(-1)!, /^Ostrelio ✓ 1 allowed · ⏸ 0 held · ✗ 1 denied · ↺ 1 repeats · last ✓ allowed read \(.+\) \d\d:\d\d:\d\d$/);

    await handlers.get('agent_end')!({ isTerminal: false }, ctx);
    assert.equal(screen.notes.length, 0, 'a run that will continue gets no summary yet');
    await handlers.get('agent_end')!({ isTerminal: true }, ctx);
    assert.equal(screen.notes.length, 1);
    assert.match(screen.notes[0]!, /Ostrelio session summary\n {2}1 allowed · 0 held · 1 denied · 1 repeated denied call answered locally\n {2}Timeline: https:\/\/console\.example\.test\/platform\/agents\/omp-agent\/sessions\/exec-1$/);
    await handlers.get('agent_end')!({ isTerminal: true }, ctx);
    assert.equal(screen.notes.length, 1, 'one summary per run');

    await commands.get('ostrelio')!.handler('status', ctx);
    assert.match(screen.notes.at(-1)!, /^Ostrelio ✓ 1 allowed/);
  } finally {
    fake.restore();
    delete process.env.OSTRELIO_API_KEY;
    delete process.env.OSTRELIO_DASHBOARD_URL;
  }
});

test('a run with no calls prints no summary, and a held call shows as still waiting', async () => {
  process.env.OSTRELIO_API_KEY = 'ost_test_agentkey';
  process.env.OSTRELIO_APPROVAL_TIMEOUT_SECONDS = '1';
  process.env.OSTRELIO_HOME = mkdtempSync(join(tmpdir(), 'ostrelio-home-'));
  const fake = fakeOstrelio(() => ({ id: 'dec-1', decision: 'REQUIRE_APPROVAL', reason: 'Held.', approvalId: 'appr-4' }));
  const { handlers, commands } = load();
  const screen = recorder();
  const ctx = { cwd, ui: screen.ui() };
  try {
    await handlers.get('agent_end')!({ isTerminal: true }, ctx);
    assert.equal(screen.notes.length, 0);
    const call = handlers.get('tool_call')!({ toolName: 'read', toolCallId: 'h', input: { path: '/etc/hosts' } }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await commands.get('ostrelio')!.handler('status', ctx);
    assert.match(screen.notes.at(-1)!, /waiting for approval: read: \/etc\/hosts[\s\S]*waiting: read: \/etc\/hosts \(appr-4\)/);
    const result = await call as { reason: string };
    assert.match(result.reason, /nobody approved it in time/);
    assert.match(result.reason, /Do not retry it.*ask the person/);
  } finally {
    fake.restore();
    for (const name of ['OSTRELIO_API_KEY', 'OSTRELIO_APPROVAL_TIMEOUT_SECONDS', 'OSTRELIO_HOME']) delete process.env[name];
  }
});

test('in print mode (hasUI false) the summary and hold messages go to stderr, not to a ui that shows nothing', async () => {
  process.env.OSTRELIO_API_KEY = 'ost_test_agentkey';
  const fake = fakeOstrelio(() => ({ id: 'dec-a', decision: 'ALLOW', reason: 'ok' }));
  const { handlers } = load();
  const hidden: string[] = [];
  const ctx = { cwd, hasUI: false, ui: { notify: (message: string) => hidden.push(message), setStatus: () => undefined } };
  const written: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await handlers.get('tool_call')!({ toolName: 'read', toolCallId: 'p', input: { path: 'README.md' } }, ctx);
    await handlers.get('agent_end')!({ isTerminal: true }, ctx);
  } finally {
    process.stderr.write = realWrite;
    fake.restore();
    delete process.env.OSTRELIO_API_KEY;
  }
  assert.equal(hidden.length, 0);
  assert.match(written.join(''), /Ostrelio session summary\n {2}1 allowed/);
});
