/**
 * Demo: an agent registers, proposes a vendor payment, and waits for a human to approve it.
 *
 *   OSTRELIO_API_KEY=ost_test_... OSTRELIO_BASE_URL=http://127.0.0.1:3100 npm run example
 *
 * Changing a vendor's payout destination and then paying that vendor is the sequence Ostrelio
 * holds for approval. Approve or deny it from the dashboard's Approvals view while this waits.
 */
import { Ostrelio, OstrelioDenied, OstrelioError } from '@ostrelio/sdk';

const apiKey = process.env.OSTRELIO_API_KEY;
if (!apiKey) {
  console.error('Set OSTRELIO_API_KEY to a workspace API key (ost_test_...).');
  process.exit(1);
}
const ostrelio = new Ostrelio({ apiKey, ...(process.env.OSTRELIO_BASE_URL ? { baseUrl: process.env.OSTRELIO_BASE_URL } : {}) });

const vendorId = `vendor-${Date.now()}`;

try {
  const agent = await ostrelio.registerAgent({ externalKey: 'demo-payments-agent', name: 'Demo payments agent', runtime: 'node' });
  console.log(`Agent ${agent.displayKey} is ${agent.status}${agent.created ? ' (new)' : ''}.`);

  const execution = await ostrelio.startExecution({
    agentId: 'demo-payments-agent',
    principalId: 'finance-ops',
    objective: `Update ${vendorId}'s bank details and pay their open invoice.`,
  });

  await ostrelio.guard(execution.id, {
    actionType: 'vendor.payout_destination.update', resourceType: 'payout_destination', resourceId: `${vendorId}-bank`,
    context: { vendorId, destination: 'acct-ending-4821' },
  }, (decision) => console.log(`1. Payout destination change: ${decision.decision} (${decision.reason})`));

  const receipt = await ostrelio.guard(execution.id, {
    actionType: 'payment.send', resourceType: 'payment', resourceId: `${vendorId}-invoice-1`,
    context: { vendorId, amount: 10_000, currency: 'USD' },
  }, async () => ({ paymentId: `pay_${Date.now()}` }), {
    onApprovalRequired: (decision) => console.log(`2. Payment needs approval: ${decision.reason}\n   Waiting for a reviewer...`),
  });
  console.log(`   Approved. Sent payment ${receipt.paymentId}; outcome reported to Ostrelio.`);
} catch (error) {
  if (error instanceof OstrelioDenied) console.error(`Blocked: ${error.decision.reason}`);
  else if (error instanceof OstrelioError) console.error(`${error.code} (HTTP ${error.status}, request ${error.requestId}): ${error.message}`);
  else throw error;
  process.exitCode = 1;
}
