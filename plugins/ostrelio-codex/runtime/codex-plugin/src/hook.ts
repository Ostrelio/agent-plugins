/**
 * Codex CLI hook entry. One process per event, JSON on stdin, JSON (or nothing) on stdout.
 *
 *   PreToolUse        authorize Bash, apply_patch, MCP and other local tools   (deny via hookSpecificOutput)
 *   UserPromptSubmit  remember the person's request and start a new execution
 *   PostToolUse       report EXECUTED and keep the tool result as an untrusted input
 *
 * Codex lets a tool run when a hook fails (any exit code other than 0 and 2, a timeout, a crash), so
 * this process never exits with another code: every error becomes a deny on stdout. Codex documents
 * tool hooks as a guardrail, not a complete enforcement boundary (see the README).
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
// Installed as a Codex plugin, the whole plugin folder (manifest, hooks.json, vendored runtime) is enforcement too.
if (process.env.PLUGIN_ROOT) registerEnforcementDir(resolve(process.env.PLUGIN_ROOT));

const DEFAULTS = { agentKey: 'codex-cli', agentName: 'Codex CLI', runtime: 'codex-cli' };
const MAX_READS = 5;

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  turn_id?: string;
  cwd?: string;
  // PreToolUse, PostToolUse
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  // UserPromptSubmit
  prompt?: string;
}

export interface HookOptions { env?: NodeJS.ProcessEnv; store?: SessionStore }

export interface PreToolOutput {
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string };
}

/** Per-session state: the plugin's writable data folder when Codex provides one, else ~/.ostrelio-you. */
export const codexStore = (env: NodeJS.ProcessEnv = process.env): SessionStore =>
  fileStore(env.PLUGIN_DATA ? join(env.PLUGIN_DATA, 'sessions') : join(homedir(), '.ostrelio-you', 'codex-sessions'));

const sessionIdOf = (input: HookInput) => input.session_id?.trim() || 'session';
const cwdOf = (input: HookInput) => input.cwd || process.cwd();
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);

/** Codex's local function tools that are not shell, patch or MCP, mapped to the classifier's names. */
const CODEX_TOOLS: Record<string, string> = {
  update_plan: 'todos', request_user_input: 'ask', view_image: 'Read', spawn_agent: 'Task', exec_command: 'Bash', shell: 'Bash', local_shell: 'Bash',
};

/** What a hook event is, as a tool call the classifier understands. `key` ties PostToolUse to the decision. */
export function toolCall(input: HookInput): { toolName: string; toolInput: unknown; key: string } | null {
  const raw = input.tool_name ?? '';
  if (!raw) return null;
  const args = input.tool_input;
  const key = `tool:${input.tool_use_id || fingerprint([raw, args])}`;
  const command = (args && typeof args === 'object' ? (args as { command?: unknown }).command : undefined);
  const commandText = Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : '';
  if (raw === 'Bash') return { toolName: 'Bash', toolInput: { command: commandText }, key };
  // `tool_input.command` is the whole patch (`*** Begin Patch` … `*** Update File: path` …). The classifier reads the file headers.
  if (raw === 'apply_patch' || raw === 'Edit' || raw === 'Write') return { toolName: 'Edit', toolInput: { patch: commandText }, key };
  return { toolName: CODEX_TOOLS[raw] ?? raw, toolInput: args ?? {}, key };
}

const deny = (reason: string): PreToolOutput => ({
  systemMessage: reason,
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

function resultText(input: HookInput): string {
  const raw = input.tool_response;
  if (typeof raw === 'string') return raw;
  return raw == null ? '' : JSON.stringify(raw);
}

export async function handleHook(input: HookInput, options: HookOptions = {}): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const store = options.store ?? codexStore(env);
  const event = input.hook_event_name ?? '';
  try {
    if (event === 'UserPromptSubmit') return await onPrompt(input, store);
    if (event === 'PostToolUse') return await onResult(input, store, env);
    if (event === 'PreToolUse') return { ...(await onTool(input, store, env)) };
    return {};
  } catch (error) {
    if (event !== 'PreToolUse') return {};
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

async function onTool(input: HookInput, store: SessionStore, env: NodeJS.ProcessEnv): Promise<PreToolOutput> {
  const config = guardConfig(env, DEFAULTS);
  if (!config.apiKey) return deny('Ostrelio: OSTRELIO_API_KEY is not set, so tool calls are blocked. Start Codex from a shell where it is exported.');
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
        principalId: env.USER || 'codex-user', objective: current.request || `Codex session in ${cwd}`,
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
  // A hold is told to the person on stderr at once; the answer carries the same text as systemMessage.
  let heldMessage = '';
  const outcome = await authorizeProposal({
    client, executionId: snapshot.executionId, idempotencyKey: `codex:${sessionId}:${call.key}:${randomUUID()}`,
    proposal, timeoutMs: config.timeoutMs, dashboardUrl: config.dashboardUrl,
    callbacks: { onHold: (hold) => { heldMessage = hold.message; process.stderr.write(`${hold.message}\n`); } },
  });
  const note = (text: string) => (heldMessage ? `${heldMessage}\n${text}` : text);
  if (!outcome.allowed) return deny(note(`Ostrelio ${outcome.outcome.toLowerCase().replace('_', ' ')} in ${formatElapsed(outcome.ms)}. ${outcome.reason}`));
  await store.update(sessionId, (current) => ({
    record: { ...current, decisions: { ...current.decisions, [call.key]: outcome.decisionId } },
    result: undefined,
  }));
  return outcome.outcome === 'APPROVED' ? { systemMessage: note(`Ostrelio approved after ${formatElapsed(outcome.ms)}.`) } : {};
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
    await reportOutcome(client, decisionId, 'EXECUTED', { source: 'codex-cli', input: safeArgs(call.toolInput) }).catch(() => undefined);
  }
  return {};
}

const invokedDirectly = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invokedDirectly) {
  try {
    const raw = readFileSync(0, 'utf8');
    const input = raw.trim() ? JSON.parse(raw) as HookInput : {};
    const output = await handleHook(input);
    // No fields: print nothing (Codex treats exit 0 with no output as success; plain text would become model context).
    if (Object.keys(output).length) process.stdout.write(JSON.stringify(output));
  } catch (error) {
    // Unreadable input: exit 2 with the reason on stderr, which Codex honours as a block.
    process.stderr.write(`${blockedReason(error, guardConfig(process.env, DEFAULTS).baseUrl)}\n`);
    process.exitCode = 2;
  }
}
