/**
 * Ostrelio for oh-my-pi (omp) and pi: every tool call the agent makes is sent to Ostrelio before it
 * runs. ALLOW runs it, DENY blocks it, and REQUIRE_APPROVAL holds the call until a person approves
 * it in the Ostrelio dashboard. The harness runs this hook, not the model, so a prompt cannot skip it.
 *
 *   OSTRELIO_API_KEY=ost_test_... omp -e /path/to/packages/omp-plugin/ostrelio.ts
 *
 * Env: OSTRELIO_API_KEY (required), OSTRELIO_BASE_URL (default http://127.0.0.1:3100),
 * OSTRELIO_AGENT_KEY / OSTRELIO_AGENT_NAME (default omp-agent / "omp agent"), OSTRELIO_COMPANY_ID,
 * OSTRELIO_APPROVAL_TIMEOUT_SECONDS (default 600), OSTRELIO_DASHBOARD_URL (default http://localhost:3000;
 * a held call shows `<dashboard>/platform/approvals?approvalId=<id>` where the person approves it). If Ostrelio cannot be reached, the call is blocked.
 *
 * At the terminal: a held call opens an Approve / Reject prompt (omp's own ui.select, handled here, never by
 * the model) when you have run `ostrelio login`; the status line counts allowed / held / denied for the
 * session; `/ostrelio` shows status and approves or rejects by id; a summary prints when the agent finishes;
 * and an identical call that was already denied is answered from a local cache.
 *
 * Classification and the Ostrelio client live in @ostrelio/agent-guard. This file is the omp hook.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { intentText, registerEnforcementDir, resultText, toProposal, type Proposal } from '../agent-guard/classify.ts';
import { authorizeProposal, blockedReason, cliCommand, guardConfig, openExecution, OstrelioClient, OstrelioUnreachable, reportOutcome, safeArgs, type HoldInfo } from '../agent-guard/client.ts';
import { cachedDenial, emptyLedger, hasActivity, holdBegan, recordOutcome, startRun, statusText, summaryText, type Ledger } from '../agent-guard/ledger.ts';
import { reviewerClient } from '../agent-guard/reviewer.ts';

export { blockedReason, OstrelioUnreachable, resultText, toProposal };
export { patchFiles, programsOf } from '../agent-guard/classify.ts';

registerEnforcementDir(dirname(fileURLToPath(import.meta.url)));

/** The slice of omp's extension API this plugin uses. `ui` is absent in headless runs. */
interface HookContext {
  cwd?: string;
  /** False in print mode (omp -p), where `ui` exists but shows nothing. */
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level?: string) => void;
    setStatus?: (key: string, text: string | undefined) => void;
    select?: (title: string, options: string[], dialog?: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>;
  };
}
interface ToolCallEvent { toolName: string; toolCallId: string; input: unknown }
interface ToolResultEvent { toolCallId: string; toolName?: string; isError?: boolean; input?: unknown; content?: Array<{ type?: string; text?: string }> }
interface AgentStartEvent { prompt?: string }
interface AgentEndEvent { isTerminal?: boolean }
interface AssistantMessageEvent { message?: { content?: Array<{ type?: string; text?: string }> } }
type HookResult = { block: true; reason: string } | undefined;
interface ExtensionApi {
  on(event: 'tool_call', handler: (event: ToolCallEvent, ctx: HookContext) => Promise<HookResult>): void;
  on(event: 'tool_result', handler: (event: ToolResultEvent, ctx: HookContext) => Promise<undefined>): void;
  on(event: 'before_agent_start', handler: (event: AgentStartEvent, ctx: HookContext) => Promise<undefined>): void;
  on(event: 'assistant_message', handler: (event: AssistantMessageEvent, ctx: HookContext) => Promise<undefined>): void;
  on(event: 'agent_end', handler: (event: AgentEndEvent, ctx: HookContext) => Promise<undefined>): void;
  registerCommand(name: string, command: { description: string; handler: (args: string, ctx: HookContext) => Promise<void> }): void;
}

const MAX_READ_RESULTS = 5;

export default function ostrelio(pi: ExtensionApi): void {
  const config = guardConfig(process.env, { agentKey: 'omp-agent', agentName: 'omp agent', runtime: 'omp' });
  const client = new OstrelioClient(config.baseUrl, config.apiKey);
  const decisions = new Map<string, string>();
  // omp's tool-call ids are only unique within a session, so idempotency keys carry a session nonce.
  const session = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
  let execution: Promise<string> | null = null;
  let executionId: string | null = null;
  let ledger: Ledger = emptyLedger();
  let summarized = false;
  // What the user asked for and what the agent last said, so reviewers and Laya judge each call
  // against the request it is meant to serve (a mismatch is how an injected instruction shows up).
  let request = '';
  let agentSaid = '';
  // What the agent has read during this request (file contents, command output, web pages). It is
  // the usual carrier of an injected instruction, so reviewers see it as untrusted input.
  let readSoFar: Array<{ source: string; text: string }> = [];

  // Each user request is its own execution, whose objective is the request itself.
  pi.on('before_agent_start', async (event) => {
    request = intentText(event.prompt ?? '');
    agentSaid = '';
    readSoFar = [];
    execution = null;
    executionId = null;
    summarized = false;
    ledger = startRun(ledger);
    return undefined;
  });
  pi.on('assistant_message', async (event) => {
    const text = (event.message?.content ?? []).filter((part) => part.type === 'text' && part.text).map((part) => part.text).join(' ');
    if (text.trim()) agentSaid = intentText(text);
    return undefined;
  });

  const openedExecution = (cwd: string) => {
    execution ??= openExecution(client, {
      agentKey: config.agentKey, agentName: config.agentName, runtime: config.runtime,
      principalId: process.env.USER ?? 'omp-user', objective: request || `omp session in ${cwd}`,
      ...(config.companyId ? { companyId: config.companyId } : {}),
    }).then((id) => { executionId = id; return id; }).catch((error: unknown) => { execution = null; throw error; });
    return execution;
  };

  // Interactive runs show a notification; headless runs (omp -p, where hasUI is false) print to stderr.
  const say = (ctx: HookContext, message: string, level: 'info' | 'warning' | 'error' = 'info') => {
    if (ctx?.ui?.notify && ctx.hasUI !== false) {
      try { ctx.ui.notify(message, level); return; } catch { /* fall through to stderr */ }
    }
    process.stderr.write(`${message}\n`);
  };
  const status = (ctx: HookContext, text: string | undefined) => {
    try { ctx?.ui?.setStatus?.('ostrelio', text); } catch { /* headless */ }
  };

  const showCounts = (ctx: HookContext) => status(ctx, statusText(ledger));

  // A held call: the person can approve or reject it right here. The prompt is omp's own ui.select, answered
  // by the person at the terminal and acted on by this extension as the signed-in reviewer (`ostrelio login`),
  // never with the agent's key. It closes by itself if the call is decided in the dashboard first.
  const offerReview = (ctx: HookContext, hold: HoldInfo): (() => void) => {
    const closed = new AbortController();
    void (async () => {
      const reviewer = await reviewerClient(process.env);
      if (!reviewer) { say(ctx, 'Ostrelio: run `ostrelio login` to approve or reject held calls in this terminal.', 'warning'); return; }
      if (!ctx.ui?.select || ctx.hasUI === false) return;
      const choice = await ctx.ui.select(`Ostrelio is holding ${hold.what}\n${hold.reason}`, ['Approve', 'Reject', 'Decide in the dashboard'], { signal: closed.signal });
      if (choice !== 'Approve' && choice !== 'Reject') return;
      await reviewer.review(hold.approvalId, choice === 'Approve' ? 'approve' : 'reject', 'omp');
      say(ctx, `Ostrelio: ${choice === 'Approve' ? 'approved' : 'rejected'} ${hold.what} from this terminal.`);
    })().catch((error: unknown) => say(ctx, `Ostrelio: could not review from this terminal (${error instanceof Error ? error.message : String(error)}).`, 'error'));
    return () => closed.abort();
  };

  // omp can raise tool_call more than once for the same call (an early preflight and again before it
  // runs), and the agent's words can change in between. Decide once per call and reuse the answer.
  const inFlight = new Map<string, Promise<HookResult>>();
  pi.on('tool_call', (event, ctx) => {
    const known = inFlight.get(event.toolCallId);
    if (known) return known;
    const decided = decide(event, ctx);
    inFlight.set(event.toolCallId, decided);
    if (inFlight.size > 500) inFlight.delete(inFlight.keys().next().value as string);
    return decided;
  });

  async function decide(event: ToolCallEvent, ctx: HookContext): Promise<HookResult> {
    if (!config.apiKey) return { block: true, reason: 'Ostrelio: OSTRELIO_API_KEY is not set, so tool calls are blocked.' };
    const cwd = ctx?.cwd ?? process.cwd();
    let proposal: Proposal;
    try {
      const base = toProposal(event.toolName, event.input, cwd);
      proposal = {
        ...base,
        context: {
          ...base.context, ...(request ? { request } : {}), ...(agentSaid ? { agentSaid } : {}),
          ...(readSoFar.length ? { untrustedInputs: readSoFar.slice() } : {}),
        },
      };
    } catch (error) {
      // A call the plugin cannot classify never runs.
      return { block: true, reason: `Ostrelio could not classify this tool call, so it was blocked (${error instanceof Error ? error.message : String(error)}).` };
    }
    // The same call was already denied in this session: answer from here, without asking Ostrelio again.
    const repeated = cachedDenial(ledger, proposal);
    if (repeated) {
      ledger = recordOutcome(ledger, { proposal, outcome: 'REPEAT', ms: 0, at: Date.now() });
      showCounts(ctx);
      if (process.env.OSTRELIO_DEBUG_TIMING) process.stderr.write(`[ostrelio-timing] ${event.toolName} REPEAT 0\n`);
      return { block: true, reason: repeated };
    }
    try {
      const id = await openedExecution(cwd);
      const outcome = await authorizeProposal({
        client, executionId: id, idempotencyKey: `omp:${session}:${event.toolCallId}`, proposal, timeoutMs: config.timeoutMs,
        dashboardUrl: config.dashboardUrl,
        callbacks: {
          onHold: (hold) => {
            say(ctx, hold.message, 'warning');
            ledger = holdBegan(ledger, proposal, hold.approvalId, Date.now());
            showCounts(ctx);
            return offerReview(ctx, hold);
          },
          onApproved: (message) => say(ctx, message),
        },
      });
      ledger = recordOutcome(ledger, {
        proposal, outcome: outcome.outcome, ms: outcome.ms, at: Date.now(),
        ...(outcome.approvalId ? { approvalId: outcome.approvalId } : {}), ...(outcome.allowed ? {} : { message: outcome.reason }),
      });
      // The status line keeps the session's counts and the last decision with how long Ostrelio took.
      showCounts(ctx);
      // Headless runs have no status line; scripts (npm run test:omp-live) read this line instead.
      if (process.env.OSTRELIO_DEBUG_TIMING) process.stderr.write(`[ostrelio-timing] ${event.toolName} ${outcome.outcome} ${Math.round(outcome.ms)}\n`);
      if (!outcome.allowed) return { block: true, reason: outcome.reason };
      decisions.set(event.toolCallId, outcome.decisionId);
      return undefined;
    } catch (error) {
      status(ctx, undefined);
      // Fail closed: without a decision, nothing runs.
      return { block: true, reason: blockedReason(error, client.baseUrl) };
    }
  }

  // The run is over: counts, anything still waiting, and the session timeline.
  pi.on('agent_end', async (event, ctx) => {
    if (event?.isTerminal === false || summarized || !hasActivity(ledger)) return undefined;
    summarized = true;
    say(ctx, summaryText(ledger, { dashboardUrl: config.dashboardUrl, agentId: config.agentKey, executionId, approveCommand: cliCommand('approve') }));
    return undefined;
  });

  // /ostrelio [status | approve [id] | reject [id]]: typed by the person, run by this extension, never by the model.
  pi.registerCommand('ostrelio', {
    description: 'Ostrelio: session counts, and approve or reject a held call (/ostrelio approve [id], /ostrelio reject [id])',
    handler: async (args, ctx) => {
      const [verb = 'status', wanted] = args.trim().split(/\s+/);
      if (verb === 'status' || verb === '') {
        const held = ledger.pending.map((item) => `  waiting: ${item.what} (${item.approvalId})`);
        say(ctx, [statusText(ledger), ...held].join('\n'));
        return;
      }
      if (verb !== 'approve' && verb !== 'reject') { say(ctx, 'Usage: /ostrelio [status | approve [id] | reject [id]]', 'warning'); return; }
      const matches = ledger.pending.filter((item) => !wanted || item.approvalId.startsWith(wanted));
      if (matches.length !== 1) { say(ctx, matches.length ? `Several calls are waiting; name one: ${matches.map((item) => item.approvalId).join(', ')}` : 'Nothing is waiting for approval.', 'warning'); return; }
      const reviewer = await reviewerClient(process.env);
      if (!reviewer) { say(ctx, 'Run `ostrelio login` first: approving needs a reviewer session, not the agent key.', 'warning'); return; }
      try {
        await reviewer.review(matches[0]!.approvalId, verb, 'omp');
        say(ctx, `Ostrelio: ${verb === 'approve' ? 'approved' : 'rejected'} ${matches[0]!.what}.`);
      } catch (error) {
        say(ctx, `Ostrelio: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });

  pi.on('tool_result', async (event) => {
    const seen = resultText(event);
    if (seen) readSoFar = [...readSoFar, seen].slice(-MAX_READ_RESULTS);
    const decisionId = decisions.get(event.toolCallId);
    if (!decisionId) return undefined;
    decisions.delete(event.toolCallId);
    await reportOutcome(client, decisionId, event.isError ? 'FAILED' : 'EXECUTED', { source: 'omp', input: safeArgs(event.input) }).catch(() => undefined);
    return undefined;
  });
}
