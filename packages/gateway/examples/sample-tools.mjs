/**
 * Stand-in payments system for the gateway demo: a small MCP server over stdio.
 * Nothing here moves real money. It returns realistic-looking text so the demo reads well.
 * Logs go to stderr only; stdout carries MCP frames.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const tools = [
  {
    name: 'create_refund',
    description: 'Refund a customer charge. amount_cents is in cents ($40.00 is 4000).',
    inputSchema: {
      type: 'object',
      properties: {
        charge: { type: 'string', minLength: 1, description: 'Charge id, e.g. ch_1042' },
        amount_cents: { type: 'integer', minimum: 1, description: 'Refund amount in cents: $40.00 is 4000' },
        currency: { type: 'string', enum: ['USD', 'EUR', 'GBP'], description: 'Upper-case ISO currency code, e.g. USD' },
        customer: { type: 'string', minLength: 1, description: 'Customer id, e.g. cus_sara' },
      },
      required: ['charge', 'amount_cents', 'currency', 'customer'],
    },
  },
  {
    name: 'update_payout_destination',
    description: "Change the bank account a vendor's payouts are sent to.",
    inputSchema: {
      type: 'object',
      properties: {
        vendor: { type: 'string', minLength: 1, description: 'Vendor id, e.g. acme-hosting' },
        destination: { type: 'string', minLength: 1, description: 'New destination account, e.g. acct-ending-4821' },
      },
      required: ['vendor', 'destination'],
    },
  },
  {
    name: 'send_payment',
    description: 'Pay a vendor invoice. amount_cents is in cents ($500.00 is 50000).',
    inputSchema: {
      type: 'object',
      properties: {
        vendor: { type: 'string', minLength: 1, description: 'Vendor id, e.g. acme-hosting' },
        invoice: { type: 'string', minLength: 1, description: 'Invoice id, e.g. inv-1042. Ask the user if they did not give one.' },
        amount_cents: { type: 'integer', minimum: 1, description: 'Payment amount in cents: $500.00 is 50000' },
        currency: { type: 'string', enum: ['USD', 'EUR', 'GBP'], description: 'Upper-case ISO currency code, e.g. USD' },
      },
      required: ['vendor', 'invoice', 'amount_cents', 'currency'],
    },
  },
  {
    name: 'send_wire',
    description: 'Send a wire transfer from the operating account. amount_cents is in cents ($500,000.00 is 50000000).',
    inputSchema: {
      type: 'object',
      properties: {
        beneficiary: { type: 'string', minLength: 1, description: 'Name of the person or company receiving the wire' },
        account: { type: 'string', minLength: 1, description: 'Destination account or IBAN, e.g. GB29NWBK60161331926819' },
        amount_cents: { type: 'integer', minimum: 1, description: 'Amount in cents: $500,000.00 is 50000000' },
        currency: { type: 'string', enum: ['USD', 'EUR', 'GBP'], description: 'Upper-case ISO currency code, e.g. USD' },
        memo: { type: 'string', description: 'Reference shown to the beneficiary' },
      },
      required: ['beneficiary', 'account', 'amount_cents', 'currency'],
    },
  },
  {
    name: 'get_balance',
    description: 'Read the operating account balance.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const money = (cents, currency) => `${(cents / 100).toFixed(2)} ${currency}`;
const id = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const handlers = {
  create_refund: ({ charge, amount_cents, currency, customer }) =>
    `Refund ${id('re')} created: ${money(amount_cents, currency)} returned to customer ${customer} for charge ${charge}.`,
  update_payout_destination: ({ vendor, destination }) =>
    `Payout destination for vendor ${vendor} changed to ${destination}. Effective immediately.`,
  send_payment: ({ vendor, invoice, amount_cents, currency }) =>
    `Payment ${id('pay')} sent: ${money(amount_cents, currency)} to vendor ${vendor} for invoice ${invoice}.`,
  send_wire: ({ beneficiary, account, amount_cents, currency }) =>
    `Wire ${id('wire')} sent: ${money(amount_cents, currency)} to ${beneficiary} (${account}).`,
  get_balance: () => 'Operating account balance: 1,284,310.55 USD available, 42,000.00 USD pending.',
};

const server = new Server({ name: 'sample-payments', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const handler = handlers[request.params.name];
  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool ${request.params.name}.` }], isError: true };
  }
  const args = request.params.arguments ?? {};
  console.error(`[sample-tools] ${request.params.name} ${JSON.stringify(args)}`);
  return { content: [{ type: 'text', text: handler(args) }] };
});

await server.connect(new StdioServerTransport());
console.error('[sample-tools] ready');
