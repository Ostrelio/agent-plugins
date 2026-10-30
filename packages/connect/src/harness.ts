/**
 * Writes the config each harness needs to talk to Ostrelio. The plugins read OSTRELIO_* from the
 * environment, so the work here is getting the workspace URL and key (and the company, if any)
 * into the environment that harness starts with, and returning the one line that starts it.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Harness = 'claude-code' | 'omp' | 'mcp';
export const HARNESSES: readonly Harness[] = ['claude-code', 'omp', 'mcp'];

export interface Upstream { name: string; command: string; args: string[] }

export interface ConnectOptions {
  harness: Harness;
  /** Project the agent works in. Config files are written here. */
  dir: string;
  baseUrl: string;
  apiKey: string;
  companyId?: string;
  /** MCP only: the servers the gateway fronts (at least one). */
  upstreams?: Upstream[];
  /** MCP only: what the gateway does with tools that have no action mapping. */
  unmapped?: 'deny' | 'allow';
  /** MCP only: the client config to add the entry to. Default `<dir>/.mcp.json`. */
  mcpFile?: string;
  /** Where the sibling packages (claude-code-plugin, omp-plugin, gateway) live. Default: this repo's packages/. */
  packagesDir?: string;
}

export interface ConnectResult {
  /** Files created or changed. */
  files: string[];
  /** The line that starts the agent. */
  start: string;
  notes: string[];
}

export const defaultPackagesDir = (): string => fileURLToPath(new URL('../../', import.meta.url));

const quote = (value: string): string => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

function need(path: string, hint: string): string {
  if (!existsSync(path)) throw new Error(`${path} does not exist. ${hint}`);
  return path;
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* reported below */ }
  throw new Error(`${path} is not a JSON object. Fix or remove it, then run this again.`);
}

function writeFile(path: string, text: string, secret = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, secret ? { mode: 0o600 } : undefined);
  if (secret) chmodSync(path, 0o600);
}

const writeJson = (path: string, value: unknown, secret = false): void => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, secret);

const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** The environment every plugin reads. */
function ostrelioEnv(options: ConnectOptions): Record<string, string> {
  return {
    OSTRELIO_API_KEY: options.apiKey,
    OSTRELIO_BASE_URL: options.baseUrl,
    ...(options.companyId ? { OSTRELIO_COMPANY_ID: options.companyId } : {}),
  };
}

/** Claude Code: the key goes in `.claude/settings.local.json` (Claude Code keeps it out of git) as session env; the plugin loads with --plugin-dir. */
function claudeCode(options: ConnectOptions, packages: string): ConnectResult {
  const plugin = need(join(packages, 'claude-code-plugin'), 'Run this from a checkout of the Ostrelio repository.');
  const file = join(options.dir, '.claude', 'settings.local.json');
  const settings = readJson(file);
  writeJson(file, { ...settings, env: { ...asObject(settings.env), ...ostrelioEnv(options) } }, true);
  return {
    files: [file],
    start: `claude --plugin-dir ${quote(plugin)}`,
    notes: ['Run it from this project folder: Claude Code reads the key and workspace URL from .claude/settings.local.json.'],
  };
}

/** omp has no settings env, so the key goes in an env file the start line sources. The folder is one the plugin's tamper rules protect. */
function omp(options: ConnectOptions, packages: string): ConnectResult {
  const plugin = need(join(packages, 'omp-plugin'), 'Run this from a checkout of the Ostrelio repository.');
  const folder = join(options.dir, '.ostrelio-you');
  const envFile = join(folder, 'connect.env');
  writeFile(envFile, `${Object.entries(ostrelioEnv(options)).map(([name, value]) => `${name}=${quote(value)}`).join('\n')}\n`, true);
  const ignore = join(options.dir, '.gitignore');
  const current = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  const files = [envFile];
  if (!current.split('\n').some((line) => line.trim().replace(/\/$/, '') === '.ostrelio-you')) {
    writeFile(ignore, `${current}${current && !current.endsWith('\n') ? '\n' : ''}.ostrelio-you/\n`);
    files.push(ignore);
  }
  const run = `omp -e ${quote(join(plugin, 'ostrelio.ts'))} --config ${quote(join(plugin, 'omp-config.yml'))} --tools read,grep,find,glob,edit,write,bash,todo`;
  return { files, start: `(set -a; . ${quote(envFile)}; set +a; ${run})`, notes: [] };
}

/** MCP clients (Cursor, Claude Desktop, Claude Code): a gateway config plus an mcpServers entry that starts it. */
function mcp(options: ConnectOptions, packages: string): ConnectResult {
  const upstreams = options.upstreams ?? [];
  if (upstreams.length === 0) throw new Error('The gateway fronts at least one MCP server. Pass --upstream "name=command arg ...", for example --upstream "files=npx -y @modelcontextprotocol/server-filesystem .".');
  const gateway = need(join(packages, 'gateway', 'dist', 'cli.js'), 'Build it first: npm install --prefix packages/sdk && npm install --prefix packages/gateway && npm run build --prefix packages/gateway.');
  const config = join(options.dir, 'ostrelio.gateway.json');
  const clientFile = resolve(options.dir, options.mcpFile ?? '.mcp.json');
  const files = [clientFile];
  // The gateway config is the person's to edit (tool mappings live there), so an existing one is kept.
  if (existsSync(config)) readJson(config);
  else {
    writeJson(config, {
      agent: { externalKey: 'mcp-agent', name: 'MCP agent', ...(options.companyId ? { companyId: options.companyId } : {}) },
      upstreams: upstreams.map(({ name, command, args }) => ({ name, command, args })),
      actions: [],
      unmappedTools: options.unmapped ?? 'deny',
      approvalWaitSeconds: 0,
    });
    files.unshift(config);
  }
  const client = readJson(clientFile);
  writeJson(clientFile, {
    ...client,
    mcpServers: {
      ...asObject(client.mcpServers),
      ostrelio: { command: 'node', args: [gateway, '--config', config], env: { OSTRELIO_API_KEY: options.apiKey, OSTRELIO_BASE_URL: options.baseUrl } },
    },
  }, true);
  const notes = [`The gateway fronts ${upstreams.map((upstream) => upstream.name).join(', ')}. Map each tool you want to govern in ${config} under "actions".`];
  if ((options.unmapped ?? 'deny') === 'deny') notes.push('Tools with no mapping are denied until you map them (or re-run with --unmapped allow for read-only servers).');
  return { files, start: `Restart your MCP client (Cursor, Claude Desktop) or run \`claude\` in ${options.dir}; it starts the gateway from ${clientFile}.`, notes };
}

export function writeHarness(options: ConnectOptions): ConnectResult {
  const packages = options.packagesDir ?? defaultPackagesDir();
  if (options.harness === 'claude-code') return claudeCode(options, packages);
  if (options.harness === 'omp') return omp(options, packages);
  return mcp(options, packages);
}
