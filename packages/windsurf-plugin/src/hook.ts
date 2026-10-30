/**
 * Windsurf (Cascade) hook entry. One process per event, JSON on stdin; a block is exit code 2 with the
 * reason on stderr (the only way Windsurf lets a pre-hook block).
 *
 *   pre_run_command, pre_read_code, pre_write_code, pre_mcp_tool_use   authorize the action
 *   pre_user_prompt                                                    remember the request, start a new execution
 *   post_run_command, post_write_code, post_read_code, post_mcp_tool_use   report EXECUTED (and keep an MCP result)
 *
 * Windsurf runs the action when a hook exits with any other non-zero code, so every error here ends in
 * exit 2.
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

const DEFAULTS = { agentKey: 'windsurf-cascade', agentName: 'Windsurf', runtime: 'windsurf' };
const MAX_READS = 5;

export interface HookInput {
  agent_action_name?: string;
  trajectory_id?: string;
  execution_id?: string;
  tool_info?: {
    command_line?: string; cwd?: string;
    file_path?: string; edits?: Array<{ old_string?: string; new_string?: string }>;
    mcp_server_name?: string; mcp_tool_name?: string; mcp_tool_arguments?: unknown; mcp_result?: unknown;
    user_prompt?: string;
  };
}

export interface HookOptions { env?: NodeJS.ProcessEnv; store?: SessionStore; cwd?: string }

/** `block` true means exit 2 with `message` on stderr. `message` may also be an allow note (a held call that was approved). */
export interface HookResult { block: boolean; message: string }

const PRE = new Set(['pre_run_command', 'pre_read_code', 'pre_write_code', 'pre_mcp_tool_use']);
const POST: Record<string, string> = { post_run_command: 'pre_run_command', post_read_code: 'pre_read_code', post_write_code: 'pre_write_code', post_mcp_tool_use: 'pre_mcp_tool_use' };

export const windsurfStore = (): SessionStore => fileStore(join(homedir(), '.ostrelio-you', 'windsurf-sessions'));

const sessionIdOf = (input: HookInput) => input.trajectory_id?.trim() || 'trajectory';
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);

/** The pre-event an action belongs to, so a post-hook finds the decision its pre-hook stored. */
const baseEvent = (name: string) => POST[name] ?? name;

/** What a hook event is, as a tool call the classifier understands. `key` ties the post-hook to the decision. */
export function toolCall(input: HookInput): { toolName: string; toolInput: unknown; key: string; cwd?: string } | null {
  const info = input.tool_info ?? {};
  switch (baseEvent(input.agent_action_name ?? '')) {
    case 'pre_run_command':
      return { toolName: 'Bash', toolInput: { command: info.command_line ?? '' }, key: `run:${fingerprint([info.command_line, info.cwd])}`, ...(info.cwd ? { cwd: info.cwd } : {}) };
    case 'pre_read_code':
      return { toolName: 'Read', toolInput: { file_path: info.file_path ?? '' }, key: `read:${fingerprint(info.file_path)}` };
    case 'pre_write_code':
      return { toolName: 'Edit', toolInput: { file_path: info.file_path ?? '', edits: info.edits ?? [] }, key: `write:${fingerprint([info.file_path, info.edits])}` };
    case 'pre_mcp_tool_use':
      return {
        toolName: `mcp__${info.mcp_server_name || 'mcp'}__${info.mcp_tool_name || 'tool'}`, toolInput: info.mcp_tool_arguments ?? {},
        key: `mcp:${fingerprint([info.mcp_server_name, info.mcp_tool_name, info.mcp_tool_arguments])}`,
      };
    default: return null;
  }
}

const block = (message: string): HookResult => ({ block: true, message });
const pass = (message = ''): HookResult => ({ block: false, message });

export async function handleHook(input: HookInput, options: HookOptions = {}): Promise<HookResult> {
  const env = options.env ?? process.env;
  const store = options.store ?? windsurfStore();
  const event = input.agent_action_name ?? '';
  try {
    if (event === 'pre_user_prompt') return await onPrompt(input, store);
    if (event in POST) return await onResult(input, store, env);
    if (PRE.has(event)) return await onTool(input, store, env, options.cwd ?? process.cwd());
    return pass();
  } catch (error) {
    if (!PRE.has(event)) return pass();
    return block(blockedReason(error, guardConfig(env, DEFAULTS).baseUrl));
  }
}

async function onPrompt(input: HookInput, store: SessionStore): Promise<HookResult> {
  await store.update(sessionIdOf(input), () => ({
    record: { request: intentText(input.tool_info?.user_prompt ?? ''), executionId: null, reads: [], decisions: {} },
    result: undefined,
  }));
  return pass();
}

async function onTool(input: HookInput, store: SessionStore, env: NodeJS.ProcessEnv, defaultCwd: string): Promise<HookResult> {
  const config = guardConfig(env, DEFAULTS);
  if (!config.apiKey) return block('Ostrelio: OSTRELIO_API_KEY is not set, so tool calls are blocked. Start Windsurf from a shell where it is exported (for example `windsurf .`).');
  const call = toolCall(input);
  if (!call) return block('Ostrelio could not classify this action, so it was blocked.');
  const cwd = call.cwd || defaultCwd;
  let proposal: Proposal;
  try {
    proposal = toProposal(call.toolName, call.toolInput, cwd);
  } catch (error) {
    return block(`Ostrelio could not classify this action, so it was blocked (${error instanceof Error ? error.message : String(error)}).`);
  }
  const client = new OstrelioClient(config.baseUrl, config.apiKey);
  const sessionId = sessionIdOf(input);
  const snapshot = await store.update(sessionId, async (current) => {
    let executionId = current.executionId;
    if (!executionId) {
      executionId = await openExecution(client, {
        agentKey: config.agentKey, agentName: config.agentName, runtime: config.runtime,
        principalId: env.USER || 'windsurf-user', objective: current.request || `Windsurf session in ${cwd}`,
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
  // A hold is told to the person on stderr at once (visible with show_output); an approved call exits 0 with the same text.
  let heldMessage = '';
  const outcome = await authorizeProposal({
    client, executionId: snapshot.executionId, idempotencyKey: `windsurf:${sessionId}:${call.key}:${randomUUID()}`,
    proposal, timeoutMs: config.timeoutMs, dashboardUrl: config.dashboardUrl,
    callbacks: { onHold: (hold) => { heldMessage = hold.message; process.stderr.write(`${hold.message}\n`); } },
  });
  if (!outcome.allowed) return block(`Ostrelio ${outcome.outcome.toLowerCase().replace('_', ' ')} in ${formatElapsed(outcome.ms)}. ${outcome.reason}`);
  await store.update(sessionId, (current) => ({
    record: { ...current, decisions: { ...current.decisions, [call.key]: outcome.decisionId } },
    result: undefined,
  }));
  return pass(outcome.outcome === 'APPROVED' ? `${heldMessage ? `${heldMessage}\n` : ''}Ostrelio approved after ${formatElapsed(outcome.ms)}.` : '');
}

async function onResult(input: HookInput, store: SessionStore, env: NodeJS.ProcessEnv): Promise<HookResult> {
  const call = toolCall(input);
  if (!call) return pass();
  // Only post_mcp_tool_use carries a result; the other post-hooks have none (no command output, no file content).
  const result = input.tool_info?.mcp_result;
  const seen = untrustedInput(call.toolName, call.toolInput, typeof result === 'string' ? result : result == null ? '' : JSON.stringify(result));
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
    await reportOutcome(client, decisionId, 'EXECUTED', { source: 'windsurf', input: safeArgs(call.toolInput) }).catch(() => undefined);
  }
  return pass();
}

const invokedDirectly = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invokedDirectly) {
  let result: HookResult;
  try {
    const raw = readFileSync(0, 'utf8');
    result = await handleHook(raw.trim() ? JSON.parse(raw) as HookInput : {});
  } catch (error) {
    result = block(blockedReason(error, guardConfig(process.env, DEFAULTS).baseUrl));
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.block ? 2 : 0;
}
