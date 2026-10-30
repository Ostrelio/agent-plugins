export { Ostrelio, DEFAULT_BASE_URL } from './client.js';
export type {
  OstrelioOptions, RequestControl, AuthorizeOptions, WaitForApprovalOptions, ConsumeApprovalOptions,
  ReportOutcomeOptions, GuardOptions,
} from './client.js';
export { wrapTools, ToolGuard, defaultToolProposal, proposalFromRule } from './tools.js';
export type { ToolActionRule, ToolMap, ToolAgent, ToolGuardOptions, UntrustedInput, WrappedTools } from './tools.js';
export {
  OstrelioError, OstrelioDenied, OstrelioApprovalRejected, OstrelioApprovalExpired, OstrelioApprovalTimeout,
  OstrelioHeld, ErrorCodes,
} from './errors.js';
export type { OstrelioErrorCode, KnownErrorCode, OstrelioErrorInit } from './errors.js';
export type * from './types.js';
