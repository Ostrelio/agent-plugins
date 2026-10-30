/**
 * A person approving or rejecting a held call from the terminal. This is a reviewer session
 * (`ostrelio login`, stored in ~/.ostrelio-you/reviewer.json), never the agent's API key: the
 * reviewer client below only ever sends x-reviewer-session and x-csrf-token, and the agent's
 * `ost_` key is refused by the approval routes (Backend/test/agent-approvals.integration.test.ts).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ReviewerSession {
  baseUrl: string;
  email: string;
  sessionToken: string;
  csrfToken: string;
  /** ISO time. */
  expiresAt: string;
}

export interface PendingApproval {
  id: string;
  actionType: string;
  resourceId: string;
  reason: string;
  expiresAt: string;
}

/** ~/.ostrelio-you, or OSTRELIO_HOME (tests and shared machines). The tamper rules protect this folder. */
export function ostrelioHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OSTRELIO_HOME || join(homedir(), '.ostrelio-you');
}

const sessionFile = (env: NodeJS.ProcessEnv = process.env) => join(ostrelioHome(env), 'reviewer.json');

/** The stored reviewer session, or null when nobody has run `ostrelio login` (or it has expired). */
export async function loadReviewerSession(env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<ReviewerSession | null> {
  try {
    const session = JSON.parse(await readFile(sessionFile(env), 'utf8')) as Partial<ReviewerSession>;
    if (!session.sessionToken || !session.csrfToken || !session.baseUrl) return null;
    if (session.expiresAt && Date.parse(session.expiresAt) <= now) return null;
    return session as ReviewerSession;
  } catch {
    return null;
  }
}

export async function saveReviewerSession(session: ReviewerSession, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const file = sessionFile(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700).catch(() => undefined);
  await writeFile(file, JSON.stringify(session), { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

export async function clearReviewerSession(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await rm(sessionFile(env), { force: true });
}

/** Headers the Ostrelio server wants on a reviewer login when it sits behind the dashboard gateway (REVIEWER_GATEWAY_SECRET). */
function gatewayHeaders(secret: string | undefined): Record<string, string> {
  if (!secret) return {};
  const clientId = randomBytes(32).toString('hex');
  return {
    'x-reviewer-client-id': clientId,
    'x-reviewer-gateway-proof': createHmac('sha256', secret).update(`reviewer-gateway\0${clientId}`).digest('hex'),
  };
}

async function request<T>(baseUrl: string, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`Ostrelio is unreachable at ${baseUrl} (${error instanceof Error ? error.message : String(error)}).`);
  }
  const json = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string }; message?: string } & T;
  if (!response.ok) {
    const code = json.error?.code ?? String(response.status);
    if (response.status === 401) throw new Error(`Your Ostrelio reviewer session was refused (${code}). Run \`ostrelio login\` again.`);
    throw new Error(`${code}: ${json.error?.message ?? json.message ?? 'request failed'}`);
  }
  return json;
}

/** Signs a reviewer in with email and password and stores the session. */
export async function loginReviewer(input: { baseUrl: string; email: string; password: string; env?: NodeJS.ProcessEnv }): Promise<ReviewerSession> {
  const env = input.env ?? process.env;
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  const result = await request<{ sessionToken: string; csrfToken: string; expiresAt: string; reviewer: { email: string } }>(
    baseUrl, 'POST', '/v1/reviewer/session', gatewayHeaders(env.REVIEWER_GATEWAY_SECRET),
    { email: input.email, password: input.password },
  );
  const session: ReviewerSession = { baseUrl, email: result.reviewer.email, sessionToken: result.sessionToken, csrfToken: result.csrfToken, expiresAt: result.expiresAt };
  await saveReviewerSession(session, env);
  return session;
}

/** Acts as the signed-in reviewer. It has no agent API key to send, so it cannot be mistaken for the agent. */
export class ReviewerClient {
  readonly session: ReviewerSession;
  constructor(session: ReviewerSession) { this.session = session; }

  private headers(write: boolean): Record<string, string> {
    return { 'x-reviewer-session': this.session.sessionToken, ...(write ? { 'x-csrf-token': this.session.csrfToken } : {}) };
  }

  /** The held calls waiting for a person, with what each one is (the list route has ids only). */
  async pending(): Promise<PendingApproval[]> {
    const list = await request<{ approvals?: Array<{ id: string; expiresAt?: string }> }>(this.session.baseUrl, 'GET', '/v1/approvals?status=PENDING&limit=20', this.headers(false));
    return Promise.all((list.approvals ?? []).slice(0, 20).map(async (item) => {
      const detail = await request<{ expiresAt?: string; decision?: { actionType?: string; resourceId?: string; reason?: string } }>(
        this.session.baseUrl, 'GET', `/v1/approvals/${encodeURIComponent(item.id)}`, this.headers(false));
      return {
        id: item.id, actionType: detail.decision?.actionType ?? '', resourceId: detail.decision?.resourceId ?? '',
        reason: detail.decision?.reason ?? '', expiresAt: detail.expiresAt ?? item.expiresAt ?? '',
      };
    }));
  }

  /** Approve or reject one held call. `source` names the terminal in the audit reason. */
  async review(approvalId: string, verdict: 'approve' | 'reject', source: string, reason?: string): Promise<{ status: string }> {
    const result = await request<{ status: string }>(
      this.session.baseUrl, 'POST', `/v1/approvals/${encodeURIComponent(approvalId)}/${verdict === 'approve' ? 'approve' : 'deny'}`, this.headers(true),
      { idempotencyKey: `terminal:${verdict}:${approvalId}`, reason: reason ?? `${verdict === 'approve' ? 'Approved' : 'Rejected'} from the terminal (${source}) by ${this.session.email}.` },
    );
    return { status: result.status };
  }
}

/** The reviewer client for the stored session, or null when nobody is signed in. */
export async function reviewerClient(env: NodeJS.ProcessEnv = process.env): Promise<ReviewerClient | null> {
  const session = await loadReviewerSession(env);
  return session ? new ReviewerClient(session) : null;
}
