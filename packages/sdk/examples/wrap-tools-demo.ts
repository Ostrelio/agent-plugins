/**
 * Demo: a custom ops agent's tools, wrapped so Ostrelio authorizes every call.
 *
 *   OSTRELIO_API_KEY=ost_test_... OSTRELIO_BASE_URL=http://127.0.0.1:3100 npm run example:tools
 *
 * The tools are stand-ins (nothing touches real files, shells, or secrets). Each call prints what
 * Ostrelio decided: allowed calls run and report EXECUTED, denied ones throw OstrelioDenied, and
 * held ones throw OstrelioHeld at once (approvalTimeoutMs: 0) so you can approve them in the
 * dashboard's Approvals view and run the demo again.
 */
import { Ostrelio, OstrelioDenied, OstrelioError, OstrelioHeld, wrapTools } from '@ostrelio/sdk';

const apiKey = process.env.OSTRELIO_API_KEY;
if (!apiKey) {
  console.error('Set OSTRELIO_API_KEY to a workspace API key (ost_test_...).');
  process.exit(1);
}
const client = new Ostrelio({ apiKey, ...(process.env.OSTRELIO_BASE_URL ? { baseUrl: process.env.OSTRELIO_BASE_URL } : {}) });

const tools = wrapTools({
  read_file: async ({ path }: { path: string }) => `# ${path}\nService runbook: restart with the deploy tool.`,
  run_shell: async ({ command }: { command: string }) => `$ ${command}\nok`,
  rotate_secret: async ({ name }: { name: string }) => `rotated ${name}`,
  post_message: async ({ channel, text }: { channel: string; text: string }) => `posted to ${channel}: ${text}`,
}, {
  client,
  agent: { externalKey: 'demo-ops-agent', name: 'Demo ops agent', principalId: 'platform-oncall' },
  request: 'Rotate the leaked staging database password and tell #ops when it is done.',
  approvalTimeoutMs: 0,
  // Gateway-style rules for the tools policies care about; the rest get `tool.<name>`.
  map: {
    run_shell: { actionType: 'shell.exec', resourceType: 'shell', map: { resourceId: '$.command', 'context.command': '$.command' } },
    rotate_secret: { actionType: 'secret.rotate', resourceType: 'secret', map: { resourceId: '$.name' } },
    post_message: { actionType: 'message.send', resourceType: 'channel', map: { resourceId: '$.channel' } },
  },
});

const steps: Array<[string, () => Promise<string>]> = [
  ['read_file', () => tools.read_file({ path: 'docs/runbook.md' })],
  ['run_shell', () => tools.run_shell({ command: 'kubectl get pods -n staging' })],
  ['rotate_secret', () => tools.rotate_secret({ name: 'staging/db-password' })],
  ['post_message', () => tools.post_message({ channel: '#ops', text: 'Staging DB password rotated.' })],
];

for (const [name, call] of steps) {
  try {
    console.log(`${name}: allowed → ${(await call()).split('\n')[0]}`);
  } catch (error) {
    if (error instanceof OstrelioDenied) console.log(`${name}: denied → ${error.decision.reason}`);
    else if (error instanceof OstrelioHeld) console.log(`${name}: held for approval ${error.approvalId} → ${error.decision.reason}`);
    else if (error instanceof OstrelioError) {
      console.error(`${name}: ${error.code} (HTTP ${error.status}, request ${error.requestId}): ${error.message}`);
      process.exitCode = 1;
      break;
    } else throw error;
  }
}
