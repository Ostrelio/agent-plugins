import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../Backend/src/app.js';
import { createApiKey } from '../../../Backend/src/db/api-key-repository.js';
import { provisionReviewer } from '../../../Backend/src/db/reviewer-auth-repository.js';
import { testReviewerClientFactory } from '../../../Backend/test/helpers/reviewer-clients.js';
import { createTestDatabase, type TestDatabase } from '../../../Backend/test/helpers/test-database.js';
import { Ostrelio } from '@ostrelio/sdk';
import type { ActionMapping, GatewayConfig } from '../src/config.js';
import { baseConfig, connectGateway, createLog, textOf, type Connected } from './helpers/harness.js';

const PASSWORD = 'correct-password-at-least-16';
const TENANT = 'tenant-gateway';
const AGENT_KEY = 'mcp-gateway-test';
type App = Awaited<ReturnType<typeof buildApp>>;
const BACKEND_DIR = fileURLToPath(new URL('../../../Backend', import.meta.url));

const actions: ActionMapping[] = [
  {
    tool: 'fake.create_refund', actionType: 'refund.create', resourceType: 'charge',
    map: { resourceId: '$.charge', 'context.amount': '$.amount', 'context.currency': '$.currency', 'context.customerId': '$.customer' },
  },
  {
    tool: 'fake.update_payout_destination', actionType: 'vendor.payout_destination.update', resourceType: 'payout_destination',
    map: { resourceId: '$.vendor', 'context.vendorId': '$.vendor', 'context.destination': '$.destination' },
  },
  {
    tool: 'fake.send_payment', actionType: 'payment.send', resourceType: 'payment',
    map: { resourceId: '$.invoice', 'context.vendorId': '$.vendor', 'context.amount': '$.amount', 'context.currency': '$.currency' },
  },
];

const refund = (charge: string, amount = 1_000) => ({ charge, amount, currency: 'USD', customer: 'sara' });
const payout = (vendor: string) => ({ vendor, destination: 'bank-1' });
const payment = (vendor: string, invoice: string) => ({ vendor, invoice, amount: 10_000, currency: 'USD' });
const approvalIdOf = (text: string) => /Approval id ([0-9a-f-]{36})\./.exec(text)?.[1] ?? '';

describe('gateway against the real backend', () => {
  let db: TestDatabase;
  let app: App;
  let operator: Record<string, string>;
  let apiKey: string;
  let baseUrl: string;
  let ostrelio: Ostrelio;
  let log: Awaited<ReturnType<typeof createLog>>;
  const open: Connected[] = [];

  const originalCwd = process.cwd();
  beforeAll(() => { process.chdir(BACKEND_DIR); });
  afterAll(() => { process.chdir(originalCwd); });

  beforeEach(async () => {
    log = await createLog();
    db = await createTestDatabase();
    const { reviewer } = await provisionReviewer(db, 'owner@example.com', PASSWORD, { role: 'BOUNDARY_ADMIN', tenantId: TENANT });
    app = await buildApp({
      reviewerClientFactory: testReviewerClientFactory, database: db, hostedMode: true, apiKeys: new Map(), rateLimit: false,
    });
    const session = (await app.inject({
      method: 'POST', url: '/v1/reviewer/session', payload: { email: 'owner@example.com', password: PASSWORD },
    })).json();
    operator = { 'x-reviewer-session': session.sessionToken, 'x-csrf-token': session.csrfToken };
    apiKey = (await createApiKey(db, {
      tenantId: TENANT, name: 'gateway integration', environment: 'test', createdBy: reviewer.id,
      actor: { type: 'ACCOUNT', id: reviewer.id },
    })).key;
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    ostrelio = new Ostrelio({ apiKey, baseUrl });
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((c) => c.close()));
    await app.close();
    await db.close();
    await log.cleanup();
  });

  const gateway = async (overrides: Partial<GatewayConfig> = {}): Promise<Connected> => {
    const connected = await connectGateway({
      config: baseConfig(log.path, { actions, ...overrides }), client: ostrelio, logger: { info() {}, warn() {}, error() {} },
    });
    open.push(connected);
    return connected;
  };

  const agentId = async () => (await ostrelio.registerAgent({ externalKey: AGENT_KEY, name: 'Gateway Test' })).agentId;
  const transition = (id: string, verb: 'pause' | 'resume') =>
    app.inject({ method: 'POST', url: `/v1/agents/${id}/${verb}`, headers: operator });
  const review = (approvalId: string, verb: 'approve' | 'deny') => app.inject({
    method: 'POST', url: `/v1/approvals/${approvalId}/${verb}`, headers: operator, payload: { idempotencyKey: `${verb}-${approvalId}` },
  });
  const upstreamTools = async () => (await log.calls()).map((c) => c.tool);
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);

  /** Leaves the payout change recorded so the next send_payment needs approval. */
  const requireApproval = async (g: Connected, vendor: string, invoice: string) => {
    const changed = await g.call('fake.update_payout_destination', payout(vendor));
    expect(changed.isError).toBeUndefined();
    const result = await g.call('fake.send_payment', payment(vendor, invoice));
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/^Approval required: .+\. Approval id [0-9a-f-]{36}\. Ask a human to approve in the Ostrelio dashboard, then call this tool again with the same arguments\.$/);
    return approvalIdOf(text);
  };

  it('registers the agent as an mcp-gateway and allows a small refund, recording EXECUTED', async () => {
    const g = await gateway();
    const agents = await app.inject({ method: 'GET', url: '/v1/agents', headers: operator });
    expect(agents.statusCode).toBe(200);
    const listed = (agents.json().agents ?? agents.json()) as { externalKey: string; runtime: string; status: string }[];
    expect(listed.find((a) => a.externalKey === AGENT_KEY)).toMatchObject({ runtime: 'mcp-gateway', status: 'ACTIVE' });

    const result = await g.call('fake.create_refund', refund('ch_allow'));
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe('refunded ch_allow 1000 USD');
    expect(await log.calls()).toEqual([{ tool: 'create_refund', args: refund('ch_allow') }]);

    const decisions = await db.query<{ id: string; decision: string }>(
      "SELECT id, decision FROM decision_events WHERE action_type = 'refund.create' AND resource_id = 'ch_allow'");
    expect(decisions.rows).toHaveLength(1);
    expect(decisions.rows[0]!.decision).toBe('ALLOW');
    const outcomes = await db.query<{ outcome: string }>('SELECT outcome FROM action_outcomes WHERE decision_id = $1', [decisions.rows[0]!.id]);
    expect(outcomes.rows).toEqual([{ outcome: 'EXECUTED' }]);
  });

  it('requires approval, forwards after approval on retry, and never reuses a consumed approval', async () => {
    const g = await gateway();
    const approvalId = await requireApproval(g, 'v-approve', 'inv-1');
    expect(await upstreamTools()).toEqual(['update_payout_destination']);

    const approved = await review(approvalId, 'approve');
    expect(approved.statusCode).toBe(200);

    const retry = await g.call('fake.send_payment', payment('v-approve', 'inv-1'));
    expect(retry.isError).toBeUndefined();
    expect(textOf(retry)).toBe('paid inv-1 to v-approve');
    expect(await upstreamTools()).toEqual(['update_payout_destination', 'send_payment']);
    const approval = await db.query<{ status: string; decision_id: string }>('SELECT status, decision_id FROM approvals WHERE id = $1', [approvalId]);
    expect(approval.rows[0]!.status).toBe('CONSUMED');
    expect(await count('SELECT count(*) AS n FROM decision_events WHERE action_type = $1', ['payment.send'])).toBe(1);

    // An identical call after the final outcome is a new action: it needs a fresh decision, not the spent approval.
    const again = await g.call('fake.send_payment', payment('v-approve', 'inv-1'));
    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/^Approval required: /);
    expect(approvalIdOf(textOf(again))).not.toBe(approvalId);
    expect(await upstreamTools()).toEqual(['update_payout_destination', 'send_payment']);
    expect(await count('SELECT count(*) AS n FROM decision_events WHERE action_type = $1', ['payment.send'])).toBe(2);
  });

  it('keeps the same approval while a pending call is retried before anyone reviews it', async () => {
    const g = await gateway();
    const approvalId = await requireApproval(g, 'v-pending', 'inv-2');
    const again = await g.call('fake.send_payment', { invoice: 'inv-2', currency: 'USD', amount: 10_000, vendor: 'v-pending' });
    expect(approvalIdOf(textOf(again))).toBe(approvalId);
    expect(await count('SELECT count(*) AS n FROM decision_events WHERE action_type = $1', ['payment.send'])).toBe(1);
    expect(await upstreamTools()).toEqual(['update_payout_destination']);
  });

  it('refuses after a reviewer denies the approval, never forwarding', async () => {
    const g = await gateway();
    const approvalId = await requireApproval(g, 'v-deny', 'inv-3');
    expect((await review(approvalId, 'deny')).statusCode).toBe(200);

    const retry = await g.call('fake.send_payment', payment('v-deny', 'inv-3'));
    expect(retry.isError).toBe(true);
    expect(textOf(retry)).toBe(`A reviewer denied this action in Ostrelio (approval ${approvalId}). Do not retry it.`);
    expect(await upstreamTools()).toEqual(['update_payout_destination']);
    expect(await count("SELECT count(*) AS n FROM action_outcomes o JOIN decision_events d ON d.id = o.decision_id WHERE d.action_type = 'payment.send'")).toBe(0);
  });

  it('denies a refund over the hard maximum without forwarding or recording an outcome', async () => {
    const g = await gateway();
    const result = await g.call('fake.create_refund', refund('ch_huge', 250_001));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Denied by Ostrelio: .+/);
    expect(await log.calls()).toEqual([]);
    expect(await count('SELECT count(*) AS n FROM action_outcomes')).toBe(0);
    expect(await count("SELECT count(*) AS n FROM decision_events WHERE resource_id = 'ch_huge' AND decision = 'DENY'")).toBe(1);
  });

  it('refuses an unmapped tool under the default unmappedTools deny, without asking Ostrelio', async () => {
    const g = await gateway();
    const result = await g.call('fake.get_balance');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('unmappedTools is "deny"');
    expect(await log.calls()).toEqual([]);
    expect(await count('SELECT count(*) AS n FROM decision_events')).toBe(0);
  });

  it('survives an upstream crash: reports it, reconnects, and serves the next call', async () => {
    const g = await gateway({ unmappedTools: 'allow' });
    const crashed = await g.call('fake.crash');
    expect(crashed.isError).toBe(true);
    expect(textOf(crashed)).toMatch(/stopped|not running/);

    const next = await g.call('fake.create_refund', refund('ch_after_crash'));
    expect(next.isError).toBeUndefined();
    expect(textOf(next)).toBe('refunded ch_after_crash 1000 USD');
    expect((await log.calls()).map((c) => c.tool)).toEqual(['crash', 'create_refund']);
  });

  it('refuses mapped calls while the agent is paused and works again after resume', async () => {
    const g = await gateway();
    const id = await agentId();
    expect((await transition(id, 'pause')).statusCode).toBe(200);

    const paused = await g.call('fake.create_refund', refund('ch_paused'));
    expect(paused.isError).toBe(true);
    expect(textOf(paused)).toBe(`Agent "${AGENT_KEY}" is paused in Ostrelio, so the gateway refuses every action. Resume it in the Ostrelio dashboard.`);
    expect(await log.calls()).toEqual([]);

    expect((await transition(id, 'resume')).statusCode).toBe(200);
    const resumed = await g.call('fake.create_refund', refund('ch_resumed'));
    expect(resumed.isError).toBeUndefined();
    expect(await upstreamTools()).toEqual(['create_refund']);
  });

  it('starts while the agent is already paused, refuses calls, and recovers on resume', async () => {
    const id = await agentId();
    expect((await transition(id, 'pause')).statusCode).toBe(200);

    const g = await gateway();
    const refused = await g.call('fake.create_refund', refund('ch_startup_paused'));
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('is paused in Ostrelio');
    expect(await log.calls()).toEqual([]);

    expect((await transition(id, 'resume')).statusCode).toBe(200);
    const ok = await g.call('fake.create_refund', refund('ch_startup_resumed'));
    expect(ok.isError).toBeUndefined();
    expect(textOf(ok)).toBe('refunded ch_startup_resumed 1000 USD');
  });
});
