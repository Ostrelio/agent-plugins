// node --test --experimental-strip-types packages/agent-guard/ledger.test.ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { toProposal } from './classify.ts';
import { cachedDenial, denialMessage, describeCall, emptyLedger, fingerprint, hasActivity, holdBegan, ledgerOf, recordOutcome, startRun, statusText, summaryText, timelineLink } from './ledger.ts';

const cwd = '/work/app';
const rm = toProposal('bash', { command: 'rm -rf ~/scratch' }, cwd);
const read = toProposal('read', { path: 'README.md' }, cwd);

test('the same call has the same fingerprint, whatever the request or the agent said around it', () => {
  const a = { ...rm, context: { ...rm.context, request: 'clean up', agentSaid: 'Deleting now.', untrustedInputs: [{ source: 'x', text: 'y' }] } };
  const b = { ...rm, context: { ...rm.context, request: 'something else' } };
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(rm), fingerprint(toProposal('bash', { command: 'rm -rf ~/other' }, cwd)));
  assert.notEqual(fingerprint(rm), fingerprint(read));
});

test('a denial names what was blocked, why, and what the model can do instead', () => {
  const message = denialMessage(rm, 'Recursively deleting files outside the workspace is not allowed.');
  assert.match(message, /blocked this call: bash: rm -rf ~\/scratch \(shell\.exec\)/);
  assert.match(message, /Why: Recursively deleting files outside the workspace is not allowed\./);
  assert.match(message, /keep your work inside the workspace/);
  assert.match(message, /ask the person/);
  assert.match(message, /stop and say what you could not do/);
  assert.equal(describeCall(read), 'read: README.md');
});

test('only denials and rejections are remembered, and a repeat is counted', () => {
  let ledger = emptyLedger();
  assert.equal(cachedDenial(ledger, rm), null);
  ledger = recordOutcome(ledger, { proposal: read, outcome: 'ALLOW', ms: 12, at: 1 });
  assert.equal(cachedDenial(ledger, read), null, 'an allowed call is never cached');
  ledger = recordOutcome(ledger, { proposal: rm, outcome: 'DENY', ms: 30, at: 2, message: denialMessage(rm, 'No.') });
  assert.match(cachedDenial(ledger, rm)!, /^Ostrelio already blocked this identical call earlier in this session, so it was not sent again\. Blocked: bash: rm -rf/);
  ledger = recordOutcome(ledger, { proposal: rm, outcome: 'REPEAT', ms: 0, at: 3 });
  assert.equal(ledger.total.repeats, 1);
  assert.equal(ledger.denied[fingerprint(rm)]!.count, 2);
  const timedOut = recordOutcome(emptyLedger(), { proposal: rm, outcome: 'TIMED_OUT', ms: 5, at: 4, message: 'x' });
  assert.equal(cachedDenial(timedOut, rm), null, 'a hold nobody answered may be asked again');
});

test('counts, pending holds and the status line', () => {
  let ledger = emptyLedger();
  ledger = recordOutcome(ledger, { proposal: read, outcome: 'ALLOW', ms: 4, at: Date.UTC(2026, 0, 1, 14, 3, 22) });
  ledger = holdBegan(ledger, rm, 'appr-1', 5);
  assert.match(statusText(ledger), /^Ostrelio ✓ 1 allowed · ⏸ 1 held · ✗ 0 denied · ⏳ waiting for approval: bash: rm -rf ~\/scratch · last ✓ allowed read \(4 ms\) \d\d:\d\d:\d\d$/);
  ledger = recordOutcome(ledger, { proposal: rm, outcome: 'REJECTED', ms: 2000, at: 6, approvalId: 'appr-1', message: 'no' });
  assert.deepEqual(ledger.pending, []);
  assert.equal(ledger.total.held, 1);
  assert.equal(ledger.total.rejected, 1);
  assert.match(statusText(ledger), /^Ostrelio ✓ 1 allowed · ⏸ 1 held · ✗ 1 denied · last ✗ rejected bash \(2\.0 s\)/);
});

test('a new request resets the run counts but keeps the session totals and the denial cache', () => {
  let ledger = recordOutcome(emptyLedger(), { proposal: rm, outcome: 'DENY', ms: 1, at: 1, message: 'm' });
  assert.equal(hasActivity(ledger), true);
  ledger = startRun(ledger);
  assert.equal(hasActivity(ledger), false);
  assert.equal(ledger.total.denied, 1);
  assert.ok(cachedDenial(ledger, rm));
  assert.deepEqual(ledgerOf(undefined), emptyLedger());
  assert.deepEqual(ledgerOf({ total: { allowed: 2 } }).total.allowed, 2);
});

test('the summary has the counts, what is still waiting, and the session timeline link', () => {
  let ledger = emptyLedger();
  for (const outcome of ['ALLOW', 'ALLOW'] as const) ledger = recordOutcome(ledger, { proposal: read, outcome, ms: 1, at: 1 });
  ledger = recordOutcome(ledger, { proposal: rm, outcome: 'APPROVED', ms: 900, at: 2, approvalId: 'a' });
  ledger = recordOutcome(ledger, { proposal: rm, outcome: 'DENY', ms: 1, at: 3, message: 'm' });
  ledger = holdBegan(ledger, rm, 'appr-2', 4);
  const text = summaryText(ledger, { dashboardUrl: 'https://console.example.test/', agentId: 'omp-agent', executionId: 'exec-1', approveCommand: 'ostrelio approve' });
  assert.equal(text, [
    'Ostrelio session summary',
    '  2 allowed · 2 held (1 approved, 0 rejected) · 1 denied',
    '  Still waiting for approval: bash: rm -rf ~/scratch (https://console.example.test/platform/approvals?approvalId=appr-2)',
    '  Approve from this terminal: ostrelio approve <approval id>',
    '  Timeline: https://console.example.test/platform/agents/omp-agent/sessions/exec-1',
  ].join('\n'));
  assert.equal(timelineLink('http://localhost:3000', 'a b', 'e/1'), 'http://localhost:3000/platform/agents/a%20b/sessions/e%2F1');
});
