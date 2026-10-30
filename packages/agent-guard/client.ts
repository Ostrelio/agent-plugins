/**
 * The Ostrelio agent API the harness plugins share: open an execution, authorize a proposal,
 * wait out REQUIRE_APPROVAL, and report the outcome. A missing answer blocks the call.
 */
import { fileURLToPath } from 'node:url';
import type { Proposal } from './classify.ts';

type Decision = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
interface DecisionEvent { id: string; decision: Decision; reason: string; approvalId?: string | null }
interface ApprovalStatus { status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'CONSUMED' }

const MAX_TEXT = 2_000;

/** Ostrelio could not be reached at all (down, wrong URL, timed out), as opposed to answering with an error. */
export class OstrelioUnreachable extends Error {}

/** Why a call was blocked when no decision came back, in words the person and the model can act on. */
export function blockedReason(error: unknown, baseUrl: string): string {
  if (error instanceof OstrelioUnreachable) {
    return `Ostrelio is unreachable at ${baseUrl}, so every tool call is blocked until it is back (nothing runs without a decision). Start the Ostrelio server, or check OSTRELIO_BASE_URL.`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  if (/API_KEY_INVALID|API_KEY_REQUIRED/.test(detail)) {
    return `Ostrelio rejected this agent's API key, so every tool call is blocked. Create a new key and restart with it (OSTRELIO_API_KEY). (${detail})`;
  }
  return `Ostrelio answered with an error, so this tool call was blocked (${detail}).`;
}

export function safeArgs(input: unknown): unknown {
  const json = JSON.stringify(input ?? {});
  return json.length <= MAX_TEXT ? input : `${json.slice(0, MAX_TEXT)}…`;
}

/** Env the plugins share. Agent key, name and runtime differ per harness. */
export function guardConfig(env: NodeJS.ProcessEnv, defaults: { agentKey: string; agentName: string; runtime: string }) {
  return {
    apiKey: env.OSTRELIO_API_KEY ?? '',
    baseUrl: (env.OSTRELIO_BASE_URL ?? 'http://127.0.0.1:3100').replace(/\/+$/, ''),
    agentKey: env.OSTRELIO_AGENT_KEY ?? defaults.agentKey,
    agentName: env.OSTRELIO_AGENT_NAME ?? defaults.agentName,
    companyId: env.OSTRELIO_COMPANY_ID || undefined,
    timeoutMs: Number(env.OSTRELIO_APPROVAL_TIMEOUT_SECONDS ?? 600) * 1000,
    dashboardUrl: (env.OSTRELIO_DASHBOARD_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    runtime: defaults.runtime,
  };
}

/** Where a person approves or rejects a held call: the dashboard's approvals page, opened on that approval. */
export function approvalLink(dashboardUrl: string, approvalId: string): string {
  return `${dashboardUrl.replace(/\/+$/, '')}/platform/approvals?approvalId=${encodeURIComponent(approvalId)}`;
}

/** "42 ms" under a second, "3.4 s" after, "2 min 5 s" past a minute. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export class OstrelioClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  constructor(baseUrl: string, apiKey: string) { this.baseUrl = baseUrl; this.apiKey = apiKey; }
  async call<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { accept: 'application/json', 'x-api-key': this.apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new OstrelioUnreachable(error instanceof Error ? error.message : String(error));
    }
    const json = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & T;
    if (!response.ok) throw new Error(`${json.error?.code ?? response.status}: ${json.error?.message ?? 'request failed'}`);
    return json;
  }
}

export async function openExecution(client: OstrelioClient, input: {
  agentKey: string; agentName: string; runtime: string; principalId: string; objective: string; companyId?: string;
}): Promise<string> {
  await client.call('POST', '/v1/agents/register', { externalKey: input.agentKey, name: input.agentName, runtime: input.runtime });
  const created = await client.call<{ id: string }>('POST', '/v1/executions', {
    agentId: input.agentKey, principalId: input.principalId, objective: input.objective,
    ...(input.companyId ? { companyId: input.companyId } : {}),
  });
  return created.id;
}

/** A call Ostrelio is holding for a person. */
export interface HoldInfo {
  approvalId: string;
  actionType: string;
  resourceId: string;
  reason: string;
  /** The held call in a few words, for a prompt title. */
  what: string;
  link: string;
  /** Shell command that approves this call from a terminal (`ostrelio approve <id>`). */
  approveCommand: string;
  /** The notification text: what is held, why, the dashboard link and the terminal command. */
  message: string;
}

/** The call in a few words: "bash: rm -rf build", "read: /etc/hosts", "file.write: src/app.ts". */
export function describeCall(proposal: Proposal): string {
  const context = proposal.context as Record<string, unknown>;
  const tool = typeof context.tool === 'string' ? context.tool : proposal.actionType;
  const detail = [context.command, context.path, context.url, proposal.resourceId].find((item) => typeof item === 'string' && item) as string | undefined;
  const text = `${tool}${detail && detail !== tool ? `: ${detail}` : ''}`.replace(/\s+/g, ' ');
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

/** What the model is told when a call is denied: what, why, and what it can do instead. */
export function denialMessage(proposal: Proposal, reason: string): string {
  return `Ostrelio blocked this call: ${describeCall(proposal)} (${proposal.actionType}). Why: ${reason.replace(/\.$/, '')}. `
    + 'Do not retry it or look for another way to do the same thing. Instead: keep your work inside the workspace, '
    + 'ask the person to do it or to change the policy, or stop and say what you could not do.';
}

const NOT_APPROVED_NEXT = 'Do not retry it or look for another way to do the same thing. Instead: keep your work inside the workspace, ask the person what they want to do, or stop and say what you could not do.';

export interface HeldCallbacks {
  /** Called once when the call is held. A returned function runs when the hold ends, however it ends. */
  onHold?: (hold: HoldInfo) => void | (() => void);
  onStatus?: (text: string | undefined) => void;
  onApproved?: (message: string) => void;
}

/** The terminal command that acts on a held call, as a person can paste it. It runs as the signed-in reviewer. */
export function cliCommand(verb: 'approve' | 'reject' | 'login', approvalId = ''): string {
  return `node --experimental-strip-types "${fileURLToPath(new URL('./cli.ts', import.meta.url))}" ${verb}${approvalId ? ` ${approvalId}` : ''}`;
}

/** What happened to a call, with how long Ostrelio took (the whole wait, for a hold). */
export type Authorized =
  | { allowed: true; decisionId: string; ms: number; outcome: 'ALLOW' | 'APPROVED'; approvalId?: string }
  | { allowed: false; reason: string; ms: number; outcome: 'DENY' | 'REJECTED' | 'TIMED_OUT'; approvalId?: string };

/**
 * Authorize one proposal. ALLOW returns the decision id. DENY and an approval that does not come
 * through return the reason to show the model. The wait uses GET /v1/agent/approvals/:id?waitSeconds=.
 */
export async function authorizeProposal(options: {
  client: OstrelioClient;
  executionId: string;
  idempotencyKey: string;
  proposal: Proposal;
  timeoutMs: number;
  dashboardUrl?: string;
  callbacks?: HeldCallbacks;
  now?: () => number;
}): Promise<Authorized> {
  const { client, proposal } = options;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const decided = await client.call<DecisionEvent>('POST', `/v1/executions/${options.executionId}/actions/authorize`, {
    idempotencyKey: options.idempotencyKey, ...proposal,
  });
  if (decided.decision === 'ALLOW') return { allowed: true, decisionId: decided.id, ms: now() - startedAt, outcome: 'ALLOW' };
  if (decided.decision === 'DENY') return { allowed: false, reason: denialMessage(proposal, decided.reason), ms: now() - startedAt, outcome: 'DENY' };

  const approvalId = decided.approvalId ?? '';
  const link = approvalLink(options.dashboardUrl ?? 'http://localhost:3000', approvalId);
  const approveCommand = cliCommand('approve', approvalId);
  const holdEnded = options.callbacks?.onHold?.({
    approvalId, actionType: proposal.actionType, resourceId: proposal.resourceId, reason: decided.reason, what: describeCall(proposal), link, approveCommand,
    message: `Ostrelio is holding ${proposal.actionType} (${proposal.resourceId}) for approval: ${decided.reason} Approve or reject it here: ${link} or in this terminal: ${approveCommand}`,
  });
  options.callbacks?.onStatus?.(`⏸ Ostrelio: ${proposal.actionType} is waiting for approval: ${link}`);
  const deadline = now() + options.timeoutMs;
  let state: ApprovalStatus['status'] = 'PENDING';
  try {
    while (state === 'PENDING' && now() < deadline) {
      const waitSeconds = Math.max(1, Math.min(30, Math.ceil((deadline - now()) / 1000)));
      state = (await client.call<ApprovalStatus>('GET', `/v1/agent/approvals/${approvalId}?waitSeconds=${waitSeconds}`, undefined, (waitSeconds + 15) * 1000)).status;
    }
  } finally {
    options.callbacks?.onStatus?.(undefined);
    if (typeof holdEnded === 'function') holdEnded();
  }
  if (state !== 'APPROVED') {
    const why = state === 'PENDING' ? 'nobody approved it in time' : state === 'DENIED' ? 'a reviewer rejected it' : `the approval is ${state.toLowerCase()}`;
    return {
      allowed: false, reason: `Ostrelio held this call (${describeCall(proposal)}) and ${why} (approval ${approvalId}). ${NOT_APPROVED_NEXT}`,
      ms: now() - startedAt, outcome: state === 'PENDING' ? 'TIMED_OUT' : 'REJECTED', approvalId,
    };
  }
  await client.call('POST', `/v1/approvals/${approvalId}/consume`, { idempotencyKey: `consume:${approvalId}`, action: proposal });
  options.callbacks?.onApproved?.(`Ostrelio: approved, running ${proposal.actionType}.`);
  return { allowed: true, decisionId: decided.id, ms: now() - startedAt, outcome: 'APPROVED', approvalId };
}

export async function reportOutcome(
  client: OstrelioClient, decisionId: string, outcome: 'EXECUTED' | 'FAILED', resultMetadata: Record<string, unknown>,
): Promise<void> {
  await client.call('POST', `/v1/decisions/${decisionId}/outcomes`, {
    idempotencyKey: `outcome:${decisionId}`, outcome, resultMetadata,
  });
}
