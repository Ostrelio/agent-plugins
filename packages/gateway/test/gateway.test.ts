import type { Ostrelio, AuthorizeResult, ApprovalStatus, GuardOptions, Proposal } from '@ostrelio/sdk';
import {
  ErrorCodes, OstrelioApprovalExpired, OstrelioApprovalRejected, OstrelioApprovalTimeout, OstrelioDenied, OstrelioError,
} from '@ostrelio/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionMapping, GatewayConfig } from '../src/config.js';
import { stderrLogger, type Logger } from '../src/gateway.js';
import { baseConfig, connectGateway, createLog, textOf, type Connected } from './helpers/harness.js';

type GuardFn = (executionId: string, proposal: Proposal, action: (d: AuthorizeResult) => unknown, options?: GuardOptions) => Promise<unknown>;

const decision = (overrides: Partial<AuthorizeResult> = {}): AuthorizeResult => ({
  decision: 'ALLOW', decisionId: 'dec-1', reason: 'Allowed by policy', reasonCode: 'POLICY_ALLOW',
  event: {} as AuthorizeResult['event'], ...overrides,
});
const approvalStatus = (overrides: Partial<ApprovalStatus> = {}): ApprovalStatus => ({
  approvalId: 'appr-1', decisionId: 'dec-1', status: 'PENDING', expiresAt: '2030-01-01T00:00:00Z', reviewedAt: null, ...overrides,
});
const timeoutError = () => new OstrelioApprovalTimeout(
  decision({ decision: 'REQUIRE_APPROVAL', reason: 'Payout destination changed recently.', approval: { approvalId: 'appr-1' } }),
  approvalStatus(),
);

const refundAction: ActionMapping = {
  tool: 'fake.create_refund', actionType: 'refund.create', resourceType: 'charge',
  map: { resourceId: '$.charge', 'context.amount': '$.amount' },
};

interface Stub {
  client: Ostrelio;
  registerAgent: ReturnType<typeof vi.fn>;
  startExecution: ReturnType<typeof vi.fn>;
  guard: ReturnType<typeof vi.fn<GuardFn>>;
  /** Errors thrown by the guarded callback (what guard would report as FAILED). */
  callbackErrors: unknown[];
}

/** A stub Ostrelio whose guard runs the callback, like an ALLOW decision. */
const makeStub = (): Stub => {
  const callbackErrors: unknown[] = [];
  const registerAgent = vi.fn(async () => ({ agentId: 'agent-1', displayKey: 'AGT-001', status: 'ACTIVE', created: true }));
  const startExecution = vi.fn(async () => ({ id: 'exec-1' }));
  const guard = vi.fn<GuardFn>(async (_id, _proposal, action) => {
    try {
      return await action(decision());
    } catch (error) {
      callbackErrors.push(error);
      throw error;
    }
  });
  return { client: { registerAgent, startExecution, guard } as unknown as Ostrelio, registerAgent, startExecution, guard, callbackErrors };
};

const memoryLogger = () => {
  const lines: { level: string; msg: string }[] = [];
  const logger: Logger = {
    info: (msg) => lines.push({ level: 'info', msg }),
    warn: (msg) => lines.push({ level: 'warn', msg }),
    error: (msg) => lines.push({ level: 'error', msg }),
  };
  return { logger, lines };
};

describe('OstrelioGateway (stub Ostrelio, real fake upstream)', () => {
  let log: Awaited<ReturnType<typeof createLog>>;
  let connected: Connected | undefined;
  let stub: Stub;
  let logs: ReturnType<typeof memoryLogger>;

  beforeEach(async () => {
    log = await createLog();
    stub = makeStub();
    logs = memoryLogger();
  });
  afterEach(async () => {
    await connected?.close();
    connected = undefined;
    await log.cleanup();
  });

  const open = async (overrides: Partial<GatewayConfig> = {}, stubOverride: Stub = stub) => {
    connected = await connectGateway({
      config: baseConfig(log.path, { actions: [refundAction], ...overrides }), client: stubOverride.client, logger: logs.logger,
    });
    return connected;
  };

  it('registers the agent as an mcp-gateway at startup', async () => {
    await open();
    expect(stub.registerAgent).toHaveBeenCalledWith(expect.objectContaining({
      externalKey: 'mcp-gateway-test', name: 'Gateway Test', runtime: 'mcp-gateway',
    }));
    expect(stub.startExecution).toHaveBeenCalledWith({ agentId: 'mcp-gateway-test', principalId: 'tester', objective: expect.any(String) });
  });

  it('attributes the session execution to agent.companyId when configured', async () => {
    const companyId = '0b6f3f0e-4a0c-4d57-9d5e-2f8a9a1c7e11';
    await open({ agent: { externalKey: 'mcp-gateway-test', name: 'Gateway Test', principalId: 'tester', companyId } });
    expect(stub.startExecution).toHaveBeenCalledWith({
      agentId: 'mcp-gateway-test', principalId: 'tester', objective: expect.any(String), companyId,
    });
  });

  it('lists upstream tools as <upstream>.<tool> with their input schemas', async () => {
    const { client } = await open();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'fake.crash', 'fake.create_refund', 'fake.fail', 'fake.get_balance', 'fake.send_payment', 'fake.update_payout_destination',
    ]);
    const refund = tools.find((t) => t.name === 'fake.create_refund')!;
    expect(refund.description).toBe('Refund a charge.');
    expect(refund.inputSchema).toMatchObject({
      type: 'object',
      properties: { charge: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' }, customer: { type: 'string' } },
      required: ['charge', 'amount', 'currency', 'customer'],
    });
  });

  it('proposes the mapped action and forwards the call when guard runs the callback', async () => {
    const { call } = await open();
    const result = await call('fake.create_refund', { charge: 'ch_1', amount: 500, currency: 'USD', customer: 'c' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe('refunded ch_1 500 USD');
    expect(stub.guard).toHaveBeenCalledTimes(1);
    const [executionId, proposal, , options] = stub.guard.mock.calls[0]!;
    expect(executionId).toBe('exec-1');
    expect(proposal).toEqual({ actionType: 'refund.create', resourceType: 'charge', resourceId: 'ch_1', context: { amount: 500 } });
    expect(options).toMatchObject({ idempotencyKey: expect.stringMatching(/^mcp:[0-9a-f]{64}:0$/), approvalTimeoutMs: 0 });
    expect(await log.calls()).toHaveLength(1);
  });

  it('passes approvalWaitSeconds to guard as milliseconds', async () => {
    const { call } = await open({ approvalWaitSeconds: 12 });
    await call('fake.create_refund', { charge: 'ch_1', amount: 1, currency: 'USD', customer: 'c' });
    expect(stub.guard.mock.calls[0]![3]).toMatchObject({ approvalTimeoutMs: 12_000 });
  });

  describe('approval and idempotency keys', () => {
    const args = { charge: 'ch_1', amount: 500, currency: 'USD', customer: 'c' };
    const reordered = { customer: 'c', currency: 'USD', amount: 500, charge: 'ch_1' };

    it('returns the approval-required message exactly, never forwarding', async () => {
      stub.guard.mockRejectedValueOnce(timeoutError());
      const { call } = await open();
      const result = await call('fake.create_refund', args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Approval required: Payout destination changed recently. Approval id appr-1. Ask a human to approve in the Ostrelio dashboard, then call this tool again with the same arguments.',
      );
      expect(await log.calls()).toEqual([]);
    });

    it('reuses the idempotency key on retry (any key order), then uses a new key after the call settled', async () => {
      stub.guard.mockRejectedValueOnce(timeoutError());
      const { call } = await open();
      await call('fake.create_refund', args);
      const retry = await call('fake.create_refund', reordered);
      expect(retry.isError).toBeUndefined();
      const third = await call('fake.create_refund', args);
      expect(third.isError).toBeUndefined();

      const keys = stub.guard.mock.calls.map((c) => c[3]!.idempotencyKey);
      expect(keys).toHaveLength(3);
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).not.toBe(keys[0]);
      expect(keys[2]).toMatch(/^mcp:[0-9a-f]{64}:1$/);
      expect(await log.calls()).toHaveLength(2);
    });

    it('refuses an identical call while one is in progress, so one decision is never forwarded twice', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      stub.guard.mockImplementationOnce(async (_id, _proposal, action) => { await gate; return action(decision()); });
      const { call } = await open();
      const first = call('fake.create_refund', args);
      await vi.waitFor(() => expect(stub.guard).toHaveBeenCalledTimes(1));
      const second = await call('fake.create_refund', reordered);
      expect(second.isError).toBe(true);
      expect(textOf(second)).toBe('An identical "fake.create_refund" call is already in progress. Wait for it to finish, then call again if needed.');
      release();
      expect((await first).isError).toBeUndefined();
      expect(stub.guard).toHaveBeenCalledTimes(1);
      expect(await log.calls()).toHaveLength(1);
      // Once the first settles, the same call is accepted again as a new action.
      expect((await call('fake.create_refund', args)).isError).toBeUndefined();
    });

    it('does not share a key between different arguments', async () => {
      stub.guard.mockRejectedValueOnce(timeoutError());
      const { call } = await open();
      await call('fake.create_refund', args);
      await call('fake.create_refund', { ...args, amount: 501 });
      const keys = stub.guard.mock.calls.map((c) => c[3]!.idempotencyKey);
      expect(keys[1]).not.toBe(keys[0]);
    });

    it.each([
      ['denied', () => new OstrelioDenied(decision({ decision: 'DENY', reason: 'Amount too high' })), 'Denied by Ostrelio: Amount too high'],
      ['rejected', () => new OstrelioApprovalRejected(decision(), approvalStatus({ status: 'DENIED' })),
        'A reviewer denied this action in Ostrelio (approval appr-1). Do not retry it.'],
      ['expired', () => new OstrelioApprovalExpired(decision(), approvalStatus({ status: 'EXPIRED' })),
        'The Ostrelio approval for this action expired. Call the tool again to request a new approval.'],
    ])('%s: reports it and starts a fresh key afterwards', async (_label, makeError, message) => {
      stub.guard.mockRejectedValueOnce(timeoutError()).mockRejectedValueOnce(makeError());
      const { call } = await open();
      await call('fake.create_refund', args);
      const final = await call('fake.create_refund', args);
      expect(final.isError).toBe(true);
      expect(textOf(final)).toBe(message);
      await call('fake.create_refund', args);
      const keys = stub.guard.mock.calls.map((c) => c[3]!.idempotencyKey);
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).not.toBe(keys[1]);
      expect(await log.calls()).toHaveLength(1);
    });
  });

  it('passes an upstream isError result through unchanged and makes the guarded callback throw', async () => {
    const { call } = await open({ actions: [{ tool: 'fake.fail', actionType: 'x.fail', resourceType: 'thing', map: {} }] });
    const result = await call('fake.fail');
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'upstream failure' }]);
    expect(stub.callbackErrors).toHaveLength(1);
    expect((stub.callbackErrors[0] as Error).name).toBe('UpstreamToolError');
    expect(await log.calls()).toEqual([{ tool: 'fail', args: {} }]);
  });

  it('refuses an unmapped tool when unmappedTools is deny', async () => {
    const { call } = await open();
    const result = await call('fake.get_balance');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Ostrelio refused "fake.get_balance"');
    expect(textOf(result)).toContain('unmappedTools is "deny"');
    expect(stub.guard).not.toHaveBeenCalled();
    expect(await log.calls()).toEqual([]);
  });

  it('forwards an unmapped tool without authorization when unmappedTools is allow, and warns', async () => {
    const { call } = await open({ unmappedTools: 'allow' });
    const result = await call('fake.get_balance');
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe('balance 1000 USD');
    expect(stub.guard).not.toHaveBeenCalled();
    expect(logs.lines).toContainEqual({
      level: 'warn', msg: 'Forwarding unmapped tool "fake.get_balance" without authorization (unmappedTools: "allow").',
    });
    expect(await log.calls()).toEqual([{ tool: 'get_balance', args: {} }]);
  });

  it('refuses unknown upstreams and tool names without asking Ostrelio', async () => {
    const { call } = await open();
    const unknownTool = await call('fake.nope');
    expect(unknownTool.isError).toBe(true);
    const unknownUpstream = await call('ghost.tool');
    expect(unknownUpstream.isError).toBe(true);
    expect(textOf(unknownUpstream)).toBe('Unknown tool "ghost.tool".');
    const noDot = await call('plain');
    expect(textOf(noDot)).toBe('Unknown tool "plain".');
    expect(stub.guard).not.toHaveBeenCalled();
  });

  it('returns a MappingError message without calling guard or the upstream', async () => {
    const { call } = await open();
    const result = await call('fake.create_refund', { amount: 5 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Argument $.charge is required for resourceId.');
    expect(stub.guard).not.toHaveBeenCalled();
    expect(await log.calls()).toEqual([]);
  });

  it('tells the caller when the upstream died during a call, and recovers on the next call', async () => {
    const { call } = await open({
      actions: [refundAction, { tool: 'fake.crash', actionType: 'x.crash', resourceType: 'thing', map: {} }],
    });
    const crashed = await call('fake.crash');
    expect(crashed.isError).toBe(true);
    expect(textOf(crashed)).toMatch(/Upstream tool "fake\.crash" failed: Upstream "fake" stopped while running crash/);
    const after = await call('fake.create_refund', { charge: 'ch_2', amount: 1, currency: 'USD', customer: 'c' });
    expect(after.isError).toBeUndefined();
    expect(textOf(after)).toBe('refunded ch_2 1 USD');
  });

  describe('Ostrelio failures', () => {
    const args = { charge: 'ch_1', amount: 500, currency: 'USD', customer: 'c' };

    it('explains a paused agent', async () => {
      stub.guard.mockRejectedValueOnce(new OstrelioError({ code: ErrorCodes.AGENT_PAUSED, status: 423, message: 'paused' }));
      const { call } = await open();
      const result = await call('fake.create_refund', args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('Agent "mcp-gateway-test" is paused in Ostrelio, so the gateway refuses every action. Resume it in the Ostrelio dashboard.');
      expect(await log.calls()).toEqual([]);
    });

    it('explains a revoked agent', async () => {
      stub.guard.mockRejectedValueOnce(new OstrelioError({ code: ErrorCodes.AGENT_REVOKED, status: 423, message: 'revoked' }));
      const { call } = await open();
      expect(textOf(await call('fake.create_refund', args))).toContain('is revoked in Ostrelio');
    });

    it('reports other Ostrelio errors with code and request id, without forwarding', async () => {
      stub.guard.mockRejectedValueOnce(new OstrelioError({ code: 'NETWORK_ERROR', status: 0, message: 'down', requestId: 'req-9' }));
      const { call } = await open();
      const result = await call('fake.create_refund', args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('Ostrelio could not authorize "fake.create_refund" (NETWORK_ERROR): down Request id req-9.');
      expect(logs.lines.some((l) => l.level === 'error')).toBe(true);
      expect(await log.calls()).toEqual([]);
    });

    it('reports an unexpected non-Ostrelio error', async () => {
      stub.guard.mockRejectedValueOnce(new Error('boom'));
      const { call } = await open();
      expect(textOf(await call('fake.create_refund', args))).toBe('Ostrelio could not authorize "fake.create_refund": boom');
    });

    it('surfaces an outcome-reporting failure as a warning, not an error', async () => {
      stub.guard.mockImplementationOnce(async (_id, _p, action, options) => {
        const value = await action(decision());
        options?.onOutcomeError?.(new Error('outcome lost'));
        return value;
      });
      const { call } = await open();
      const result = await call('fake.create_refund', args);
      expect(result.isError).toBeUndefined();
      expect(logs.lines).toContainEqual({
        level: 'warn', msg: '"fake.create_refund" ran but reporting its outcome to Ostrelio failed: outcome lost',
      });
    });

    it('reports an upstream that cannot start as a failed call, without crashing', async () => {
      const { call } = await open({
        actions: [refundAction],
        upstreams: [{ name: 'fake', command: process.execPath, args: ['--eval', 'process.exit(1)'], env: {} }],
      });
      const result = await call('fake.create_refund', args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Upstream tool "fake.create_refund" failed');
    });
  });

  describe('executions', () => {
    const pausedError = () => new OstrelioError({ code: ErrorCodes.AGENT_PAUSED, status: 423, message: 'paused' });

    it('starts even when the agent is paused, and retries startExecution on the next call', async () => {
      stub.registerAgent.mockResolvedValueOnce({ agentId: 'a', displayKey: 'AGT-001', status: 'PAUSED', created: false });
      stub.startExecution.mockRejectedValueOnce(pausedError());
      const { call } = await open();
      expect(stub.startExecution).toHaveBeenCalledTimes(1);
      expect(logs.lines.some((l) => l.level === 'warn' && l.msg.includes('paused'))).toBe(true);

      const result = await call('fake.create_refund', { charge: 'ch_1', amount: 1, currency: 'USD', customer: 'c' });
      expect(result.isError).toBeUndefined();
      expect(stub.startExecution).toHaveBeenCalledTimes(2);
      expect(stub.guard).toHaveBeenCalledTimes(1);
    });

    it('refuses calls with the paused message while startExecution keeps failing with AGENT_PAUSED', async () => {
      stub.startExecution.mockRejectedValue(pausedError());
      const { call } = await open();
      const result = await call('fake.create_refund', { charge: 'ch_1', amount: 1, currency: 'USD', customer: 'c' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('is paused in Ostrelio');
      expect(stub.guard).not.toHaveBeenCalled();
      expect(await log.calls()).toEqual([]);
    });

    it('fails startup on other startExecution errors', async () => {
      stub.startExecution.mockRejectedValue(new OstrelioError({ code: 'API_KEY_INVALID', status: 401, message: 'bad key' }));
      await expect(open()).rejects.toThrow('bad key');
    });

    it('starts one execution for concurrent first calls', async () => {
      stub.startExecution.mockRejectedValueOnce(pausedError());
      const { call } = await open();
      await Promise.all([1, 2, 3].map((n) => call('fake.create_refund', { charge: `c${n}`, amount: 1, currency: 'USD', customer: 'c' })));
      expect(stub.startExecution).toHaveBeenCalledTimes(2);
    });
  });

  it('never writes to stdout while handling calls (stderr logger)', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      stdout.mockClear();
      connected = await connectGateway({
        config: baseConfig(log.path, { actions: [refundAction], unmappedTools: 'allow' }), client: stub.client, logger: stderrLogger,
      });
      stub.guard.mockRejectedValueOnce(new Error('boom'));
      await connected.call('fake.create_refund', { charge: 'ch_1', amount: 1, currency: 'USD', customer: 'c' });
      await connected.call('fake.get_balance');
      await connected.close();
      connected = undefined;
      const gatewayWrites = stdout.mock.calls.filter((c) => String(c[0]).includes('ostrelio-gateway'));
      expect(gatewayWrites).toEqual([]);
      expect(stderr.mock.calls.some((c) => String(c[0]).startsWith('[ostrelio-gateway] warn Forwarding unmapped tool'))).toBe(true);
      expect(stderr.mock.calls.some((c) => String(c[0]).startsWith('[ostrelio-gateway] error '))).toBe(true);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
