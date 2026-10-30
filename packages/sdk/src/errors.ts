import type { ApprovalStatus, AuthorizeResult } from './types.js';

/**
 * Error codes the agent-facing routes return, plus the codes this client raises itself.
 * The server may add codes; `OstrelioError.code` is typed to accept any string.
 */
export const ErrorCodes = {
  // Authentication and scope
  API_KEY_REQUIRED: 'API_KEY_REQUIRED',
  API_KEY_INVALID: 'API_KEY_INVALID',
  API_KEY_SCOPE: 'API_KEY_SCOPE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  COMPANY_SCOPED_ACCOUNT: 'COMPANY_SCOPED_ACCOUNT',
  // Agent kill switch
  AGENT_PAUSED: 'AGENT_PAUSED',
  AGENT_REVOKED: 'AGENT_REVOKED',
  AGENT_METADATA_TOO_LARGE: 'AGENT_METADATA_TOO_LARGE',
  // Missing resources (cross-workspace ids also return these)
  NOT_FOUND: 'NOT_FOUND',
  EXECUTION_NOT_FOUND: 'EXECUTION_NOT_FOUND',
  DECISION_NOT_FOUND: 'DECISION_NOT_FOUND',
  APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
  COMPANY_NOT_FOUND: 'COMPANY_NOT_FOUND',
  COMPANY_REQUIRED: 'COMPANY_REQUIRED',
  // Approval and outcome state
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  APPROVAL_NOT_APPROVED: 'APPROVAL_NOT_APPROVED',
  APPROVAL_ALREADY_CONSUMED: 'APPROVAL_ALREADY_CONSUMED',
  APPROVAL_STATE_CONFLICT: 'APPROVAL_STATE_CONFLICT',
  APPROVAL_BINDING_MISMATCH: 'APPROVAL_BINDING_MISMATCH',
  APPROVAL_NOT_CONSUMED: 'APPROVAL_NOT_CONSUMED',
  DECISION_NOT_EXECUTABLE: 'DECISION_NOT_EXECUTABLE',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  OUTCOME_CONFLICT: 'OUTCOME_CONFLICT',
  // Request and service
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_REQUEST: 'INVALID_REQUEST',
  RATE_LIMITED: 'RATE_LIMITED',
  RATE_LIMIT_UNAVAILABLE: 'RATE_LIMIT_UNAVAILABLE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // Raised by this client
  NETWORK_ERROR: 'NETWORK_ERROR',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  REQUEST_ABORTED: 'REQUEST_ABORTED',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  DENIED: 'DENIED',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED',
  APPROVAL_WAIT_TIMEOUT: 'APPROVAL_WAIT_TIMEOUT',
  HELD: 'HELD',
  TOOL_MAPPING_ERROR: 'TOOL_MAPPING_ERROR',
} as const;

export type KnownErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
/** A known code, or any other string the server sends. */
export type OstrelioErrorCode = KnownErrorCode | (string & {});

export interface OstrelioErrorInit {
  code: OstrelioErrorCode;
  message: string;
  /** HTTP status, or `0` when no response was received. */
  status: number;
  requestId?: string | null;
  cause?: unknown;
}

/** Every error this client throws. `code`, `status`, and `requestId` come from the server's error body. */
export class OstrelioError extends Error {
  readonly code: OstrelioErrorCode;
  readonly status: number;
  /** The server's request id; quote it when asking Ostrelio support about a failure. */
  readonly requestId: string | null;

  constructor(init: OstrelioErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'OstrelioError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId ?? null;
  }
}

/** `guard` was refused: the decision was `DENY`. The callback did not run. */
export class OstrelioDenied extends OstrelioError {
  readonly decision: AuthorizeResult;

  constructor(decision: AuthorizeResult) {
    super({ code: ErrorCodes.DENIED, status: 0, message: `Action denied: ${decision.reason}` });
    this.name = 'OstrelioDenied';
    this.decision = decision;
  }
}

/** A reviewer denied the approval. The callback did not run. */
export class OstrelioApprovalRejected extends OstrelioError {
  readonly decision: AuthorizeResult;
  readonly approval: ApprovalStatus;

  constructor(decision: AuthorizeResult, approval: ApprovalStatus) {
    super({ code: ErrorCodes.APPROVAL_REJECTED, status: 0, message: 'The approval was rejected by a reviewer.' });
    this.name = 'OstrelioApprovalRejected';
    this.decision = decision;
    this.approval = approval;
  }
}

/** The approval expired on the server before it was approved or consumed. The callback did not run. */
export class OstrelioApprovalExpired extends OstrelioError {
  readonly decision: AuthorizeResult | null;
  readonly approval: ApprovalStatus | null;

  constructor(decision: AuthorizeResult | null, approval: ApprovalStatus | null, cause?: unknown) {
    super({
      code: ErrorCodes.APPROVAL_EXPIRED, status: 0, message: 'The approval expired before it could be used.',
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = 'OstrelioApprovalExpired';
    this.decision = decision;
    this.approval = approval;
  }
}

/** `guard` stopped waiting while the approval was still pending. The approval stays open on the server. */
export class OstrelioApprovalTimeout extends OstrelioError {
  readonly decision: AuthorizeResult;
  readonly approval: ApprovalStatus;

  constructor(decision: AuthorizeResult, approval: ApprovalStatus) {
    super({ code: ErrorCodes.APPROVAL_WAIT_TIMEOUT, status: 0, message: 'Timed out waiting for the approval.' });
    this.name = 'OstrelioApprovalTimeout';
    this.decision = decision;
    this.approval = approval;
  }
}

/**
 * A wrapped tool's call is waiting on a human approval and `wrapTools` stopped waiting (or was told
 * not to wait). The tool did not run. Calling it again with the same arguments resumes this approval
 * instead of proposing again.
 */
export class OstrelioHeld extends OstrelioError {
  readonly decision: AuthorizeResult;
  readonly approval: ApprovalStatus;
  readonly approvalId: string;

  constructor(decision: AuthorizeResult, approval: ApprovalStatus, cause?: unknown) {
    super({
      code: ErrorCodes.HELD, status: 0, message: `Held for approval ${approval.approvalId}: ${decision.reason}`,
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = 'OstrelioHeld';
    this.decision = decision;
    this.approval = approval;
    this.approvalId = approval.approvalId;
  }
}
