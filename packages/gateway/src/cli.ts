#!/usr/bin/env node
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Ostrelio, OstrelioError } from '@ostrelio/sdk';
import { ConfigError, loadConfig } from './config.js';
import { OstrelioGateway, stderrLogger } from './gateway.js';
import { VERSION } from './version.js';

const USAGE = `ostrelio-gateway ${VERSION}

MCP server that asks Ostrelio before any mapped tool call reaches your upstream MCP servers.

Usage: ostrelio-gateway [--config <path>] [--workspace <name>]

  --config <path>      Gateway config (default: ./ostrelio.gateway.json)
  --workspace <name>   Workspace name, informational only
  --help               Show this help
  --version            Print the version

Environment:
  OSTRELIO_API_KEY     Workspace API key (required)
  OSTRELIO_BASE_URL    API origin (default: the SDK default)
`;

const fail = (message: string): never => {
  process.stderr.write(`ostrelio-gateway: ${message}\n`);
  process.exit(1);
};

interface Args { config: string; workspace?: string; help: boolean; version: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { config: resolve(process.cwd(), 'ostrelio.gateway.json'), help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') fail(`${flag} needs a value.`);
      return v as string;
    };
    if (flag === '--config') args.config = resolve(value());
    else if (flag === '--workspace') args.workspace = value();
    else if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--version' || flag === '-v') args.version = true;
    else fail(`Unknown argument "${arg}". Run with --help.`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE); return; }
  if (args.version) { process.stdout.write(`${VERSION}\n`); return; }

  const apiKey = process.env.OSTRELIO_API_KEY;
  if (!apiKey) fail('OSTRELIO_API_KEY is not set. Create an API key in the Ostrelio dashboard and pass it in the environment.');

  const config = await loadConfig(args.config);
  if (args.workspace) stderrLogger.info(`Workspace: ${args.workspace}`);
  const baseUrl = process.env.OSTRELIO_BASE_URL;
  const client = new Ostrelio({ apiKey: apiKey as string, ...(baseUrl ? { baseUrl } : {}) });
  const gateway = new OstrelioGateway({ config, client });

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void gateway.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);

  await gateway.start();
  await gateway.server.connect(new StdioServerTransport());
  stderrLogger.info(`Ready: ${config.upstreams.length} upstream(s), ${config.actions.length} mapped action(s).`);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) fail(error.message);
  if (error instanceof OstrelioError) {
    fail(`Could not start (${error.code}): ${error.message}${error.requestId ? ` Request id ${error.requestId}.` : ''}`);
  }
  fail(`Could not start: ${error instanceof Error ? error.message : String(error)}`);
});
