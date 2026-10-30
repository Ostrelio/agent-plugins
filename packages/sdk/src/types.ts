/**
 * Wire types for the agent-facing Ostrelio API. They mirror the TypeBox schemas in
 * `Backend/src/http/schemas.ts` (published at `/openapi.json`); only the fields an agent needs are
 * typed strictly, and the full server objects are passed through on `raw`/`event` fields.
 */

export type Decision = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
export type AgentStatus = 'ACTIVE' | 'PAUSED' | 'REVOKED';
export type ExecutionStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type ApprovalState = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'CONSUMED';
export type OutcomeStatus = 'EXECUTED' | 'FAILED' | 'CANCELLED';

export interface RegisterAgentInput {
  /** Stable identifier you choose for this agent, e.g. `"payments-agent"`. Executions refer to it. */
  externalKey: string;
  /** Display name shown in the dashboard. */
  name: string;
  /** Free-form runtime label, e.g. `"node"` or `"langgraph"`. */
  runtime?: string;
  version?: string;
  /** Up to 4 KB of JSON. */
  metadata?: Record<string, unknown>;
}

export interface RegisteredAgent {
  /** Server id of the agent (UUID). */
  agentId: string;
  /** Short dashboard label such as `FIN-004`. */
  displayKey: string;
  status: AgentStatus;
  /** `true` when this call created the agent, `false` when it already existed. */
  created: boolean;
}

export interface StartExecutionInput {
  /** The agent's `externalKey` (the same value passed to `registerAgent`). */
  agentId: string;
  /** The human or system the agent is acting for. */
  principalId: string;
  /** What the agent is trying to accomplish; shown to approvers. */
  objective: string;
  /** Optional caller key to correlate this execution with your own records. */
  correlationKey?: string;
  companyId?: string;
}

export interface Execution {
  id: string;
  tenantId: string;
  companyId: string | null;
  correlationKey: string | null;
  agentId: string;
  principalId: string;
  objective: string;
  status: ExecutionStatus;
  createdAt: string;
  updatedAt: string;
}

/** An action the agent wants to take. The approval is bound to exactly these four fields. */
export interface Proposal {
  actionType: string;
  resourceType: string;
  resourceId: string;
  context?: Record<string, unknown>;
}

/** The decision event exactly as `POST /v1/executions/:id/actions/authorize` returns it. */
export interface DecisionEvent {
  id: string;
  tenantId: string;
  executionId: string;
  idempotencyKey: string;
  actionType: string;
  resourceType: string;
  resourceId: string;
  context: Record<string, unknown>;
  decision: Decision;
  baseDecision: Decision;
  matchedPolicyId: string;
  reasonCode: string;
  reason: string;
  approvalId: string | null;
  createdAt: string;
  [key: string]: unknown;
}

export interface AuthorizeResult {
  decision: Decision;
  decisionId: string;
  reason: string;
  reasonCode: string;
  /** Present only when `decision` is `REQUIRE_APPROVAL`. */
  approval?: { approvalId: string };
  /** The full decision event from the server. */
  event: DecisionEvent;
}

export interface ApprovalStatus {
  approvalId: string;
  decisionId: string;
  status: ApprovalState;
  expiresAt: string;
  reviewedAt: string | null;
}

/** The approval record returned by `POST /v1/approvals/:id/consume`. */
export interface Approval {
  id: string;
  executionId: string;
  decisionId: string;
  status: ApprovalState;
  expiresAt: string;
  consumedAt: string | null;
  [key: string]: unknown;
}

export interface ActionOutcome {
  id: string;
  executionId: string;
  decisionId: string;
  idempotencyKey: string;
  outcome: OutcomeStatus;
  resultMetadata: Record<string, unknown>;
  provenance: 'ASSERTED' | 'VERIFIED';
  createdAt: string;
  [key: string]: unknown;
}
