/**
 * Gemini CLI hook entry. One process per event, JSON on stdin, one JSON object on stdout.
 *
 *   BeforeTool   authorize the tool call             ({"decision":"allow"} | {"decision":"deny","reason"})
 *   BeforeAgent  remember the person's request and start a new execution
 *   AfterTool    report EXECUTED and keep the tool result as an untrusted input
 *
 * Gemini treats any exit code other than 0 and 2 as a warning and runs the tool anyway, so this
 * process never exits with another code: every error becomes a deny on stdout.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { intentText, registerEnforcementDir, toProposal, untrustedInput, type Proposal } from '../../agent-guard/classify.ts';
import { authorizeProposal, blockedReason, formatElapsed, guardConfig, openExecution, OstrelioClient, reportOutcome, safeArgs } from '../../agent-guard/client.ts';
import { fileStore, type SessionRecord, type SessionStore } from '../../claude-code-plugin/src/session-store.ts';

registerEnforcementDir(dirname(dirname(fileURLToPath(import.meta.url))));

const DEFAULTS = { agentKey: 'gemini-cli', agentName: 'Gemini CLI', runtime: 'gemini-cli' };
const MAX_READS = 5;

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  // BeforeTool, AfterTool
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: { llmContent?: unknown; returnDisplay?: unknown; error?: unknown } & Record<string, unknown>;
  mcp_context?: { server_name?: string; tool_name?: string };
  // BeforeAgent
  prompt?: string;
}

export interface HookOptions { env?: NodeJS.ProcessEnv; store?: SessionStore }

export interface ToolOutput { decision: 'allow' | 'deny'; reason?: string; systemMessage?: string }

export const geminiStore = (): SessionStore => fileStore(join(homedir(), '.ostrelio-you', 'gemini-cli-sessions'));

const sessionIdOf = (input: HookInput) => input.session_id?.trim() || 'session';
const cwdOf = (input: HookInput) => input.cwd || process.env.GEMINI_CWD || process.cwd();
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** Gemini's built-in tool names, mapped to the names the shared classifier knows. */
const GEMINI_TOOLS: Record<string, string> = {
  run_shell_command: 'Bash', read_file: 'Read', read_many_files: 'Read', list_directory: 'Read', glob: 'Glob',
  grep_search: 'Grep', search_file_content: 'Grep', write_file: 'Write', replace: 'Edit', web_fetch: 'WebFetch',
  google_web_search: 'web_search', ask_user: 'ask', write_todos: 'todos',
  // Tools that only touch the CLI's own state (plans, skills, docs, the task tracker, status text).
  activate_skill: 'todos', get_internal_docs: 'todos', enter_plan_mode: 'todos', exit_plan_mode: 'todos', update_topic: 'todos', complete_task: 'todos',
  tracker_create_task: 'todos', tracker_update_task: 'todos', tracker_get_task: 'todos', tracker_list_tasks: 'todos', tracker_add_dependency: 'todos', tracker_visualize: 'todos',
  list_mcp_resources: 'todos',
};

/** Gemini's argument names, renamed to the ones the classifier reads. */
function classifierInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const args = { ...input };
  if (typeof args.dir_path === 'string' && !args.path) args.path = args.dir_path;
  if (toolName === 'read_many_files' && !args.path) {
    const include = Array.isArray(args.include) ? args.include.find((item) => typeof item === 'string') : args.include;
    if (typeof include === 'string') args.path = include;
  }
  if (toolName === 'web_fetch' && !args.url) args.url = /https?:\/\/[^\s)'"<>]+/i.exec(text(args.prompt))?.[0] ?? '';
  return args;
}

/** What a hook event is, as a tool call the classifier understands. `key` ties AfterTool to the decision. */
export function toolCall(input: HookInput): { toolName: string; toolInput: unknown; key: string } | null {
  const raw = input.tool_name ?? '';
  if (!raw) return null;
  const args = input.tool_input ?? {};
  const key = `tool:${fingerprint([raw, args])}`;
  const server = input.mcp_context?.server_name;
  const tool = input.mcp_context?.tool_name;
  // MCP tools: `mcp_<server>_<tool>` by name, with the exact server and tool in mcp_context.
  if (server && tool) return { toolName: `mcp__${server}__${tool}`, toolInput: args, key };
  if (/^mcp_/i.test(raw)) return { toolName: `mcp__${raw.replace(/^mcp_+/i, '')}`, toolInput: args, key };
  return { toolName: GEMINI_TOOLS[raw] ?? raw, toolInput: classifierInput(raw, args), key };
}

const deny = (reason: string): ToolOutput => ({ decision: 'deny', reason, systemMessage: reason });

function resultText(input: HookInput): string {
  const response = input.tool_response;
  if (!response) return '';
  const raw = response.llmContent ?? response.returnDisplay ?? response.error;
  if (typeof raw === 'string') return raw;
  return raw == null ? '' : JSON.stringify(raw);
}

export async function handleHook(input: HookInput, options: HookOptions = {}): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const store = options.store ?? geminiStore();
  const event = input.hook_event_name ?? '';
  try {
    if (event === 'BeforeAgent') return await onPrompt(input, store);
    if (event === 'AfterTool') return await onResult(input, store, env);
    if (event === 'BeforeTool') return { ...(await onTool(input, store, env)) };
    return {};
  } catch (error) {
    if (event !== 'BeforeTool') return {};
    return { ...deny(blockedReason(error, guardConfig(env, DEFAULTS).baseUrl)) };
  }
}

async function onPrompt(input: HookInput, store: SessionStore): Promise<Record<string, unknown>> {
  await store.update(sessionIdOf(input), () => ({
    record: { request: intentText(input.prompt ?? ''), executionId: null, reads: [], decisions: {} },
    result: undefined,
  }));
  return {};
}

async function onTool(input: HookInput, store: SessionStore, env: NodeJS.ProcessEnv): Promise<ToolOutput> {
  const config = guardConfig(env, DEFAULTS);
  if (!config.apiKey) return deny('Ostrelio: OSTRELIO_API_KEY is not set, so tool calls are blocked. Start Gemini CLI from a shell where it is exported (and, if environment redaction is on, listed under security.environmentVariableRedaction.allowed).');
  const call = toolCall(input);
  if (!call) return deny('Ostrelio could not classify this tool call, so it was blocked (missing tool name).');
  const cwd = cwdOf(input);
  let proposal: Proposal;
  try {
    proposal = toProposal(call.toolName, call.toolInput, cwd);
  } catch (error) {
    return deny(`Ostrelio could not classify this tool call, so it was blocked (${error instanceof Error ? error.message : String(error)}).`);
  }
  const client = new OstrelioClient(config.baseUrl, config.apiKey);
  const sessionId = sessionIdOf(input);
  const snapshot = await store.update(sessionId, async (current) => {
    let executionId = current.executionId;
    if (!executionId) {
      executionId = await openExecution(client, {
        agentKey: config.agentKey, agentName: config.agentName, runtime: config.runtime,
        principalId: env.USER || 'gemini-user', objective: current.request || `Gemini CLI session in ${cwd}`,
        ...(config.companyId ? { companyId: config.companyId } : {}),
      });
    }
    const record: SessionRecord = { ...current, executionId };
    return { record, result: { executionId, request: current.request, reads: current.reads.slice() } };
  });
  proposal = {
    ...proposal,
    context: {
      ...proposal.context,
      ...(snapshot.request ? { request: snapshot.request } : {}),
      ...(snapshot.reads.length ? { untrustedInputs: snapshot.reads } : {}),
    },
  };
  // A hold is told to the person on stderr at once (Gemini shows hook stderr); stdout stays one JSON object.
  let heldMessage = '';
  const outcome = await authorizeProposal({
    client, executionId: snapshot.executionId, idempotencyKey: `gemini:${sessionId}:${call.key}:${randomUUID()}`,
    proposal, timeoutMs: config.timeoutMs, dashboardUrl: config.dashboardUrl,
    callbacks: { onHold: (hold) => { heldMessage = hold.message; process.stderr.write(`${hold.message}\n`); } },
  });
  if (!outcome.allowed) {
    return { decision: 'deny', reason: outcome.reason, systemMessage: `${heldMessage ? `${heldMessage}\n` : ''}Ostrelio ${outcome.outcome.toLowerCase().replace('_', ' ')} in ${formatElapsed(outcome.ms)}. ${outcome.reason}` };
  }
  await store.update(sessionId, (current) => ({
    record: { ...current, decisions: { ...current.decisions, [call.key]: outcome.decisionId } },
    result: undefined,
  }));
  return { decision: 'allow', ...(outcome.outcome === 'APPROVED' ? { systemMessage: `${heldMessage ? `${heldMessage}\n` : ''}Ostrelio approved after ${formatElapsed(outcome.ms)}.` } : {}) };
}

async function onResult(input: HookInput, store: SessionStore, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const call = toolCall(input);
  if (!call) return {};
  const seen = untrustedInput(call.toolName, call.toolInput, resultText(input));
  const decisionId = await store.update(sessionIdOf(input), (current) => {
    const reads = seen ? [...current.reads, seen].slice(-MAX_READS) : current.reads;
    const decisions = { ...current.decisions };
    const id = decisions[call.key];
    delete decisions[call.key];
    return { record: { ...current, reads, decisions }, result: id };
  });
  const config = guardConfig(env, DEFAULTS);
  if (decisionId && config.apiKey) {
    const client = new OstrelioClient(config.baseUrl, config.apiKey);
    await reportOutcome(client, decisionId, 'EXECUTED', { source: 'gemini-cli', input: safeArgs(call.toolInput) }).catch(() => undefined);
  }
  return {};
}

const invokedDirectly = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invokedDirectly) {
  try {
    const raw = readFileSync(0, 'utf8');
    const input = raw.trim() ? JSON.parse(raw) as HookInput : {};
    process.stdout.write(JSON.stringify(await handleHook(input)));
  } catch (error) {
    // Unreadable input: block with exit code 2 (a deny Gemini honours without parsing stdout).
    process.stderr.write(`${blockedReason(error, guardConfig(process.env, DEFAULTS).baseUrl)}\n`);
    process.exitCode = 2;
  }
}
