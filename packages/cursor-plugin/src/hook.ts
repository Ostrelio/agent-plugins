/**
 * Cursor hook entry. One process per event, JSON on stdin, a decision on stdout.
 *
 *   beforeShellExecution  authorize a shell command            (permission allow | deny)
 *   beforeMCPExecution    authorize an MCP tool call           (permission allow | deny)
 *   beforeReadFile        authorize a file read                (permission allow | deny)
 *   preToolUse            authorize the other tools (edits, deletes, subagents); hooks.json limits it by matcher
 *   beforeSubmitPrompt    remember the person's request and start a new execution
 *   afterShellExecution, afterMCPExecution, postToolUse   report EXECUTED and keep the tool result
 *
 * A deny returns `{ permission: "deny", user_message, agent_message }`. hooks.json sets failClosed,
 * so a crash or a malformed answer blocks too.
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

const DEFAULTS = { agentKey: 'cursor-agent', agentName: 'Cursor', runtime: 'cursor' };
const MAX_READS = 5;

export interface HookInput {
  hook_event_name?: string;
  conversation_id?: string;
  generation_id?: string;
  workspace_roots?: string[];
  cwd?: string;
  // beforeShellExecution, afterShellExecution
  command?: string;
  output?: string;
  // beforeMCPExecution, afterMCPExecution
  server?: string;
  tool_name?: string;
  tool_input?: unknown;
  result_json?: unknown;
  // beforeReadFile
  file_path?: string;
  // preToolUse, postToolUse
  tool_use_id?: string;
  tool_output?: unknown;
  // beforeSubmitPrompt
  prompt?: string;
}

export interface HookOptions { env?: NodeJS.ProcessEnv; store?: SessionStore }

export interface PermissionOutput { permission: 'allow' | 'deny'; user_message?: string; agent_message?: string }

const BLOCKING = new Set(['beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'preToolUse']);

/** The session store sits next to Claude Code's, in its own folder. */
export const cursorStore = (): SessionStore => fileStore(join(homedir(), '.ostrelio-you', 'cursor-sessions'));

const sessionIdOf = (input: HookInput) => input.conversation_id?.trim() || 'conversation';
const cwdOf = (input: HookInput) => input.cwd || input.workspace_roots?.[0] || process.cwd();
const fingerprint = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex').slice(0, 16);

/** Cursor's `tool_input` for an MCP call is a JSON string; anything else is used as it comes. */
function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value) as unknown; } catch { return { raw: value }; }
}

/** Cursor's own tool names, mapped to the names the shared classifier knows. */
const CURSOR_TOOLS: Record<string, string> = {
  shell: 'Bash', read: 'Read', write: 'Write', delete: 'delete', grep: 'Grep', glob: 'Glob',
  strreplace: 'Edit', edit: 'Edit', multiedit: 'MultiEdit', editnotebook: 'NotebookEdit', task: 'Task',
};

/** What a hook event is, as a tool call the classifier understands. `key` ties the after-hook to the decision. */
export function toolCall(input: HookInput): { toolName: string; toolInput: unknown; key: string } | null {
  switch (input.hook_event_name) {
    case 'beforeShellExecution': case 'afterShellExecution':
      return { toolName: 'Bash', toolInput: { command: input.command ?? '' }, key: `shell:${fingerprint(input.command)}` };
    case 'beforeMCPExecution': case 'afterMCPExecution': {
      const args = parseJson(input.tool_input);
      return { toolName: `mcp__${input.server || 'mcp'}__${input.tool_name || 'tool'}`, toolInput: args, key: `mcp:${fingerprint([input.server, input.tool_name, args])}` };
    }
    case 'beforeReadFile':
      return { toolName: 'Read', toolInput: { file_path: input.file_path ?? '' }, key: `read:${fingerprint(input.file_path)}` };
    case 'preToolUse': case 'postToolUse': {
      const raw = input.tool_name ?? '';
      if (!raw) return null;
      // MCP tools arrive as `MCP:<tool>`; the classifier keeps their name as its own action type.
      const toolName = /^mcp[:_]/i.test(raw) ? `mcp__${raw.replace(/^mcp[:_]+/i, '')}` : CURSOR_TOOLS[raw.toLowerCase()] ?? raw;
      return { toolName, toolInput: parseJson(input.tool_input), key: `tool:${input.tool_use_id || fingerprint([raw, input.tool_input])}` };
    }
    default: return null;
  }
}

const decide = (permission: 'allow' | 'deny', agentMessage: string, userMessage?: string): PermissionOutput => ({
  permission, ...(userMessage ? { user_message: userMessage } : {}), ...(agentMessage ? { agent_message: agentMessage } : {}),
});
const deny = (reason: string): PermissionOutput => decide('deny', reason, reason);

function resultText(input: HookInput): string {
  const raw = input.output ?? input.result_json ?? input.tool_output;
  if (typeof raw === 'string') return raw;
  return raw == null ? '' : JSON.stringify(raw);
}

export async function handleHook(input: HookInput, options: HookOptions = {}): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const store = options.store ?? cursorStore();
  const event = input.hook_event_name ?? '';
  try {
    if (event === 'beforeSubmitPrompt') return await onPrompt(input, store);
    if (event === 'afterShellExecution' || event === 'afterMCPExecution' || event === 'postToolUse') return await onResult(input, store, env);
    if (BLOCKING.has(event)) return await onTool(input, store, env);
    return {};
  } catch (error) {
    if (!BLOCKING.has(event)) return {};
    return deny(blockedReason(error, guardConfig(env, DEFAULTS).baseUrl));
  }
}

async function onPrompt(input: HookInput, store: SessionStore): Promise<Record<string, unknown>> {
  await store.update(sessionIdOf(input), () => ({
    record: { request: intentText(input.prompt ?? ''), executionId: null, reads: [], decisions: {} },
    result: undefined,
  }));
  return { continue: true };
}

async function onTool(input: HookInput, store: SessionStore, env: NodeJS.ProcessEnv): Promise<PermissionOutput> {
  const config = guardConfig(env, DEFAULTS);
  if (!config.apiKey) return deny('Ostrelio: OSTRELIO_API_KEY is not set, so tool calls are blocked. Start Cursor from a shell where it is exported.');
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
        principalId: env.USER || 'cursor-user', objective: current.request || `Cursor session in ${cwd}`,
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
  // A hold is told to the person at once on stderr (Cursor's Hooks output channel); the answer
  // carries the same text and the wait as `user_message`.
  let heldMessage = '';
  const outcome = await authorizeProposal({
    client, executionId: snapshot.executionId, idempotencyKey: `cursor:${sessionId}:${call.key}:${randomUUID()}`,
    proposal, timeoutMs: config.timeoutMs, dashboardUrl: config.dashboardUrl,
    callbacks: { onHold: (hold) => { heldMessage = hold.message; process.stderr.write(`${hold.message}\n`); } },
  });
  const note = (text: string) => (heldMessage ? `${heldMessage}\n${text}` : text);
  if (!outcome.allowed) return decide('deny', outcome.reason, note(`Ostrelio ${outcome.outcome.toLowerCase().replace('_', ' ')} in ${formatElapsed(outcome.ms)}. ${outcome.reason}`));
  await store.update(sessionId, (current) => ({
    record: { ...current, decisions: { ...current.decisions, [call.key]: outcome.decisionId } },
    result: undefined,
  }));
  return decide('allow', '', outcome.outcome === 'APPROVED' ? note(`Ostrelio approved after ${formatElapsed(outcome.ms)}.`) : undefined);
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
    await reportOutcome(client, decisionId, 'EXECUTED', { source: 'cursor', input: safeArgs(call.toolInput) }).catch(() => undefined);
  }
  return {};
}

const invokedDirectly = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invokedDirectly) {
  let output: Record<string, unknown> = {};
  let event = '';
  try {
    const raw = readFileSync(0, 'utf8');
    const input = raw.trim() ? JSON.parse(raw) as HookInput : {};
    event = input.hook_event_name ?? '';
    output = await handleHook(input);
  } catch (error) {
    output = BLOCKING.has(event) || !event ? deny(blockedReason(error, guardConfig(process.env, DEFAULTS).baseUrl)) : {};
  }
  process.stdout.write(JSON.stringify(output));
}
