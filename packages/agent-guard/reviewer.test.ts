// node --test --experimental-strip-types packages/agent-guard/reviewer.test.ts
// Approving from the terminal is a reviewer session (`ostrelio login`), never the agent's API key.
import { strict as assert } from 'node:assert';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { toProposal } from './classify.ts';
import { main } from './cli.ts';
import { loadReviewerSession, loginReviewer, ReviewerClient, reviewerClient, saveReviewerSession } from './reviewer.ts';

const homeEnv = () => ({ OSTRELIO_HOME: mkdtempSync(join(tmpdir(), 'ostrelio-home-')) });

interface Seen { method: string; path: string; headers: Record<string, string>; body?: Record<string, unknown> }
function server(answer: (seen: Seen) => { status?: number; body: unknown }) {
  const seen: Seen[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const entry = { method: init?.method ?? 'GET', path: `${parsed.pathname}${parsed.search}`, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined };
    seen.push(entry);
    const reply = answer(entry);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = realFetch; } };
}

test('login stores an owner-only reviewer session and nothing else', async () => {
  const env = homeEnv();
  const api = server(() => ({ body: { reviewer: { email: 'owner@example.com' }, sessionToken: 'tok', csrfToken: 'csrf', expiresAt: new Date(Date.now() + 60_000).toISOString() } }));
  try {
    const session = await loginReviewer({ baseUrl: 'http://ostrelio.test/', email: 'owner@example.com', password: 'pw', env });
    assert.equal(session.baseUrl, 'http://ostrelio.test');
    assert.equal(api.seen[0]!.path, '/v1/reviewer/session');
    assert.equal(statSync(join(env.OSTRELIO_HOME, 'reviewer.json')).mode & 0o777, 0o600);
    assert.equal(statSync(env.OSTRELIO_HOME).mode & 0o777, 0o700);
    assert.equal((await loadReviewerSession(env))?.sessionToken, 'tok');
    // An expired session is no session.
    await saveReviewerSession({ ...session, expiresAt: new Date(Date.now() - 1000).toISOString() }, env);
    assert.equal(await loadReviewerSession(env), null);
  } finally {
    api.restore();
  }
});

test('the reviewer client sends the reviewer session and CSRF token, and never an API key', async () => {
  const api = server(() => ({ body: { status: 'APPROVED' } }));
  try {
    const client = new ReviewerClient({ baseUrl: 'http://ostrelio.test', email: 'owner@example.com', sessionToken: 'tok', csrfToken: 'csrf', expiresAt: '2999-01-01T00:00:00Z' });
    await client.review('appr-1', 'approve', 'omp');
    await client.review('appr-2', 'reject', 'omp', 'Not today.');
    const [approve, reject] = api.seen;
    assert.equal(approve!.path, '/v1/approvals/appr-1/approve');
    assert.equal(reject!.path, '/v1/approvals/appr-2/deny');
    assert.equal(reject!.body!.reason, 'Not today.');
    for (const request of api.seen) {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['x-reviewer-session'], 'tok');
      assert.equal(request.headers['x-csrf-token'], 'csrf');
      assert.equal(Object.keys(request.headers).some((name) => /api-key/i.test(name)), false);
    }
  } finally {
    api.restore();
  }
});

test('the agent API key alone cannot approve: with no reviewer login there is no way to approve', async () => {
  const env = { ...homeEnv(), OSTRELIO_API_KEY: 'ost_test_agentkey' };
  const api = server(() => ({ body: {} }));
  const errors: string[] = [];
  const realError = console.error;
  console.error = (message: string) => { errors.push(message); };
  try {
    assert.equal(await reviewerClient(env), null);
    assert.equal(await main(['approve', 'appr-1'], env), 1);
    assert.match(errors[0]!, /Not signed in.*the agent API key cannot approve/);
    assert.equal(api.seen.length, 0, 'nothing is sent without a reviewer session');
  } finally {
    api.restore();
    console.error = realError;
  }
});

test('ostrelio approve acts on the one held call, or the id prefix given, and says what it approved', async () => {
  const env = homeEnv();
  await saveReviewerSession({ baseUrl: 'http://ostrelio.test', email: 'owner@example.com', sessionToken: 'tok', csrfToken: 'csrf', expiresAt: '2999-01-01T00:00:00Z' }, env);
  const api = server((seen) => {
    if (seen.path.startsWith('/v1/approvals?')) return { body: { approvals: [{ id: 'aaaa-1111' }, { id: 'bbbb-2222' }] } };
    if (seen.method === 'GET') return { body: { expiresAt: 'x', decision: { actionType: 'file.write', resourceId: '/tmp/x', reason: 'Outside the workspace.' } } };
    return { body: { status: 'APPROVED' } };
  });
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (message: string) => { lines.push(message); };
  console.error = (message: string) => { lines.push(message); };
  try {
    assert.equal(await main(['approve'], env), 1, 'two are waiting, so it asks which');
    assert.match(lines.join('\n'), /2 calls are waiting; name one:\naaaa-1111 {2}file\.write \/tmp\/x/);
    lines.length = 0;
    assert.equal(await main(['approve', 'bbbb'], env), 0);
    assert.equal(lines[0], 'Approved file.write /tmp/x (bbbb-2222): APPROVED.');
    assert.equal(api.seen.at(-1)!.path, '/v1/approvals/bbbb-2222/approve');
    assert.equal(api.seen.at(-1)!.headers['x-reviewer-session'], 'tok');
    lines.length = 0;
    assert.equal(await main(['reject', 'aaaa', '--reason', 'Too risky'], env), 0);
    assert.equal(api.seen.at(-1)!.path, '/v1/approvals/aaaa-1111/deny');
    assert.equal(api.seen.at(-1)!.body!.reason, 'Too risky');
  } finally {
    api.restore();
    console.log = realLog;
    console.error = realError;
  }
});

test('an agent that runs the reviewer CLI is a tamper attempt, however it spells the command', () => {
  const cwd = '/work/app';
  for (const command of ['ostrelio approve appr-1', 'npx ostrelio approve appr-1', 'ostrelio login', 'cd x && ostrelio reject abc', 'node packages/agent-guard/cli.ts approve appr-1']) {
    assert.equal(toProposal('bash', { command }, cwd).actionType, 'agent.tamper', command);
  }
  assert.notEqual(toProposal('bash', { command: 'echo ostrelio is great' }, cwd).actionType, 'agent.tamper');
});
