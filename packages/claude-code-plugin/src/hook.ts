/**
 * Claude Code hook entry. One process per event, JSON on stdin, a decision on stdout.
 *
 *   PreToolUse          classify and authorize (ALLOW / DENY / wait for REQUIRE_APPROVAL)
 *   UserPromptSubmit    remember the person's request and start a new execution
 *   PostToolUse         report EXECUTED and keep the last five tool results
 *   PostToolUseFailure  report FAILED and keep the error text the same way
 *   Stop                print the session summary: counts, what is still waiting, and the timeline link
 *
 * A held call is approved or rejected from another terminal with `ostrelio approve <id>` (a reviewer
 * session from `ostrelio login`, never the agent key); statusline.ts shows live counts.
 *
 * Exit 0 with permissionDecision "deny" blocks a tool and shows the reason to the model.
 * hooks.json sets onFailure "block", so a crash blocks too.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { intentText, registerEnforcementDir, toProposal, untrustedInput, type Proposal } from '../../agent-guard/classify.ts';
import { authorizeProposal, blockedReason, cliCommand, formatElapsed, guardConfig, openExecution, OstrelioClient, reportOutcome, safeArgs } from '../../agent-guard/client.ts';
import { cachedDenial, hasActivity, holdBegan, recordOutcome, startRun, summaryText } from '../../agent-guard/ledger.ts';
import { loadReviewerSession } from '../../agent-guard/reviewer.ts';
import { fileStore, type SessionRecord, type SessionStore } from './session-store.ts';

registerEnforcementDir(dirname(dirname(fileURLToPath(import.meta.url))));

const DEFAULTS = { agentKey: 'claude-code-agent', agentName: 'Claude Code', runtime: 'claude-code' };
const MAX_READS = 5;

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  prompt?: string;
  transcript_path?: string;
  error?: string;
}

export interface HookOptions {
  env?: NodeJS.ProcessEnv;
  store?: SessionStore;
  readTranscript?: (path: string) => Promise<string>;
}

interface PreOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason: string;
  };
  /** Shown to the person (not the model): the hold's reason and approval link, or how long the wait took. */
  systemMessage?: string;
}

const pre = (permissionDecision: 'allow' | 'deny', permissionDecisionReason: string): PreOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason },
});

/** Text of a Claude Code tool response or failure, for the untrusted-input window. */
export function responseText(response: unknown, error?: string): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return response == null ? '' : JSON.stringify(response);
  const record = response as Record<string, unknown>;
  if (typeof record.stdout === 'string' || typeof record.stderr === 'string') {
    return [record.stdout, record.stderr].filter((part) => typeof part === 'string' && part.trim()).join('\n');
  }
  return JSON.stringify(response);
}

/** The last assistant message in a Claude Code transcript, capped the same way omp caps agentSaid. */
export function assistantSaid(transcript: string): string {
  const lines = transcript.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let row: { type?: string; message?: { role?: string; content?: unknown }; content?: unknown };
    try { row = JSON.parse(line) as typeof row; } catch { continue; }
    const message = row.message ?? {};
    if (row.type !== 'assistant' && message.role !== 'assistant') continue;
    const content = message.content ?? row.content;
    const text = Array.isArray(content)
      ? content.filter((part) => part && typeof part === 'object' && (part as { type?: string }).type === 'text' && typeof (part as { text?: string }).text === 'string').map((part) => (part as { text: string }).text).join(' ')
      : typeof content === 'string' ? content : '';
    if (text.trim()) return intentText(text);
  }
  return '';
}

async function readTranscriptFile(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

function sessionIdOf(input: HookInput): string {
  return input.session_id?.trim() || 'session';
}

export async function handleHook(input: HookInput, options: HookOptions = {}): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const store = options.store ?? fileStore();
  const event = input.hook_event_name ?? '';
  try {
    if (event === 'UserPromptSubmit') return await onPrompt(input, store);
    if (event === 'PostToolUse') return await onResult(input, store, env, 'EXECUTED');
    if (event === 'PostToolUseFailure') return await onResult(input, store, env, 'FAILED');
    if (event === 'Stop') return await onStop(input, store, env);
    if (event === 'PreToolUse') return await onTool(input, store, env, options.readTranscript ?? readTranscriptFile);
    return {};
  } catch (error) {
    if (event !== 'PreToolUse') return {};
    return pre('deny', blockedReason(error, guardConfig(env, DEFAULTS).baseUrl));
  }
}

async function onPrompt(input: HookInput, store: SessionStore): Promise<Record<string, unknown>> {
  await store.update(sessionIdOf(input), (current) => ({
    record: { request: intentText(input.prompt ?? ''), executionId: null, reads: [], decisions: {}, ledger: startRun(current.ledger) },
    result: undefined,
  }));
  return {};
}

/** The agent finished: what Ostrelio decided this run, anything still waiting, and where to see it. */
async function onStop(input: HookInput, store: SessionStore, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const config = guardConfig(env, DEFAULTS);
  const record = await store.update(sessionIdOf(input), (current) => ({ record: current, result: current }));
  if (!hasActivity(record.ledger)) return {};
  return { systemMessage: summaryText(record.ledger, { dashboardUrl: config.dashboardUrl, agentId: config.agentKey, executionId: record.executionId, approveCommand: cliCommand('approve') }) };
}

async function onTool(
  input: HookInput, store: SessionStore, env: NodeJS.ProcessEnv, readTranscript: (path: string) => Promise<string>,
): Promise<PreOutput> {
  const config = guardConfig(env, DEFAULTS);
  if (!config.apiKey) return pre('deny', 'Ostrelio: OSTRELIO_API_KEY is not set, so tool calls are blocked.');
  const cwd = input.cwd || process.cwd();
  const toolName = input.tool_name || '';
  if (!toolName) return pre('deny', 'Ostrelio could not classify this tool call, so it was blocked (missing tool_name).');
  let proposal: Proposal;
  try {
    proposal = toProposal(toolName, input.tool_input, cwd);
  } catch (error) {
    return pre('deny', `Ostrelio could not classify this tool call, so it was blocked (${error instanceof Error ? error.message : String(error)}).`);
  }
  let agentSaid = '';
  if (input.transcript_path) {
    try { agentSaid = assistantSaid(await readTranscript(input.transcript_path)); } catch { agentSaid = ''; }
  }
  const client = new OstrelioClient(config.baseUrl, config.apiKey);
  const sessionId = sessionIdOf(input);
  const snapshot = await store.update(sessionId, async (current) => {
    let executionId = current.executionId;
    if (!executionId) {
      executionId = await openExecution(client, {
        agentKey: config.agentKey, agentName: config.agentName, runtime: config.runtime,
        principalId: env.USER || 'claude-user', objective: current.request || `Claude Code session in ${cwd}`,
        ...(config.companyId ? { companyId: config.companyId } : {}),
      });
    }
    const record: SessionRecord = { ...current, executionId };
    return { record, result: { executionId, request: current.request, reads: current.reads.slice(), ledger: current.ledger } };
  });
  proposal = {
    ...proposal,
    context: {
      ...proposal.context,
      ...(snapshot.request ? { request: snapshot.request } : {}),
      ...(agentSaid ? { agentSaid } : {}),
      ...(snapshot.reads.length ? { untrustedInputs: snapshot.reads } : {}),
    },
  };
  const toolCallId = input.tool_use_id || `${toolName}:0`;
  // An identical call that was already denied in this session is answered here, without asking Ostrelio again.
  const repeated = cachedDenial(snapshot.ledger, proposal);
  if (repeated) {
    await store.update(sessionId, (current) => ({ record: { ...current, ledger: recordOutcome(current.ledger, { proposal, outcome: 'REPEAT', ms: 0, at: Date.now() }) }, result: undefined }));
    return { ...pre('deny', repeated), systemMessage: 'Ostrelio blocked a repeat of a call it already denied (answered locally, Ostrelio was not asked again).' };
  }
  // A hold is told to the person at once on stderr (Claude Code shows hook stderr in verbose mode and
  // `claude -p` prints it); the result also carries a systemMessage with the link and the wait. The
  // call is recorded as pending so the status line and the Stop summary can show what is waiting.
  let heldMessage = '';
  let recorded: Promise<void> = Promise.resolve();
  const outcome = await authorizeProposal({
    client, executionId: snapshot.executionId, idempotencyKey: `claude:${sessionId}:${toolCallId}`,
    proposal, timeoutMs: config.timeoutMs, dashboardUrl: config.dashboardUrl,
    callbacks: {
      onHold: (hold) => {
        heldMessage = hold.message;
        recorded = store.update(sessionId, (current) => ({ record: { ...current, ledger: holdBegan(current.ledger, proposal, hold.approvalId, Date.now()) }, result: undefined }));
        void loadReviewerSession(env).then((reviewer) => {
          const hint = reviewer ? '' : `\nRun \`${cliCommand('login')}\` once to approve from the terminal.`;
          process.stderr.write(`${hold.message}${hint}\n`);
        });
      },
    },
  });
  await recorded;
  await store.update(sessionId, (current) => ({
    record: {
      ...current,
      ledger: recordOutcome(current.ledger, {
        proposal, outcome: outcome.outcome, ms: outcome.ms, at: Date.now(),
        ...(outcome.approvalId ? { approvalId: outcome.approvalId } : {}), ...(outcome.allowed ? {} : { message: outcome.reason }),
      }),
      ...(outcome.allowed ? { decisions: { ...current.decisions, [toolCallId]: outcome.decisionId } } : {}),
    },
    result: undefined,
  }));
  const note = (text: string) => ({ systemMessage: heldMessage ? `${heldMessage}\n${text}` : text });
  if (!outcome.allowed) return { ...pre('deny', outcome.reason), ...note(`Ostrelio ${outcome.outcome.toLowerCase().replace('_', ' ')} in ${formatElapsed(outcome.ms)}.`) };
  return { ...pre('allow', 'Allowed by Ostrelio.'), ...(outcome.outcome === 'APPROVED' ? note(`Ostrelio approved after ${formatElapsed(outcome.ms)}.`) : {}) };
}

async function onResult(
  input: HookInput, store: SessionStore, env: NodeJS.ProcessEnv, outcome: 'EXECUTED' | 'FAILED',
): Promise<Record<string, unknown>> {
  const seen = untrustedInput(input.tool_name || 'tool', input.tool_input, responseText(input.tool_response, input.error));
  const toolCallId = input.tool_use_id || '';
  const decisionId = await store.update(sessionIdOf(input), (current) => {
    const reads = seen ? [...current.reads, seen].slice(-MAX_READS) : current.reads;
    const decisions = { ...current.decisions };
    const id = toolCallId ? decisions[toolCallId] : undefined;
    if (toolCallId) delete decisions[toolCallId];
    return { record: { ...current, reads, decisions }, result: id };
  });
  if (decisionId) {
    const config = guardConfig(env, DEFAULTS);
    if (config.apiKey) {
      const client = new OstrelioClient(config.baseUrl, config.apiKey);
      await reportOutcome(client, decisionId, outcome, { source: 'claude-code', input: safeArgs(input.tool_input) }).catch(() => undefined);
    }
  }
  return {};
}

const invokedDirectly = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invokedDirectly) {
  let output: Record<string, unknown> = {};
  try {
    const raw = readFileSync(0, 'utf8');
    const input = raw.trim() ? JSON.parse(raw) as HookInput : {};
    output = await handleHook(input);
  } catch (error) {
    output = pre('deny', blockedReason(error, guardConfig(process.env, DEFAULTS).baseUrl));
  }
  process.stdout.write(JSON.stringify(output));
}
