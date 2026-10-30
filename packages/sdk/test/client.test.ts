import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCodes, Ostrelio, OstrelioApprovalExpired, OstrelioApprovalRejected, OstrelioApprovalTimeout,
  OstrelioDenied, OstrelioError,
} from '../src/index.js';
import type { ApprovalState, Decision, Proposal } from '../src/index.js';

const BASE = 'http://api.test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read arbitrary JSON request bodies
interface Call { method: string; pathname: string; search: string; headers: Headers; body: any; signal: AbortSignal | null | undefined }
type Reply = Response | Error | ((call: Call, n: number) => Response | Promise<Response> | Error);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const errBody = (code: string, message: string, status: number, headers: Record<string, string> = {}) =>
  json({ error: { code, message } }, status, headers);

/** Fake fetch routed on `${method} ${pathname}`. A route may be a list; the last entry repeats. */
function makeFetch(routes: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.pathname}`;
    const call: Call = {
      method, pathname: url.pathname, search: url.search, headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, signal: init?.signal,
    };
    calls.push(call);
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    const route = routes[key];
    if (route === undefined) throw new Error(`unrouted ${key}`);
    const reply = Array.isArray(route) ? route[Math.min(n, route.length - 1)]! : route;
    const out = typeof reply === 'function' ? await reply(call, n) : reply;
    if (out instanceof Error) throw out;
    return out instanceof Response ? out.clone() : out;
  });
  return { fn: fn as unknown as typeof fetch, mock: fn, calls, count: (k: string) => counts.get(k) ?? 0 };
}

const client = (f: ReturnType<typeof makeFetch>, extra: Record<string, unknown> = {}) =>
  new Ostrelio({ apiKey: 'ost_test_abc_secret', baseUrl: BASE, fetch: f.fn, ...extra });

const proposal: Proposal = { actionType: 'payment.send', resourceType: 'payment', resourceId: 'inv-42' };

const event = (decision: Decision, over: Record<string, unknown> = {}) => ({
  id: 'dec-1', tenantId: 't', executionId: 'ex-1', idempotencyKey: 'k', actionType: 'payment.send',
  resourceType: 'payment', resourceId: 'inv-42', context: {}, decision, baseDecision: decision,
  matchedPolicyId: 'p', reasonCode: 'POLICY_MATCH', reason: 'because', approvalId: null,
  createdAt: '2026-01-01T00:00:00Z', ...over,
});
const approvalStatus = (status: ApprovalState) => ({
  approvalId: 'apr-1', decisionId: 'dec-1', status, expiresAt: '2026-01-02T00:00:00Z', reviewedAt: null,
});

const AUTH = 'POST /v1/executions/ex-1/actions/authorize';
const GET_APR = 'GET /v1/agent/approvals/apr-1';
const CONSUME = 'POST /v1/approvals/apr-1/consume';
const OUTCOME = 'POST /v1/decisions/dec-1/outcomes';

beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0); });
afterEach(() => { vi.restoreAllMocks(); });

describe('constructor', () => {
  it('throws without an apiKey', () => {
    expect(() => new Ostrelio({ apiKey: '' })).toThrow(TypeError);
    expect(() => new Ostrelio({} as never)).toThrow(/apiKey/);
  });

  it('strips trailing slashes from baseUrl', () => {
    expect(new Ostrelio({ apiKey: 'k', baseUrl: 'http://x.test///', fetch: vi.fn() as never }).baseUrl).toBe('http://x.test');
  });

  it('defaults baseUrl, timeout and maxAttempts', () => {
    const c = new Ostrelio({ apiKey: 'k', fetch: vi.fn() as never });
    expect(c.baseUrl).toBe('http://127.0.0.1:3100');
    expect(c.timeoutMs).toBe(30_000);
    expect(c.maxAttempts).toBe(3);
  });
});

describe('requests', () => {
  it('registerAgent posts with api key, json content-type and maps created', async () => {
    const f = makeFetch({
      'POST /v1/agents/register': [
        json({ agentId: 'a', displayKey: 'FIN-1', status: 'ACTIVE' }, 201),
        json({ agentId: 'a', displayKey: 'FIN-1', status: 'ACTIVE' }, 200),
      ],
    });
    const c = client(f);
    const input = { externalKey: 'pay', name: 'Pay', runtime: 'node' };
    const first = await c.registerAgent(input);
    const second = await c.registerAgent(input);
    expect(first).toEqual({ agentId: 'a', displayKey: 'FIN-1', status: 'ACTIVE', created: true });
    expect(second.created).toBe(false);
    const call = f.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.headers.get('x-api-key')).toBe('ost_test_abc_secret');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.body).toEqual(input);
  });

  it('startExecution posts to /v1/executions', async () => {
    const exec = { id: 'ex-1', status: 'ACTIVE' };
    const f = makeFetch({ 'POST /v1/executions': json(exec, 201) });
    const input = { agentId: 'pay', principalId: 'ops', objective: 'Pay' };
    expect(await client(f).startExecution(input)).toEqual(exec);
    expect(f.calls[0]!.body).toEqual(input);
    expect(f.calls[0]!.headers.get('x-api-key')).toBe('ost_test_abc_secret');
  });

  it('GET requests carry no content-type', async () => {
    const f = makeFetch({ [GET_APR]: json(approvalStatus('PENDING')) });
    await client(f).getApproval('apr-1');
    expect(f.calls[0]!.headers.get('content-type')).toBeNull();
    expect(f.calls[0]!.headers.get('x-api-key')).toBe('ost_test_abc_secret');
  });

  describe('authorize', () => {
    it('sends the bound fields, defaults context to {}, generates a UUID key', async () => {
      const f = makeFetch({ [AUTH]: json(event('ALLOW')) });
      const c = client(f);
      await c.authorize('ex-1', { ...proposal, extra: 'nope' } as Proposal);
      await c.authorize('ex-1', proposal);
      const [a, b] = f.calls.map((x) => x.body);
      expect(a).toEqual({ idempotencyKey: expect.stringMatching(UUID), ...proposal, context: {} });
      expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    });

    it('uses the caller key and context and url-encodes the execution id', async () => {
      const f = makeFetch({ 'POST /v1/executions/a%2Fb/actions/authorize': json(event('ALLOW')) });
      await client(f).authorize('a/b', { ...proposal, context: { amount: 5 } }, { idempotencyKey: 'mine' });
      expect(f.calls[0]!.body).toEqual({ idempotencyKey: 'mine', ...proposal, context: { amount: 5 } });
    });

    it('maps ALLOW without an approval', async () => {
      const ev = event('ALLOW');
      const r = await client(makeFetch({ [AUTH]: json(ev) })).authorize('ex-1', proposal);
      expect(r).toEqual({ decision: 'ALLOW', decisionId: 'dec-1', reason: 'because', reasonCode: 'POLICY_MATCH', event: ev });
      expect('approval' in r).toBe(false);
    });

    it('maps REQUIRE_APPROVAL with the approval id', async () => {
      const ev = event('REQUIRE_APPROVAL', { approvalId: 'apr-1' });
      const r = await client(makeFetch({ [AUTH]: json(ev) })).authorize('ex-1', proposal);
      expect(r.decision).toBe('REQUIRE_APPROVAL');
      expect(r.approval).toEqual({ approvalId: 'apr-1' });
      expect(r.event).toEqual(ev);
    });
  });

  describe('getApproval', () => {
    it.each([[undefined, 0], [0, 0], [10, 10], [30, 30], [99, 30], [-5, 0], [7.9, 7]])(
      'waitSeconds %s -> %s', async (input, expected) => {
        const f = makeFetch({ [GET_APR]: json(approvalStatus('PENDING')) });
        const c = client(f);
        await (input === undefined ? c.getApproval('apr-1') : c.getApproval('apr-1', { waitSeconds: input }));
        expect(f.calls[0]!.method).toBe('GET');
        expect(f.calls[0]!.search).toBe(`?waitSeconds=${expected}`);
      },
    );
  });

  describe('consumeApproval', () => {
    it('defaults the key and sends only the four bound fields', async () => {
      const f = makeFetch({ [CONSUME]: json({ id: 'apr-1', status: 'CONSUMED' }) });
      await client(f).consumeApproval('apr-1', { action: { ...proposal, extra: 1 } as Proposal });
      expect(f.calls[0]!.body).toEqual({
        idempotencyKey: 'consume:apr-1', action: { ...proposal, context: {} },
      });
      expect(Object.keys(f.calls[0]!.body.action).sort()).toEqual(['actionType', 'context', 'resourceId', 'resourceType']);
    });

    it('honors a caller key', async () => {
      const f = makeFetch({ [CONSUME]: json({ id: 'apr-1' }) });
      await client(f).consumeApproval('apr-1', { action: proposal, idempotencyKey: 'x' });
      expect(f.calls[0]!.body.idempotencyKey).toBe('x');
    });
  });

  describe('reportOutcome', () => {
    it('defaults the key, uses `outcome`, omits resultMetadata without detail', async () => {
      const f = makeFetch({ [OUTCOME]: json({ id: 'o' }, 201) });
      await client(f).reportOutcome('dec-1', { status: 'EXECUTED' });
      expect(f.calls[0]!.body).toEqual({ idempotencyKey: 'outcome:dec-1', outcome: 'EXECUTED' });
    });

    it('sends resultMetadata when detail is given', async () => {
      const f = makeFetch({ [OUTCOME]: json({ id: 'o' }, 201) });
      await client(f).reportOutcome('dec-1', { status: 'FAILED', detail: { error: 'x' }, idempotencyKey: 'k' });
      expect(f.calls[0]!.body).toEqual({ idempotencyKey: 'k', outcome: 'FAILED', resultMetadata: { error: 'x' } });
    });
  });
});

describe('error mapping', () => {
  it('maps a structured error body', async () => {
    const f = makeFetch({
      'POST /v1/executions': json({ error: { code: 'VALIDATION_ERROR', message: 'bad', requestId: 'req-9' } }, 400, { 'x-request-id': 'hdr' }),
    });
    const err = await client(f).startExecution({ agentId: 'a', principalId: 'p', objective: 'o' }).catch((e) => e);
    expect(err).toBeInstanceOf(OstrelioError);
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', status: 400, requestId: 'req-9', message: 'bad', name: 'OstrelioError' });
  });

  it('falls back to HTTP_<status> and the x-request-id header for non-JSON error bodies', async () => {
    const f = makeFetch({
      'POST /v1/executions': new Response('<html>oops</html>', { status: 418, headers: { 'x-request-id': 'hdr-1' } }),
    });
    const err = await client(f).startExecution({ agentId: 'a', principalId: 'p', objective: 'o' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'HTTP_418', status: 418, requestId: 'hdr-1' });
    expect(err.message).toContain('418');
  });

  it('uses the header request id when the body has none', async () => {
    const f = makeFetch({ 'POST /v1/executions': errBody('NOT_FOUND', 'nope', 404, { 'x-request-id': 'hdr-2' }) });
    const err = await client(f).startExecution({ agentId: 'a', principalId: 'p', objective: 'o' }).catch((e) => e);
    expect(err.requestId).toBe('hdr-2');
  });

  it('maps a 200 with a non-JSON body to INVALID_RESPONSE without retrying', async () => {
    const f = makeFetch({ [GET_APR]: new Response('not json', { status: 200, headers: { 'x-request-id': 'r' } }) });
    const err = await client(f).getApproval('apr-1').catch((e) => e);
    expect(err).toMatchObject({ code: ErrorCodes.INVALID_RESPONSE, status: 200, requestId: 'r' });
    expect(f.calls).toHaveLength(1);
  });
});

describe('retry policy', () => {
  const start = (c: Ostrelio) => c.startExecution({ agentId: 'a', principalId: 'p', objective: 'o' });
  const ROUTE = 'POST /v1/executions';

  it.each([503, 429])('retries %s up to 3 attempts then throws the last error', async (status) => {
    const f = makeFetch({
      [ROUTE]: (_c, n) => errBody('SERVICE_UNAVAILABLE', `fail ${n + 1}`, status),
    });
    const err = await start(client(f)).catch((e) => e);
    expect(f.count(ROUTE)).toBe(3);
    expect(err).toMatchObject({ status, message: 'fail 3' });
  });

  it('recovers when a retry succeeds', async () => {
    const f = makeFetch({ [ROUTE]: [errBody('SERVICE_UNAVAILABLE', 'x', 503), json({ id: 'ex-1' }, 201)] });
    expect(await start(client(f))).toEqual({ id: 'ex-1' });
    expect(f.count(ROUTE)).toBe(2);
  });

  it('respects maxAttempts', async () => {
    const f = makeFetch({ [ROUTE]: errBody('SERVICE_UNAVAILABLE', 'x', 503) });
    await expect(start(client(f, { maxAttempts: 5 }))).rejects.toBeInstanceOf(OstrelioError);
    expect(f.count(ROUTE)).toBe(5);

    const g = makeFetch({ [ROUTE]: errBody('SERVICE_UNAVAILABLE', 'x', 503) });
    await expect(start(client(g, { maxAttempts: 1 }))).rejects.toBeInstanceOf(OstrelioError);
    expect(g.count(ROUTE)).toBe(1);
  });

  it('clamps maxAttempts below 1 to a single attempt', async () => {
    const f = makeFetch({ [ROUTE]: errBody('SERVICE_UNAVAILABLE', 'x', 503) });
    await expect(start(client(f, { maxAttempts: 0 }))).rejects.toBeInstanceOf(OstrelioError);
    expect(f.count(ROUTE)).toBe(1);
  });

  it('retries network errors and surfaces NETWORK_ERROR with status 0', async () => {
    const cause = new TypeError('fetch failed');
    const f = makeFetch({ [ROUTE]: cause });
    const err = await start(client(f)).catch((e) => e);
    expect(f.count(ROUTE)).toBe(3);
    expect(err).toBeInstanceOf(OstrelioError);
    expect(err).toMatchObject({ code: ErrorCodes.NETWORK_ERROR, status: 0 });
    expect(err.message).toContain('fetch failed');
    expect(err.cause).toBe(cause);
  });

  it.each([400, 401, 403, 404, 409, 423, 500])('does not retry %s', async (status) => {
    const f = makeFetch({ [ROUTE]: errBody('X', 'nope', status) });
    const err = await start(client(f)).catch((e) => e);
    expect(err.status).toBe(status);
    expect(f.count(ROUTE)).toBe(1);
  });

  it('honors Retry-After (seconds) as the retry delay', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const f = makeFetch({
      [ROUTE]: [errBody('RATE_LIMITED', 'slow', 429, { 'retry-after': '0' }), json({ id: 'ex-1' }, 201)],
    });
    await start(client(f));
    expect(f.count(ROUTE)).toBe(2);
    expect(spy.mock.calls.some(([, ms]) => ms === 0)).toBe(true);
  });

  it('caps Retry-After at 10 seconds', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      queueMicrotask(fn);
      return 0 as never;
    }) as never);
    const f = makeFetch({
      [ROUTE]: [errBody('RATE_LIMITED', 'slow', 429, { 'retry-after': '3600' }), json({ id: 'ex-1' }, 201)],
    });
    await start(client(f));
    expect(spy.mock.calls.some(([, ms]) => ms === 10_000)).toBe(true);
  });

  it('does not retry when the caller signal aborts during the backoff wait', async () => {
    const ac = new AbortController();
    const f = makeFetch({
      [ROUTE]: () => { setTimeout(() => ac.abort(), 5); return errBody('RATE_LIMITED', 'slow', 429, { 'retry-after': '5' }); },
    });
    const err = await client(f).startExecution({ agentId: 'a', principalId: 'p', objective: 'o' }, { signal: ac.signal }).catch((e) => e);
    expect(err.code).toBe(ErrorCodes.REQUEST_ABORTED);
    expect(f.count(ROUTE)).toBe(1);
  });
});

describe('abort and timeout', () => {
  const abortable = (): Reply => (call) => new Promise<Response>((_, reject) => {
    const s = call.signal!;
    if (s.aborted) return reject(s.reason);
    s.addEventListener('abort', () => reject(s.reason), { once: true });
  }) as never;

  it('an already-aborted signal gives REQUEST_ABORTED with no retry', async () => {
    const f = makeFetch({ 'POST /v1/executions': abortable() });
    const ac = new AbortController();
    ac.abort();
    const err = await client(f).startExecution({ agentId: 'a', principalId: 'p', objective: 'o' }, { signal: ac.signal }).catch((e) => e);
    expect(err).toMatchObject({ code: ErrorCodes.REQUEST_ABORTED, status: 0 });
    expect(f.calls).toHaveLength(1);
  });

  it('aborting mid-flight gives REQUEST_ABORTED', async () => {
    const f = makeFetch({ [GET_APR]: abortable() });
    const ac = new AbortController();
    const p = client(f).getApproval('apr-1', { signal: ac.signal }).catch((e) => e);
    setTimeout(() => ac.abort(), 5);
    expect(await p).toMatchObject({ code: ErrorCodes.REQUEST_ABORTED });
    expect(f.calls).toHaveLength(1);
  });

  it('a request timeout gives REQUEST_TIMEOUT', async () => {
    const f = makeFetch({ 'POST /v1/executions': abortable() });
    const err = await client(f, { timeoutMs: 20, maxAttempts: 1 })
      .startExecution({ agentId: 'a', principalId: 'p', objective: 'o' }).catch((e) => e);
    expect(err).toMatchObject({ code: ErrorCodes.REQUEST_TIMEOUT, status: 0 });
  });
});

describe('waitForApproval', () => {
  it('loops while PENDING and returns the first non-PENDING status', async () => {
    const f = makeFetch({
      [GET_APR]: [json(approvalStatus('PENDING')), json(approvalStatus('PENDING')), json(approvalStatus('APPROVED'))],
    });
    const onPending = vi.fn();
    const status = await client(f).waitForApproval('apr-1', { timeoutMs: 60_000, onPending });
    expect(status.status).toBe('APPROVED');
    expect(f.count(GET_APR)).toBe(3);
    expect(onPending).toHaveBeenCalledTimes(2);
    expect(onPending).toHaveBeenCalledWith(expect.objectContaining({ status: 'PENDING' }));
  });

  it.each(['DENIED', 'EXPIRED', 'CONSUMED'] as const)('returns %s without throwing', async (s) => {
    const f = makeFetch({ [GET_APR]: json(approvalStatus(s)) });
    expect((await client(f).waitForApproval('apr-1')).status).toBe(s);
    expect(f.count(GET_APR)).toBe(1);
  });

  it('caps waitSeconds at 30 and uses the remaining time otherwise', async () => {
    const f = makeFetch({ [GET_APR]: json(approvalStatus('APPROVED')) });
    await client(f).waitForApproval('apr-1');
    expect(f.calls[0]!.search).toBe('?waitSeconds=30');
    await client(f).waitForApproval('apr-1', { timeoutMs: 5000 });
    expect(f.calls[1]!.search).toBe('?waitSeconds=5');
  });

  it('returns PENDING after timeoutMs elapses', async () => {
    const f = makeFetch({
      [GET_APR]: async () => { await new Promise((r) => setTimeout(r, 100)); return json(approvalStatus('PENDING')); },
    });
    const onPending = vi.fn();
    const t0 = Date.now();
    const status = await client(f).waitForApproval('apr-1', { timeoutMs: 1500, onPending });
    expect(status.status).toBe('PENDING');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
    for (const c of f.calls) {
      const w = Number(new URL(`${BASE}/x${c.search}`).searchParams.get('waitSeconds'));
      expect(w).toBeLessThanOrEqual(30);
    }
    expect(onPending).toHaveBeenCalled();
  }, 10_000);

  it('returns immediately with timeoutMs 0', async () => {
    const f = makeFetch({ [GET_APR]: json(approvalStatus('PENDING')) });
    const status = await client(f).waitForApproval('apr-1', { timeoutMs: 0 });
    expect(status.status).toBe('PENDING');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.search).toBe('?waitSeconds=0');
  });
});

describe('guard', () => {
  const allow = json(event('ALLOW'));
  const needsApproval = json(event('REQUIRE_APPROVAL', { approvalId: 'apr-1' }));
  const ok = json({ id: 'x' });

  it('ALLOW runs the callback once, reports EXECUTED, returns the value', async () => {
    const f = makeFetch({ [AUTH]: allow, [OUTCOME]: ok });
    const cb = vi.fn().mockResolvedValue('result');
    expect(await client(f).guard('ex-1', proposal, cb)).toBe('result');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]).toMatchObject({ decision: 'ALLOW', decisionId: 'dec-1' });
    expect(f.count(OUTCOME)).toBe(1);
    expect(f.calls.at(-1)!.body).toEqual({ idempotencyKey: 'outcome:dec-1', outcome: 'EXECUTED' });
    expect(f.count(CONSUME)).toBe(0);
  });

  it('accepts a synchronous callback', async () => {
    const f = makeFetch({ [AUTH]: allow, [OUTCOME]: ok });
    expect(await client(f).guard('ex-1', proposal, () => 42)).toBe(42);
  });

  it('DENY throws OstrelioDenied, skips the callback and reports nothing', async () => {
    const f = makeFetch({ [AUTH]: json(event('DENY', { reason: 'no way' })) });
    const cb = vi.fn();
    const err = await client(f).guard('ex-1', proposal, cb).catch((e) => e);
    expect(err).toBeInstanceOf(OstrelioDenied);
    expect(err).toBeInstanceOf(OstrelioError);
    expect(err.code).toBe(ErrorCodes.DENIED);
    expect(err.decision.decisionId).toBe('dec-1');
    expect(err.message).toContain('no way');
    expect(cb).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(1);
  });

  it('REQUIRE_APPROVAL then APPROVED consumes, runs, then reports EXECUTED', async () => {
    const order: string[] = [];
    const f = makeFetch({
      [AUTH]: needsApproval,
      [GET_APR]: json(approvalStatus('APPROVED')),
      [CONSUME]: () => { order.push('consume'); return json({ id: 'apr-1', status: 'CONSUMED' }); },
      [OUTCOME]: () => { order.push('outcome'); return ok; },
    });
    const onApprovalRequired = vi.fn();
    const cb = vi.fn(async () => { order.push('callback'); return 'done'; });
    const result = await client(f).guard('ex-1', { ...proposal, context: { a: 1 } }, cb, { onApprovalRequired });
    expect(result).toBe('done');
    expect(order).toEqual(['consume', 'callback', 'outcome']);
    expect(onApprovalRequired).toHaveBeenCalledTimes(1);
    expect(onApprovalRequired.mock.calls[0]![0]).toMatchObject({ decision: 'REQUIRE_APPROVAL', approval: { approvalId: 'apr-1' } });
    const consume = f.calls.find((c) => c.pathname === '/v1/approvals/apr-1/consume')!;
    expect(consume.body.action).toEqual({ ...proposal, context: { a: 1 } });
  });

  it('polls while pending, forwarding onPending', async () => {
    const f = makeFetch({
      [AUTH]: needsApproval,
      [GET_APR]: [json(approvalStatus('PENDING')), json(approvalStatus('APPROVED'))],
      [CONSUME]: ok, [OUTCOME]: ok,
    });
    const onPending = vi.fn();
    await client(f).guard('ex-1', proposal, () => 1, { onPending });
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(f.count(GET_APR)).toBe(2);
  });

  it('REQUIRE_APPROVAL + DENIED throws OstrelioApprovalRejected', async () => {
    const f = makeFetch({ [AUTH]: needsApproval, [GET_APR]: json(approvalStatus('DENIED')) });
    const cb = vi.fn();
    const err = await client(f).guard('ex-1', proposal, cb).catch((e) => e);
    expect(err).toBeInstanceOf(OstrelioApprovalRejected);
    expect(err.code).toBe(ErrorCodes.APPROVAL_REJECTED);
    expect(err.approval.status).toBe('DENIED');
    expect(cb).not.toHaveBeenCalled();
    expect(f.count(CONSUME)).toBe(0);
    expect(f.count(OUTCOME)).toBe(0);
  });

  it('REQUIRE_APPROVAL + EXPIRED throws OstrelioApprovalExpired', async () => {
    const f = makeFetch({ [AUTH]: needsApproval, [GET_APR]: json(approvalStatus('EXPIRED')) });
    const cb = vi.fn();
    const err = await client(f).guard('ex-1', proposal, cb).catch((e) => e);
    expect(err).toBeInstanceOf(OstrelioApprovalExpired);
    expect(err.code).toBe(ErrorCodes.APPROVAL_EXPIRED);
    expect(cb).not.toHaveBeenCalled();
  });

  it('consume returning 409 APPROVAL_EXPIRED throws OstrelioApprovalExpired with the cause', async () => {
    const f = makeFetch({
      [AUTH]: needsApproval, [GET_APR]: json(approvalStatus('APPROVED')),
      [CONSUME]: errBody('APPROVAL_EXPIRED', 'expired', 409),
    });
    const cb = vi.fn();
    const err = await client(f).guard('ex-1', proposal, cb).catch((e) => e);
    expect(err).toBeInstanceOf(OstrelioApprovalExpired);
    expect((err.cause as OstrelioError).status).toBe(409);
    expect(cb).not.toHaveBeenCalled();
    expect(f.count(CONSUME)).toBe(1);
  });

  it('other consume errors propagate unchanged', async () => {
    const f = makeFetch({
      [AUTH]: needsApproval, [GET_APR]: json(approvalStatus('APPROVED')),
      [CONSUME]: errBody('APPROVAL_BINDING_MISMATCH', 'different action', 409),
    });
    const cb = vi.fn();
    const err = await client(f).guard('ex-1', proposal, cb).catch((e) => e);
    expect(err).toMatchObject({ code: 'APPROVAL_BINDING_MISMATCH' });
    expect(err).not.toBeInstanceOf(OstrelioApprovalExpired);
    expect(cb).not.toHaveBeenCalled();
  });

  it('still PENDING at approvalTimeoutMs throws OstrelioApprovalTimeout', async () => {
    const f = makeFetch({
      [AUTH]: needsApproval,
      [GET_APR]: async () => { await new Promise((r) => setTimeout(r, 100)); return json(approvalStatus('PENDING')); },
    });
    const cb = vi.fn();
    const err = await client(f).guard('ex-1', proposal, cb, { approvalTimeoutMs: 1200 }).catch((e) => e);
    expect(err).toBeInstanceOf(OstrelioApprovalTimeout);
    expect(err.code).toBe(ErrorCodes.APPROVAL_WAIT_TIMEOUT);
    expect(err.approval.status).toBe('PENDING');
    expect(cb).not.toHaveBeenCalled();
    expect(f.count(CONSUME)).toBe(0);
  }, 10_000);

  it('callback throwing reports FAILED with detail.error and rethrows the original error', async () => {
    const f = makeFetch({ [AUTH]: allow, [OUTCOME]: ok });
    const boom = new Error('kaboom');
    const err = await client(f).guard('ex-1', proposal, () => { throw boom; }).catch((e) => e);
    expect(err).toBe(boom);
    expect(f.calls.at(-1)!.body).toEqual({
      idempotencyKey: 'outcome:dec-1', outcome: 'FAILED', resultMetadata: { error: 'kaboom' },
    });
    expect(f.count(OUTCOME)).toBe(1);
  });

  it('stringifies non-Error throws in the FAILED detail', async () => {
    const f = makeFetch({ [AUTH]: allow, [OUTCOME]: ok });
    const err = await client(f).guard('ex-1', proposal, () => { throw 'plain'; }).catch((e) => e);
    expect(err).toBe('plain');
    expect(f.calls.at(-1)!.body.resultMetadata).toEqual({ error: 'plain' });
  });

  it('rethrows the callback error even when reporting FAILED fails', async () => {
    const f = makeFetch({ [AUTH]: allow, [OUTCOME]: errBody('OUTCOME_CONFLICT', 'x', 409) });
    const boom = new Error('kaboom');
    await expect(client(f).guard('ex-1', proposal, () => { throw boom; })).rejects.toBe(boom);
  });

  it('a failing EXECUTED report still returns the result and calls onOutcomeError', async () => {
    const f = makeFetch({ [AUTH]: allow, [OUTCOME]: errBody('INTERNAL_ERROR', 'boom', 500) });
    const onOutcomeError = vi.fn();
    const result = await client(f).guard('ex-1', proposal, () => 'value', { onOutcomeError });
    expect(result).toBe('value');
    expect(onOutcomeError).toHaveBeenCalledTimes(1);
    expect(onOutcomeError.mock.calls[0]![0]).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('treats OUTCOME_CONFLICT on EXECUTED as already recorded by the platform', async () => {
    const f = makeFetch({ [AUTH]: allow, [OUTCOME]: errBody('OUTCOME_CONFLICT', 'dup', 409) });
    const onOutcomeError = vi.fn();
    expect(await client(f).guard('ex-1', proposal, () => 'v', { onOutcomeError })).toBe('v');
    expect(onOutcomeError).not.toHaveBeenCalled();
  });

  it('runs the callback when the platform already consumed the approval', async () => {
    const f = makeFetch({ [AUTH]: needsApproval, [GET_APR]: json(approvalStatus('CONSUMED')), [OUTCOME]: ok });
    const cb = vi.fn(() => 'done');
    expect(await client(f).guard('ex-1', proposal, cb)).toBe('done');
    expect(f.count(CONSUME)).toBe(0);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('runs the callback when consume loses the race with APPROVAL_ALREADY_CONSUMED', async () => {
    const f = makeFetch({
      [AUTH]: needsApproval, [GET_APR]: json(approvalStatus('APPROVED')),
      [CONSUME]: errBody('APPROVAL_ALREADY_CONSUMED', 'used', 409), [OUTCOME]: ok,
    });
    const cb = vi.fn(() => 'done');
    expect(await client(f).guard('ex-1', proposal, cb)).toBe('done');
    expect(f.count(CONSUME)).toBe(1);
  });

  it('defaults onOutcomeError to console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const f = makeFetch({ [AUTH]: allow, [OUTCOME]: errBody('INTERNAL_ERROR', 'boom', 500) });
    expect(await client(f).guard('ex-1', proposal, () => 'v')).toBe('v');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sends the idempotencyKey option to authorize, or a UUID by default', async () => {
    const f = makeFetch({ [AUTH]: allow, [OUTCOME]: ok });
    const c = client(f);
    await c.guard('ex-1', proposal, () => 1, { idempotencyKey: 'stable' });
    await c.guard('ex-1', proposal, () => 1);
    const keys = f.calls.filter((x) => x.pathname.endsWith('/authorize')).map((x) => x.body.idempotencyKey);
    expect(keys[0]).toBe('stable');
    expect(keys[1]).toMatch(UUID);
  });

  it('REQUIRE_APPROVAL without an approvalId throws INVALID_RESPONSE', async () => {
    const f = makeFetch({ [AUTH]: json(event('REQUIRE_APPROVAL')) });
    const cb = vi.fn();
    const err = await client(f).guard('ex-1', proposal, cb).catch((e) => e);
    expect(err).toMatchObject({ code: ErrorCodes.INVALID_RESPONSE });
    expect(cb).not.toHaveBeenCalled();
  });

  it('passes the abort signal through to every request', async () => {
    const ac = new AbortController();
    const f = makeFetch({
      [AUTH]: needsApproval, [GET_APR]: json(approvalStatus('APPROVED')), [CONSUME]: ok, [OUTCOME]: ok,
    });
    await client(f).guard('ex-1', proposal, () => 1, { signal: ac.signal });
    ac.abort();
    // authorize, poll and consume derive from the caller signal; the outcome report does not.
    expect(f.calls.length).toBeGreaterThanOrEqual(3);
    expect(f.calls.slice(0, 3).every((c) => c.signal?.aborted)).toBe(true);
  });
});
