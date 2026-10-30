/**
 * ostrelio-connect <claude-code|omp|mcp> [--url <workspace URL>] [--key <API key>] [--dir <project>]
 * Checks the key, publishes the default agent policies when the workspace has none, writes the
 * harness config and prints the line that starts the agent.
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { HARNESSES, writeHarness, type Harness, type Upstream } from './harness.ts';
import { installDefaultPolicies } from './policies.ts';

const USAGE = `Usage: ostrelio-connect <claude-code|omp|mcp> [options]

  --url <url>          Workspace API origin. Default $OSTRELIO_BASE_URL or http://127.0.0.1:3100.
  --key <key>          Workspace API key (or set OSTRELIO_API_KEY). Create one in Settings -> API keys.
  --dir <path>         Project the agent works in. Default: the current folder.
  --company <id>       Record the agent's actions under this company.
  --skip-policies      Do not publish the default agent policies.
  mcp only:
  --upstream <spec>    "name=command arg ..." MCP server the gateway fronts. Repeat for more.
  --unmapped <mode>    deny (default) or allow tools with no action mapping.
  --mcp-file <path>    Client config to add the entry to. Default <dir>/.mcp.json.
`;

export interface Io { out: (line: string) => void; err: (line: string) => void; fetchFn?: typeof fetch }

export function parseUpstream(spec: string): Upstream {
  const [name, ...rest] = spec.split('=');
  const [command, ...args] = rest.join('=').trim().split(/\s+/).filter(Boolean);
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name) || !command) throw new Error(`--upstream "${spec}" must look like "name=command arg ..." (name: letters, digits, _ or -).`);
  return { name, command, args };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, io: Io = { out: console.log, err: console.error }): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        url: { type: 'string' }, key: { type: 'string' }, dir: { type: 'string' }, company: { type: 'string' },
        'skip-policies': { type: 'boolean' }, upstream: { type: 'string', multiple: true }, unmapped: { type: 'string' },
        'mcp-file': { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) { io.out(USAGE); return 0; }
  const harness = positionals[0] as Harness;
  if (!HARNESSES.includes(harness)) { io.err(`Choose a harness: ${HARNESSES.join(', ')}.\n\n${USAGE}`); return 2; }

  const apiKey = values.key ?? env.OSTRELIO_API_KEY ?? '';
  if (!apiKey) { io.err('No API key. Pass --key or set OSTRELIO_API_KEY. Create one in the dashboard under Settings -> API keys.'); return 2; }
  const baseUrl = (values.url ?? env.OSTRELIO_BASE_URL ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');
  try { new URL(baseUrl); } catch { io.err(`"${baseUrl}" is not a URL.`); return 2; }
  if (values.unmapped && values.unmapped !== 'deny' && values.unmapped !== 'allow') { io.err('--unmapped must be deny or allow.'); return 2; }
  const send = io.fetchFn ?? fetch;

  try {
    const check = await send(`${baseUrl}/v1/executions?limit=1`, { headers: { accept: 'application/json', 'x-api-key': apiKey }, signal: AbortSignal.timeout(10_000) })
      .catch((error: Error) => { throw new Error(`Could not reach Ostrelio at ${baseUrl} (${error.message}). Check --url, or start the server.`); });
    if (check.status === 401 || check.status === 403) throw new Error(`Ostrelio at ${baseUrl} rejected the API key (${check.status}). Create a new one in Settings -> API keys.`);
    if (!check.ok) throw new Error(`Ostrelio at ${baseUrl} answered ${check.status} when checking the key.`);
    io.out(`Connected to ${baseUrl}`);

    if (!values['skip-policies']) {
      const policies = await installDefaultPolicies({ baseUrl, env, fetchFn: send });
      io.out(policies.status === 'installed' ? `Published ${policies.count} default agent policies`
        : policies.status === 'present' ? 'Default agent policies already in this workspace'
          : policies.reason);
    }

    const dir = resolve(values.dir ?? process.cwd());
    const result = writeHarness({
      harness, dir, baseUrl, apiKey,
      ...((values.company ?? env.OSTRELIO_COMPANY_ID) ? { companyId: values.company ?? env.OSTRELIO_COMPANY_ID } : {}),
      upstreams: (values.upstream ?? []).map(parseUpstream),
      unmapped: values.unmapped === 'allow' ? 'allow' : 'deny',
      ...(values['mcp-file'] ? { mcpFile: values['mcp-file'] } : {}),
    });
    for (const file of result.files) io.out(`Wrote ${file}`);
    for (const note of result.notes) io.out(note);
    io.out(`\nStart your agent:\n  ${result.start}`);
    return 0;
  } catch (error) {
    io.err((error as Error).message);
    return 1;
  }
}
