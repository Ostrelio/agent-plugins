import {
  ErrorCodes, OstrelioApprovalExpired, OstrelioApprovalRejected, OstrelioApprovalTimeout, OstrelioDenied,
  OstrelioError,
} from './errors.js';
import type {
  ActionOutcome, Approval, ApprovalStatus, AuthorizeResult, DecisionEvent, Execution, OutcomeStatus, Proposal,
  RegisterAgentInput, RegisteredAgent, StartExecutionInput,
} from './types.js';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:3100';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 15 * 60_000;
/** The server holds an approval long poll for at most 30 seconds. */
const MAX_POLL_SECONDS = 30;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 10_000;

export interface OstrelioOptions {
  /** Workspace API key, `ost_<live|test>_<prefix>_<secret>`. Create one in the dashboard. */
  apiKey: string;
  /** API origin. Defaults to the local API, `http://127.0.0.1:3100`. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds (default 30 000). Long polls add their wait on top. */
  timeoutMs?: number;
  /** Attempts per request, including the first (default 3). Only network errors, 429, and 503 retry. */
  maxAttempts?: number;
  /** Custom `fetch`, for tests or runtimes without a global one. */
  fetch?: typeof fetch;
}

export interface RequestControl {
  /** Cancels the request (and any retry wait). */
  signal?: AbortSignal;
}

export interface AuthorizeOptions extends RequestControl {
  /** Reuse a key to make retries of the same proposal return the same decision. Defaults to a new UUID. */
  idempotencyKey?: string;
}

export interface WaitForApprovalOptions extends RequestControl {
  /** Give up after this long and return the still-pending status (default 15 minutes). */
  timeoutMs?: number;
  /** Called after every poll that comes back still pending. */
  onPending?: (status: ApprovalStatus) => void;
}

export interface ConsumeApprovalOptions extends RequestControl {
  /** The proposal that was approved. The server checks it matches the approval exactly. */
  action: Proposal;
  /** Defaults to `consume:<approvalId>`, so a retried consume is a replay, not a conflict. */
  idempotencyKey?: string;
}

export interface ReportOutcomeOptions extends RequestControl {
  status: OutcomeStatus;
  /** Stored with the outcome as `resultMetadata`. */
  detail?: Record<string, unknown>;
  /** Defaults to `outcome:<decisionId>`; a decision has one outcome. */
  idempotencyKey?: string;
}

export interface GuardOptions extends RequestControl {
  /** Authorization idempotency key. Pass a stable value to make a restarted guard resume, not re-propose. */
  idempotencyKey?: string;
  /** How long to wait for a human approval (default 15 minutes). */
  approvalTimeoutMs?: number;
  /** Called once when the decision is `REQUIRE_APPROVAL`, before waiting. */
  onApprovalRequired?: (decision: AuthorizeResult) => void;
  /** Called after every poll that comes back still pending. */
  onPending?: (status: ApprovalStatus) => void;
  /**
   * Called when the callback succeeded but reporting `EXECUTED` failed. The action already ran, so
   * `guard` still returns its result. Defaults to `console.warn`.
   */
  onOutcomeError?: (error: unknown) => void;
}

interface HttpRequest extends RequestControl {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** Extra time on top of `timeoutMs`, for long polls. */
  extraTimeoutMs?: number;
}

interface HttpResponse<T> { status: number; body: T }

/**
 * Client for the agent-facing Ostrelio API. One instance per API key; it holds no other state.
 *
 * ```ts
 * const ostrelio = new Ostrelio({ apiKey: process.env.OSTRELIO_API_KEY! });
 * const execution = await ostrelio.startExecution({ agentId: 'payments-agent', principalId: 'ops', objective: 'Pay invoice 42' });
 * await ostrelio.guard(execution.id, { actionType: 'payment.send', resourceType: 'payment', resourceId: 'inv-42' }, () => pay());
 * ```
 */
export class Ostrelio {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: OstrelioOptions) {
    if (!options?.apiKey) throw new TypeError('Ostrelio: apiKey is required.');
    this.#apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new TypeError('Ostrelio: no global fetch; pass options.fetch.');
    this.#fetch = fetchImpl.bind(globalThis);
  }

  /** Registers the agent, or updates its name and runtime if it exists. Safe to call on every startup. */
  async registerAgent(input: RegisterAgentInput, options: RequestControl = {}): Promise<RegisteredAgent> {
    const response = await this.#request<Omit<RegisteredAgent, 'created'>>({
      method: 'POST', path: '/v1/agents/register', body: input, ...control(options),
    });
    return { ...response.body, created: response.status === 201 };
  }

  /** Opens an execution: one task the agent performs for a principal. Proposals hang off it. */
  async startExecution(input: StartExecutionInput, options: RequestControl = {}): Promise<Execution> {
    return (await this.#request<Execution>({ method: 'POST', path: '/v1/executions', body: input, ...control(options) })).body;
  }

  /** Asks whether the agent may take an action. Does not run anything. */
  async authorize(executionId: string, proposal: Proposal, options: AuthorizeOptions = {}): Promise<AuthorizeResult> {
    const event = (await this.#request<DecisionEvent>({
      method: 'POST',
      path: `/v1/executions/${segment(executionId)}/actions/authorize`,
      body: { idempotencyKey: options.idempotencyKey ?? randomId(), ...bound(proposal) },
      ...control(options),
    })).body;
    return {
      decision: event.decision,
      decisionId: event.id,
      reason: event.reason,
      reasonCode: event.reasonCode,
      ...(event.approvalId ? { approval: { approvalId: event.approvalId } } : {}),
      event,
    };
  }

  /** Reads an approval's status once. `waitSeconds` (0–30) holds the request open while it is pending. */
  async getApproval(approvalId: string, options: RequestControl & { waitSeconds?: number } = {}): Promise<ApprovalStatus> {
    const waitSeconds = Math.min(MAX_POLL_SECONDS, Math.max(0, Math.floor(options.waitSeconds ?? 0)));
    return (await this.#request<ApprovalStatus>({
      method: 'GET',
      path: `/v1/agent/approvals/${segment(approvalId)}?waitSeconds=${waitSeconds}`,
      extraTimeoutMs: waitSeconds * 1000,
      ...control(options),
    })).body;
  }

  /**
   * Long-polls until the approval leaves `PENDING` or `timeoutMs` passes. Returns the last status,
   * which is still `PENDING` on timeout. Never throws for `DENIED` or `EXPIRED`; check `status`.
   */
  async waitForApproval(approvalId: string, options: WaitForApprovalOptions = {}): Promise<ApprovalStatus> {
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS);
    for (;;) {
      const remainingMs = deadline - Date.now();
      const waitSeconds = Math.min(MAX_POLL_SECONDS, Math.max(0, Math.ceil(remainingMs / 1000)));
      const status = await this.getApproval(approvalId, { waitSeconds, ...control(options) });
      if (status.status !== 'PENDING' || Date.now() >= deadline || waitSeconds === 0) return status;
      options.onPending?.(status);
    }
  }

  /** Spends an approved approval. Call once, right before acting; the server binds it to `action`. */
  async consumeApproval(approvalId: string, options: ConsumeApprovalOptions): Promise<Approval> {
    return (await this.#request<Approval>({
      method: 'POST',
      path: `/v1/approvals/${segment(approvalId)}/consume`,
      body: { idempotencyKey: options.idempotencyKey ?? `consume:${approvalId}`, action: bound(options.action) },
      ...control(options),
    })).body;
  }

  /** Records what happened after a decision. `EXECUTED` needs `ALLOW`, or an approval that was consumed. */
  async reportOutcome(decisionId: string, options: ReportOutcomeOptions): Promise<ActionOutcome> {
    return (await this.#request<ActionOutcome>({
      method: 'POST',
      path: `/v1/decisions/${segment(decisionId)}/outcomes`,
      body: {
        idempotencyKey: options.idempotencyKey ?? `outcome:${decisionId}`,
        outcome: options.status,
        ...(options.detail === undefined ? {} : { resultMetadata: options.detail }),
      },
      ...control(options),
    })).body;
  }

  /**
   * Authorizes `proposal`, waits for a human if needed, runs `action` only when allowed, and reports
   * the outcome. Throws `OstrelioDenied`, `OstrelioApprovalRejected`, `OstrelioApprovalExpired`, or
   * `OstrelioApprovalTimeout` without running `action`. If `action` throws, `FAILED` is reported and
   * the original error is rethrown.
   */
  async guard<T>(
    executionId: string,
    proposal: Proposal,
    action: (decision: AuthorizeResult) => Promise<T> | T,
    options: GuardOptions = {},
  ): Promise<T> {
    const signal = control(options);
    const decision = await this.authorize(executionId, proposal, {
      idempotencyKey: options.idempotencyKey ?? randomId(), ...signal,
    });

    if (decision.decision === 'DENY') throw new OstrelioDenied(decision);
    if (decision.decision === 'REQUIRE_APPROVAL') {
      const approvalId = decision.approval?.approvalId;
      if (!approvalId) {
        throw new OstrelioError({ code: ErrorCodes.INVALID_RESPONSE, status: 200, message: 'Decision requires approval but has no approvalId.' });
      }
      options.onApprovalRequired?.(decision);
      const status = await this.waitForApproval(approvalId, {
        ...(options.approvalTimeoutMs === undefined ? {} : { timeoutMs: options.approvalTimeoutMs }),
        ...(options.onPending ? { onPending: options.onPending } : {}),
        ...signal,
      });
      if (status.status === 'DENIED') throw new OstrelioApprovalRejected(decision, status);
      if (status.status === 'EXPIRED') throw new OstrelioApprovalExpired(decision, status);
      if (status.status === 'PENDING') throw new OstrelioApprovalTimeout(decision, status);
      // Approving a sandbox-backed action makes the platform run it and consume the approval, so
      // CONSUMED (or losing that race to consume) still means a reviewer approved this exact action.
      if (status.status === 'APPROVED') {
        try {
          await this.consumeApproval(approvalId, { action: proposal, ...signal });
        } catch (error) {
          if (!(error instanceof OstrelioError)) throw error;
          if (error.code === ErrorCodes.APPROVAL_EXPIRED) throw new OstrelioApprovalExpired(decision, status, error);
          if (error.code !== ErrorCodes.APPROVAL_ALREADY_CONSUMED) throw error;
        }
      }
    }

    let result: T;
    try {
      result = await action(decision);
    } catch (error) {
      await this.reportOutcome(decision.decisionId, {
        status: 'FAILED', detail: { error: error instanceof Error ? error.message : String(error) },
      }).catch(() => undefined);
      throw error;
    }
    try {
      await this.reportOutcome(decision.decisionId, { status: 'EXECUTED' });
    } catch (error) {
      // OUTCOME_CONFLICT: the platform already recorded a verified outcome for a sandbox-backed action.
      const recordedByPlatform = error instanceof OstrelioError && error.code === ErrorCodes.OUTCOME_CONFLICT;
      if (!recordedByPlatform) (options.onOutcomeError ?? defaultOutcomeError)(error);
    }
    return result;
  }

  async #request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    for (let attempt = 1; ; attempt++) {
      let failure: OstrelioError;
      let retryAfterMs: number | null = null;
      try {
        const response = await this.#send(request);
        if (response.ok) return { status: response.status, body: await readJson<T>(response) };
        failure = await errorFromResponse(response);
        if (response.status !== 429 && response.status !== 503) throw failure;
        retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      } catch (error) {
        if (!(error instanceof OstrelioError)) throw error;
        if (error.status !== 0 && error.status !== 429 && error.status !== 503) throw error;
        if (error.code === ErrorCodes.INVALID_RESPONSE || request.signal?.aborted) throw error;
        failure = error;
      }
      if (attempt >= this.maxAttempts) throw failure;
      await sleep(retryAfterMs ?? backoff(attempt), request.signal);
    }
  }

  async #send(request: HttpRequest): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs + (request.extraTimeoutMs ?? 0));
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const headers: Record<string, string> = { accept: 'application/json', 'x-api-key': this.#apiKey };
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await this.#fetch(`${this.baseUrl}${request.path}`, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) {
        throw new OstrelioError({ code: ErrorCodes.REQUEST_ABORTED, status: 0, message: 'The request was aborted.', cause: error });
      }
      if (timeout.aborted) {
        throw new OstrelioError({ code: ErrorCodes.REQUEST_TIMEOUT, status: 0, message: 'The request timed out.', cause: error });
      }
      throw new OstrelioError({
        code: ErrorCodes.NETWORK_ERROR, status: 0, cause: error,
        message: `Could not reach Ostrelio at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

const control = (options: RequestControl): RequestControl => (options.signal ? { signal: options.signal } : {});

/** Only the four bound fields go on the wire; `context` defaults to `{}`. */
const bound = (proposal: Proposal) => ({
  actionType: proposal.actionType,
  resourceType: proposal.resourceType,
  resourceId: proposal.resourceId,
  context: proposal.context ?? {},
});

const segment = (id: string) => encodeURIComponent(id);

const randomId = () => globalThis.crypto.randomUUID();

const defaultOutcomeError = (error: unknown) => {
  console.warn('[ostrelio] The action ran but reporting its outcome failed:', error);
};

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new OstrelioError({
      code: ErrorCodes.INVALID_RESPONSE, status: response.status, cause: error,
      requestId: response.headers.get('x-request-id'), message: 'Ostrelio returned a response that is not JSON.',
    });
  }
}

async function errorFromResponse(response: Response): Promise<OstrelioError> {
  const headerRequestId = response.headers.get('x-request-id');
  let body: unknown;
  try { body = JSON.parse(await response.text()); } catch { body = undefined; }
  const error = (body as { error?: { code?: unknown; message?: unknown; requestId?: unknown } } | undefined)?.error;
  return new OstrelioError({
    status: response.status,
    code: typeof error?.code === 'string' ? error.code : `HTTP_${response.status}`,
    message: typeof error?.message === 'string' ? error.message : `Ostrelio returned HTTP ${response.status}.`,
    requestId: typeof error?.requestId === 'string' ? error.requestId : headerRequestId,
  });
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(RETRY_MAX_DELAY_MS, Math.max(0, ms)) : null;
}

/** Full jitter: a random delay up to 250 ms, 500 ms, 1 s, … capped at 10 s. */
function backoff(attempt: number): number {
  return Math.random() * Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OstrelioError({ code: ErrorCodes.REQUEST_ABORTED, status: 0, message: 'The request was aborted.' }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new OstrelioError({ code: ErrorCodes.REQUEST_ABORTED, status: 0, message: 'The request was aborted.' }));
    };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
