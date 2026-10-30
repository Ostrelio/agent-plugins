import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../../Backend/src/app.js';
import { createApiKey } from '../../../Backend/src/db/api-key-repository.js';
import { provisionReviewer } from '../../../Backend/src/db/reviewer-auth-repository.js';
import { testReviewerClientFactory } from '../../../Backend/test/helpers/reviewer-clients.js';
import { createTestDatabase, type TestDatabase } from '../../../Backend/test/helpers/test-database.js';
import {
  Ostrelio, OstrelioApprovalRejected, OstrelioDenied, OstrelioError,
  type AuthorizeResult, type Execution, type Proposal,
} from '../src/index.js';

const PASSWORD = 'correct-password-at-least-16';
const TENANT = 'tenant-sdk';
type App = Awaited<ReturnType<typeof buildApp>>;
const BACKEND_DIR = fileURLToPath(new URL('../../../Backend', import.meta.url));

describe('SDK against the real backend over HTTP', () => {
  let db: TestDatabase;
  let app: App;
  let baseUrl: string;
  let operator: Record<string, string>;
  let ostrelio: Ostrelio;
  let apiKey: string;

  // Backend migrations resolve `./migrations` against the working directory.
  const originalCwd = process.cwd();
  beforeAll(() => { process.chdir(BACKEND_DIR); });
  afterAll(() => { process.chdir(originalCwd); });

  beforeEach(async () => {
    db = await createTestDatabase();
    const { reviewer } = await provisionReviewer(db, 'owner@example.com', PASSWORD, { role: 'BOUNDARY_ADMIN', tenantId: TENANT });
    app = await buildApp({
      reviewerClientFactory: testReviewerClientFactory,
      database: db,
      hostedMode: true,
      apiKeys: new Map(),
      rateLimit: false,
    });
    const session = (await app.inject({
      method: 'POST', url: '/v1/reviewer/session', payload: { email: 'owner@example.com', password: PASSWORD },
    })).json();
    operator = { 'x-reviewer-session': session.sessionToken, 'x-csrf-token': session.csrfToken };
    // The workspace row was created by provisionReviewer, so a key can be minted straight from the repository.
    apiKey = (await createApiKey(db, {
      tenantId: TENANT, name: 'sdk integration', environment: 'test', createdBy: reviewer.id,
      actor: { type: 'ACCOUNT', id: reviewer.id },
    })).key;
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    ostrelio = new Ostrelio({ apiKey, baseUrl });
  });

  afterEach(async () => { await app.close(); await db.close(); });

  const start = async (externalKey = 'payments-agent') => {
    const agent = await ostrelio.registerAgent({ externalKey, name: 'Payments Agent', runtime: 'node' });
    const execution = await ostrelio.startExecution({
      agentId: externalKey, principalId: 'finance-manager', objective: 'Pay a verified vendor.',
    });
    return { agent, execution };
  };

  const lowRefund = (resourceId: string): Proposal => ({
    actionType: 'refund.create', resourceType: 'charge', resourceId, context: { amount: 1_000, currency: 'USD', customerId: 'sara' },
  });

  /** Records a payout change so the following `payment.send` needs approval. */
  const needApproval = async (execution: Execution, suffix: string): Promise<Proposal> => {
    await ostrelio.authorize(execution.id, {
      actionType: 'vendor.payout_destination.update', resourceType: 'payout_destination', resourceId: `${suffix}-destination`,
      context: { vendorId: suffix, destination: 'bank-1' },
    });
    return {
      actionType: 'payment.send', resourceType: 'payment', resourceId: `${suffix}-payment`,
      context: { vendorId: suffix, amount: 10_000, currency: 'USD' },
    };
  };

  const review = (approvalId: string, verb: 'approve' | 'deny') => app.inject({
    method: 'POST', url: `/v1/approvals/${approvalId}/${verb}`, headers: operator, payload: { idempotencyKey: `${verb}-${approvalId}` },
  });

  const outcomes = async (decisionId: string) =>
    (await db.query<{ outcome: string }>('SELECT outcome FROM action_outcomes WHERE decision_id = $1', [decisionId])).rows;

  it('registers an agent (201 then 200) and starts an execution for its external key', async () => {
    const first = await ostrelio.registerAgent({ externalKey: 'payments-agent', name: 'Payments Agent' });
    expect(first).toMatchObject({ created: true, status: 'ACTIVE', agentId: expect.any(String), displayKey: expect.any(String) });
    const again = await ostrelio.registerAgent({ externalKey: 'payments-agent', name: 'Payments Agent v2', runtime: 'node' });
    expect(again).toMatchObject({ created: false, agentId: first.agentId, displayKey: first.displayKey });

    const execution = await ostrelio.startExecution({ agentId: 'payments-agent', principalId: 'ops', objective: 'Pay invoice 42' });
    expect(execution).toMatchObject({ status: 'ACTIVE', principalId: 'ops', objective: 'Pay invoice 42', tenantId: TENANT });
  });

  it('guard runs the callback on ALLOW and records an EXECUTED outcome', async () => {
    const { execution } = await start();
    const callback = vi.fn(async (decision: AuthorizeResult) => `ran:${decision.decision}`);

    // The refund sandbox records a VERIFIED EXECUTED outcome itself; guard treats its own report's
    // OUTCOME_CONFLICT as already recorded, so onOutcomeError is not called.
    const onOutcomeError = vi.fn();
    const result = await ostrelio.guard(execution.id, lowRefund('charge-allow'), callback, { onOutcomeError });
    expect(onOutcomeError).not.toHaveBeenCalled();

    expect(result).toBe('ran:ALLOW');
    expect(callback).toHaveBeenCalledOnce();
    const decisionId = callback.mock.calls[0]![0].decisionId;
    expect(await outcomes(decisionId)).toEqual([{ outcome: 'EXECUTED' }]);
  });

  // Approving a sandbox-backed action makes the platform run it and consume the approval;
  // guard still runs the callback because a reviewer approved this exact action.
  it('guard waits for an operator approval, consumes it, then runs the callback', async () => {
    const { execution } = await start();
    const proposal = await needApproval(execution, 'approved');
    const order: string[] = [];
    let approvalId = '';

    const result = await ostrelio.guard(execution.id, proposal, (decision) => {
      order.push('callback');
      approvalId = decision.approval!.approvalId;
      return 'paid';
    }, {
      onApprovalRequired: (decision) => {
        order.push('required');
        expect(decision.decision).toBe('REQUIRE_APPROVAL');
        // Approve slightly later so guard is really long-polling.
        setTimeout(() => {
          void review(decision.approval!.approvalId, 'approve').then((response) => {
            order.push(`approve:${response.statusCode}`);
          });
        }, 150);
      },
    });

    expect(result).toBe('paid');
    expect(order[0]).toBe('required');
    expect(order).toContain('approve:200');
    expect(order.at(-1)).toBe('callback');
    const approval = await db.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [approvalId]);
    expect(approval.rows[0]?.status).toBe('CONSUMED');
    const decisionId = (await db.query<{ decision_id: string }>('SELECT decision_id FROM approvals WHERE id = $1', [approvalId])).rows[0]!.decision_id;
    expect(await outcomes(decisionId)).toEqual([{ outcome: 'EXECUTED' }]);
  });

  it('guard throws OstrelioApprovalRejected when the operator denies, and never runs the callback', async () => {
    const { execution } = await start();
    const proposal = await needApproval(execution, 'rejected');
    const callback = vi.fn();
    let approvalId = '';

    const error = await ostrelio.guard(execution.id, proposal, callback, {
      onApprovalRequired: (decision) => {
        approvalId = decision.approval!.approvalId;
        setTimeout(() => { void review(approvalId, 'deny'); }, 150);
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OstrelioApprovalRejected);
    expect(error).toBeInstanceOf(OstrelioError);
    expect((error as OstrelioApprovalRejected).code).toBe('APPROVAL_REJECTED');
    expect((error as OstrelioApprovalRejected).approval.status).toBe('DENIED');
    expect(callback).not.toHaveBeenCalled();
    const decisionId = (error as OstrelioApprovalRejected).decision.decisionId;
    expect(await outcomes(decisionId)).toEqual([]);
  });

  it('guard throws OstrelioDenied for a refund over the hard maximum', async () => {
    const { execution } = await start();
    const callback = vi.fn();

    const error = await ostrelio.guard(execution.id, {
      actionType: 'refund.create', resourceType: 'charge', resourceId: 'charge-huge',
      context: { amount: 250_001, currency: 'USD', customerId: 'sara' },
    }, callback).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OstrelioDenied);
    expect((error as OstrelioDenied).code).toBe('DENIED');
    expect((error as OstrelioDenied).decision.decision).toBe('DENY');
    expect(callback).not.toHaveBeenCalled();
    expect(await outcomes((error as OstrelioDenied).decision.decisionId)).toEqual([]);
  });

  it('a paused agent is refused with AGENT_PAUSED (423) on new executions and on guard', async () => {
    const { agent, execution } = await start();
    const paused = await app.inject({ method: 'POST', url: `/v1/agents/${agent.agentId}/pause`, headers: operator });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ status: 'PAUSED' });

    const callback = vi.fn();
    const guardError = await ostrelio.guard(execution.id, lowRefund('charge-paused'), callback).catch((caught: unknown) => caught);
    expect(guardError).toBeInstanceOf(OstrelioError);
    expect(guardError).toMatchObject({ code: 'AGENT_PAUSED', status: 423 });
    expect((guardError as OstrelioError).requestId).toBeTruthy();
    expect(callback).not.toHaveBeenCalled();

    const startError = await ostrelio.startExecution({ agentId: 'payments-agent', principalId: 'ops', objective: 'Try again' })
      .catch((caught: unknown) => caught);
    expect(startError).toMatchObject({ code: 'AGENT_PAUSED', status: 423 });
  });

  it('an unknown API key fails with API_KEY_INVALID (401) and a request id', async () => {
    const bad = new Ostrelio({
      baseUrl, apiKey: `ost_test_abcdefgh_${'A'.repeat(43)}`,
    });
    const error = await bad.registerAgent({ externalKey: 'x', name: 'x' }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OstrelioError);
    expect(error).toMatchObject({ code: 'API_KEY_INVALID', status: 401 });
    expect((error as OstrelioError).requestId).toBeTruthy();
  });
});
