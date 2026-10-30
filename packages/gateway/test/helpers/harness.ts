import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GatewayConfig } from '../../src/config.js';
import { OstrelioGateway, type GatewayOptions } from '../../src/gateway.js';

export const FIXTURE = fileURLToPath(new URL('../fixtures/fake-upstream.mjs', import.meta.url));

export interface UpstreamCall { tool: string; args: Record<string, unknown> }

/** A scratch directory holding the fake upstream's call log. */
export async function createLog(): Promise<{ path: string; calls: () => Promise<UpstreamCall[]>; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-test-'));
  const path = join(dir, 'upstream.log');
  return {
    path,
    calls: async () => {
      const text = await readFile(path, 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as UpstreamCall);
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export const baseConfig = (logPath: string, overrides: Partial<GatewayConfig> = {}): GatewayConfig => ({
  agent: { externalKey: 'mcp-gateway-test', name: 'Gateway Test', principalId: 'tester' },
  upstreams: [{ name: 'fake', command: process.execPath, args: [FIXTURE], env: { FAKE_UPSTREAM_LOG: logPath } }],
  actions: [],
  unmappedTools: 'deny',
  approvalWaitSeconds: 0,
  ...overrides,
});

export interface Connected {
  gateway: OstrelioGateway;
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  close: () => Promise<void>;
}

/** Starts a gateway and connects an MCP client to its server over an in-memory transport. */
export async function connectGateway(options: GatewayOptions): Promise<Connected> {
  const gateway = new OstrelioGateway(options);
  await gateway.start();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await gateway.server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    gateway,
    client,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close().catch(() => undefined);
      await gateway.close();
    },
  };
}

export const textOf = (result: CallToolResult): string =>
  (result.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
