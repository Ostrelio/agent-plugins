// Fake upstream MCP server over stdio for gateway tests. Logs only to stderr.
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const str = { type: 'string' };
const num = { type: 'number' };
const tool = (name, description, properties = {}, required = Object.keys(properties)) => ({
  name, description, inputSchema: { type: 'object', properties, required },
});

const tools = [
  tool('create_refund', 'Refund a charge.', { charge: str, amount: num, currency: str, customer: str }),
  tool('update_payout_destination', 'Change where a vendor is paid.', { vendor: str, destination: str }),
  tool('send_payment', 'Pay an invoice.', { vendor: str, invoice: str, amount: num, currency: str }),
  tool('get_balance', 'Read the balance.'),
  tool('fail', 'Always reports an error.'),
  tool('crash', 'Exits the process.'),
];

const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

const handlers = {
  create_refund: (a) => text(`refunded ${a.charge} ${a.amount} ${a.currency}`),
  update_payout_destination: (a) => text(`payout destination for ${a.vendor} set to ${a.destination}`),
  send_payment: (a) => text(`paid ${a.invoice} to ${a.vendor}`),
  get_balance: () => text('balance 1000 USD'),
  fail: () => text('upstream failure', true),
  crash: () => process.exit(1),
};

const server = new Server({ name: 'fake-upstream', version: '0.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (process.env.FAKE_UPSTREAM_LOG) appendFileSync(process.env.FAKE_UPSTREAM_LOG, `${JSON.stringify({ tool: name, args })}\n`);
  const handler = handlers[name];
  return handler ? handler(args) : text(`unknown tool ${name}`, true);
});

await server.connect(new StdioServerTransport());
console.error('fake-upstream ready');
