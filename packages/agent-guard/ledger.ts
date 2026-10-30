/**
 * What happened to this session's tool calls, as plain data both harnesses keep: counts for the
 * status line, the approvals still waiting, and the calls Ostrelio already denied (so an identical
 * retry is answered here, without asking Ostrelio again). The omp plugin keeps one in memory; the
 * Claude Code plugin keeps it in its session record and its status-line script reads the same file.
 */
import { createHash } from 'node:crypto';
import type { Proposal } from './classify.ts';
import { approvalLink, denialMessage, describeCall, formatElapsed } from './client.ts';

export { denialMessage, describeCall };

export type CallOutcome = 'ALLOW' | 'APPROVED' | 'DENY' | 'REJECTED' | 'TIMED_OUT';

export interface Counts {
  allowed: number;
  /** Every call Ostrelio held for a person, however the hold ended. */
  held: number;
  approved: number;
  rejected: number;
  timedOut: number;
  denied: number;
  /** Identical calls refused from the local cache, without calling Ostrelio. */
  repeats: number;
}

export interface LastDecision {
  outcome: CallOutcome | 'REPEAT';
  /** What the call was, e.g. "bash: rm -rf build". */
  what: string;
  ms: number;
  /** Epoch milliseconds. */
  at: number;
}

export interface PendingApproval { approvalId: string; what: string; since: number }

export interface Ledger {
  /** Everything since the session started. */
  total: Counts;
  /** Since the person's last request (the current execution). */
  run: Counts;
  last: LastDecision | null;
  pending: PendingApproval[];
  /** Fingerprint of a denied call -> the message the model was given. */
  denied: Record<string, { message: string; count: number }>;
}

export const emptyCounts = (): Counts => ({ allowed: 0, held: 0, approved: 0, rejected: 0, timedOut: 0, denied: 0, repeats: 0 });
export const emptyLedger = (): Ledger => ({ total: emptyCounts(), run: emptyCounts(), last: null, pending: [], denied: {} });

/** A new request from the person: the run counts start over, the session totals and the denial cache stay. */
export function startRun(ledger: Ledger): Ledger {
  return { ...ledger, run: emptyCounts(), pending: [] };
}

/** A ledger read from disk or JSON, with anything missing filled in. */
export function ledgerOf(raw: unknown): Ledger {
  const base = emptyLedger();
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Partial<Ledger>;
  return {
    total: { ...base.total, ...value.total }, run: { ...base.run, ...value.run },
    last: value.last ?? null, pending: Array.isArray(value.pending) ? value.pending : [],
    denied: value.denied && typeof value.denied === 'object' ? value.denied : {},
  };
}

const NOT_PART_OF_THE_CALL = new Set(['request', 'agentSaid', 'untrustedInputs']);
const MAX_CACHED = 200;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Two proposals with the same fingerprint are the same call: same action, target and arguments. */
export function fingerprint(proposal: Proposal): string {
  const context = Object.fromEntries(Object.entries(proposal.context).filter(([key]) => !NOT_PART_OF_THE_CALL.has(key)));
  return createHash('sha256').update(stable([proposal.actionType, proposal.resourceType, proposal.resourceId, context])).digest('hex').slice(0, 32);
}

/** The model is told the same thing again, with the retry named, when it repeats a denied call. */
export function repeatMessage(first: string): string {
  return `Ostrelio already blocked this identical call earlier in this session, so it was not sent again. ${first.replace(/^Ostrelio blocked this call: /, 'Blocked: ')}`;
}

/** The denial the model already got for this call, if any. */
export function cachedDenial(ledger: Ledger, proposal: Proposal): string | null {
  const known = ledger.denied[fingerprint(proposal)];
  return known ? repeatMessage(known.message) : null;
}

const bump = (counts: Counts, outcome: CallOutcome | 'REPEAT', held: boolean): Counts => ({
  ...counts,
  allowed: counts.allowed + (outcome === 'ALLOW' ? 1 : 0),
  held: counts.held + (held ? 1 : 0),
  approved: counts.approved + (outcome === 'APPROVED' ? 1 : 0),
  rejected: counts.rejected + (outcome === 'REJECTED' ? 1 : 0),
  timedOut: counts.timedOut + (outcome === 'TIMED_OUT' ? 1 : 0),
  denied: counts.denied + (outcome === 'DENY' ? 1 : 0),
  repeats: counts.repeats + (outcome === 'REPEAT' ? 1 : 0),
});

/** A hold begins: the call waits for a person, and shows as pending until it ends. */
export function holdBegan(ledger: Ledger, proposal: Proposal, approvalId: string, at: number): Ledger {
  if (ledger.pending.some((item) => item.approvalId === approvalId)) return ledger;
  return { ...ledger, pending: [...ledger.pending, { approvalId, what: describeCall(proposal), since: at }] };
}

/** A call has its answer. Denials and rejections are remembered so an identical retry is refused locally. */
export function recordOutcome(ledger: Ledger, input: {
  proposal: Proposal; outcome: CallOutcome | 'REPEAT'; ms: number; at: number; approvalId?: string; message?: string; held?: boolean;
}): Ledger {
  const held = input.held ?? (input.outcome === 'APPROVED' || input.outcome === 'REJECTED' || input.outcome === 'TIMED_OUT');
  let denied = ledger.denied;
  const key = fingerprint(input.proposal);
  if (input.outcome === 'REPEAT' && denied[key]) denied = { ...denied, [key]: { ...denied[key]!, count: denied[key]!.count + 1 } };
  if ((input.outcome === 'DENY' || input.outcome === 'REJECTED') && input.message) {
    denied = { ...denied, [key]: { message: input.message, count: 1 } };
    const keys = Object.keys(denied);
    if (keys.length > MAX_CACHED) denied = Object.fromEntries(keys.slice(-MAX_CACHED).map((item) => [item, denied[item]!]));
  }
  return {
    total: bump(ledger.total, input.outcome, held),
    run: bump(ledger.run, input.outcome, held),
    last: { outcome: input.outcome, what: describeCall(input.proposal), ms: input.ms, at: input.at },
    pending: input.approvalId ? ledger.pending.filter((item) => item.approvalId !== input.approvalId) : ledger.pending,
    denied,
  };
}

const LABELS: Record<CallOutcome | 'REPEAT', string> = {
  ALLOW: '✓ allowed', APPROVED: '✓ approved', DENY: '✗ denied', REJECTED: '✗ rejected', TIMED_OUT: '✗ not approved in time', REPEAT: '↺ repeat blocked',
};
export const outcomeLabel = (outcome: CallOutcome | 'REPEAT') => LABELS[outcome];

const clock = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour12: false });

/** The status line: counts for the session, what is waiting, and the last decision with its time. */
export function statusText(ledger: Ledger): string {
  const { total, pending, last } = ledger;
  const parts = [`✓ ${total.allowed} allowed`, `⏸ ${total.held + pending.length} held`, `✗ ${total.denied + total.rejected} denied`];
  if (total.repeats) parts.push(`↺ ${total.repeats} repeats`);
  const waiting = pending.length ? ` · ⏳ waiting for approval: ${pending[0]!.what}${pending.length > 1 ? ` (+${pending.length - 1})` : ''}` : '';
  const lastPart = last ? ` · last ${outcomeLabel(last.outcome)} ${last.what.split(':')[0]} (${formatElapsed(last.ms)}) ${clock(last.at)}` : '';
  return `Ostrelio ${parts.join(' · ')}${waiting}${lastPart}`;
}

/** Where the session's decisions are laid out in the dashboard. */
export function timelineLink(dashboardUrl: string, agentId: string, executionId: string): string {
  return `${dashboardUrl.replace(/\/+$/, '')}/platform/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(executionId)}`;
}

/** The end-of-run summary: what was decided, what is still waiting, and the timeline link. */
export function summaryText(ledger: Ledger, options: { dashboardUrl: string; agentId: string; executionId: string | null; approveCommand?: string }): string {
  const { run, pending } = ledger;
  const decided = run.allowed + run.held + run.denied + run.repeats;
  const lines = ['Ostrelio session summary'];
  const held = run.held + pending.length;
  const bits = [`${run.allowed} allowed`, `${held} held${run.held ? ` (${run.approved} approved, ${run.rejected} rejected${run.timedOut ? `, ${run.timedOut} timed out` : ''})` : ''}`, `${run.denied} denied`];
  if (run.repeats) bits.push(`${run.repeats} repeated denied ${run.repeats === 1 ? 'call' : 'calls'} answered locally`);
  lines.push(`  ${bits.join(' · ')}`);
  if (pending.length) {
    lines.push(`  Still waiting for approval: ${pending.map((item) => `${item.what} (${approvalLink(options.dashboardUrl, item.approvalId)})`).join('; ')}`);
    if (options.approveCommand) lines.push(`  Approve from this terminal: ${options.approveCommand} <approval id>`);
  }
  if (options.executionId && decided + pending.length > 0) lines.push(`  Timeline: ${timelineLink(options.dashboardUrl, options.agentId, options.executionId)}`);
  return lines.join('\n');
}

/** A run with no decisions at all has nothing to summarize. */
export const hasActivity = (ledger: Ledger) => {
  const { run, pending } = ledger;
  return run.allowed + run.held + run.denied + run.repeats + pending.length > 0;
};
