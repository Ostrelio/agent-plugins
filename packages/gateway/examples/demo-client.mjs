/**
 * Demo: an MCP client talks to the Ostrelio gateway, which sits in front of a sample payments server.
 *
 *   OSTRELIO_API_KEY=ost_test_... npm run example
 *
 * Set OSTRELIO_BASE_URL to point at a non-default API. The last step holds a payment for human
 * approval: approve it in the dashboard (/platform, Approvals) while this waits.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const apiKey = process.env.OSTRELIO_API_KEY;
if (!apiKey) {
  console.error('Set OSTRELIO_API_KEY to a workspace API key (ost_test_...).');
  console.error('Optionally set OSTRELIO_BASE_URL to your Ostrelio API origin.');
  process.exit(1);
}

const examplesDir = dirname(fileURLToPath(import.meta.url));
const cli = join(examplesDir, '..', 'dist', 'cli.js');

const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const step = (title) => console.log(`\n${bold(title)}`);
const say = (s) => console.log(`   ${s}`);
const textOf = (result) => (result.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const env = { ...getDefaultEnvironment(), OSTRELIO_API_KEY: apiKey };
if (process.env.OSTRELIO_BASE_URL) env.OSTRELIO_BASE_URL = process.env.OSTRELIO_BASE_URL;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, '--config', './ostrelio.gateway.json'],
  cwd: examplesDir,
  env,
  stderr: 'pipe',
});
transport.stderr?.on('data', (chunk) => {
  for (const line of String(chunk).split('\n')) if (line.trim()) console.log(dim(`   | ${line}`));
});

const client = new Client({ name: 'ostrelio-demo-client', version: '0.1.0' });

async function call(name, args) {
  say(`${name} ${JSON.stringify(args)}`);
  const result = await client.callTool({ name, arguments: args });
  say(`${result.isError ? '-> refused or failed:' : '-> forwarded:'} ${textOf(result)}`);
  return result;
}

const approvalPending = (result) => result.isError && textOf(result).startsWith('Approval required');

try {
  await client.connect(transport);

  step('Connected to the Ostrelio gateway. Tools it exposes:');
  const { tools } = await client.listTools();
  for (const tool of tools) say(`${tool.name}: ${tool.description ?? ''}`);

  step('1. A small refund: policy allows it, so the gateway forwards it');
  await call('payments.create_refund', { charge: 'ch_1042', amount_cents: 4_200, currency: 'USD', customer: 'cus_sara' });

  step('2. A huge refund: policy denies it, so it never reaches the payments tool');
  await call('payments.create_refund', { charge: 'ch_1043', amount_cents: 250_001, currency: 'USD', customer: 'cus_sara' });

  step('3. A tool with no Ostrelio mapping: refused (unmappedTools is "deny")');
  await call('payments.get_balance', {});

  step('4. Business email compromise: change a vendor\'s bank details, then pay them');
  const vendor = `vendor-${Date.now()}`;
  await call('payments.update_payout_destination', { vendor, destination: 'acct-ending-4821' });
  const payment = { vendor, invoice: `inv-${Date.now()}`, amount_cents: 10_000, currency: 'USD' };
  let result = await call('payments.send_payment', payment);

  if (approvalPending(result)) {
    console.log(`\n${bold('>>> Presenter: approve the pending payment in the dashboard (/platform, Approvals).')}`);
    console.log('    Retrying the identical call every 5 seconds until it is approved or denied.\n');
    const deadline = Date.now() + 10 * 60_000;
    while (approvalPending(result) && Date.now() < deadline) {
      await sleep(5_000);
      result = await client.callTool({ name: 'payments.send_payment', arguments: payment });
      say(dim(`retry: ${textOf(result)}`));
    }
    if (!result.isError) {
      console.log(`\n${bold('Approved and forwarded:')} ${textOf(result)}`);
    } else if (approvalPending(result)) {
      console.log('\nStopped waiting after 10 minutes. The approval is still pending.');
      process.exitCode = 1;
    } else {
      console.log(`\n${bold('Not executed:')} ${textOf(result)}`);
    }
  } else if (!result.isError) {
    console.log('\nThe payment was forwarded without approval. Check the workspace policies.');
  }
} catch (error) {
  console.error(`\nDemo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
