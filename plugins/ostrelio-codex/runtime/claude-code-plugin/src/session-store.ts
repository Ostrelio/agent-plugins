/**
 * Claude Code runs each hook in its own process, so the request, the open execution, the last tool
 * results and the decision ids live in a file under ~/.ostrelio-you (the directory tamper rules cover).
 */
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { emptyLedger, ledgerOf, type Ledger } from '../../agent-guard/ledger.ts';

export interface SessionRecord {
  request: string;
  executionId: string | null;
  reads: Array<{ source: string; text: string }>;
  decisions: Record<string, string>;
  /** Counts, pending approvals and denied calls for the session; the status-line script reads it too. */
  ledger: Ledger;
}

export function emptySession(): SessionRecord {
  return { request: '', executionId: null, reads: [], decisions: {}, ledger: emptyLedger() };
}

export interface SessionStore {
  update<T>(sessionId: string, fn: (current: SessionRecord) => Promise<{ record: SessionRecord; result: T }> | { record: SessionRecord; result: T }): Promise<T>;
}

/** In-memory store for tests. Calls for one store run one at a time. */
export function memoryStore(): SessionStore {
  const sessions = new Map<string, SessionRecord>();
  let chain: Promise<unknown> = Promise.resolve();
  return {
    update(sessionId, fn) {
      const run = chain.then(async () => {
        const current = structuredClone(sessions.get(sessionId) ?? emptySession());
        const { record, result } = await fn(current);
        sessions.set(sessionId, record);
        return result;
      });
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

function safeId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120);
  return cleaned || 'session';
}

async function acquire(lock: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { return await open(lock, 'wx', 0o600); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error('Ostrelio could not lock its Claude Code session record.');
}

/** One JSON file per Claude session. A lock file keeps parallel tool calls from clobbering it. */
export function fileStore(root = join(homedir(), '.ostrelio-you', 'claude-sessions')): SessionStore {
  const queues = new Map<string, Promise<unknown>>();
  return {
    update(sessionId, fn) {
      const key = safeId(sessionId);
      const previous = queues.get(key) ?? Promise.resolve();
      const run = previous.then(() => lockedUpdate(root, key, fn), () => lockedUpdate(root, key, fn));
      queues.set(key, run.then(() => undefined, () => undefined));
      return run;
    },
  };
}

async function lockedUpdate<T>(
  root: string, key: string,
  fn: (current: SessionRecord) => Promise<{ record: SessionRecord; result: T }> | { record: SessionRecord; result: T },
): Promise<T> {
  // The record holds the person's request and recent tool output, which can contain secrets:
  // owner-only directories and files, tightened if they already existed with looser modes.
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const dir of [root, dirname(root)]) await chmod(dir, 0o700).catch(() => undefined);
  const file = join(root, `${key}.json`);
  const handle = await acquire(`${file}.lock`);
  try {
    let current = emptySession();
    try {
      current = { ...emptySession(), ...JSON.parse(await readFile(file, 'utf8')) as Partial<SessionRecord> };
      if (!Array.isArray(current.reads)) current.reads = [];
      if (!current.decisions || typeof current.decisions !== 'object') current.decisions = {};
      current.ledger = ledgerOf(current.ledger);
    } catch { /* a new session, or a record this process is about to replace */ }
    const { record, result } = await fn(current);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
    await rename(tmp, file);
    return result;
  } finally {
    await handle.close();
    await rm(`${file}.lock`, { force: true });
  }
}

/** The record for one Claude session without locking or changing it (the status-line script uses this). */
export async function readSession(sessionId: string, root = join(homedir(), '.ostrelio-you', 'claude-sessions')): Promise<SessionRecord | null> {
  try {
    const record = JSON.parse(await readFile(join(root, `${safeId(sessionId)}.json`), 'utf8')) as Partial<SessionRecord>;
    return { ...emptySession(), ...record, ledger: ledgerOf(record.ledger) };
  } catch {
    return null;
  }
}
