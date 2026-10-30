# @ostrelio/sdk

TypeScript client for the Ostrelio agent API. Your agent asks Ostrelio before it acts, waits
for a human when a policy requires one, and reports what happened. No runtime dependencies; it
uses the global `fetch` (Node 20.3+, Deno, Bun, browsers).

## Install

```bash
npm install @ostrelio/sdk
```

You need a workspace API key (`ost_test_…` or `ost_live_…`). A workspace admin creates one with
`POST /v1/api-keys` (the plaintext key is shown once). Keys need the `actions:authorize`, `approvals:read`, and `outcomes:write`
scopes for everything below.

## Quickstart

```ts
import { Ostrelio, OstrelioDenied } from '@ostrelio/sdk';

const ostrelio = new Ostrelio({
  apiKey: process.env.OSTRELIO_API_KEY!,
  baseUrl: 'http://127.0.0.1:3100', // the default; set your hosted API URL in production
});

// Once at startup. Safe to repeat: it updates the name and runtime.
await ostrelio.registerAgent({ externalKey: 'payments-agent', name: 'Payments agent', runtime: 'node' });

// One execution per task. `agentId` is the agent's externalKey.
const execution = await ostrelio.startExecution({
  agentId: 'payments-agent',
  principalId: 'finance-ops',
  objective: 'Pay invoice 42 for Acme',
});

// guard = authorize, wait for approval if needed, consume it, run, report the outcome.
const receipt = await ostrelio.guard(
  execution.id,
  { actionType: 'payment.send', resourceType: 'payment', resourceId: 'inv-42', context: { amount: 10_000, currency: 'USD' } },
  async () => payments.send('inv-42'),
  { onApprovalRequired: (d) => console.log('Waiting for a reviewer:', d.reason) },
);
```

A runnable version is in [`examples/approval-demo.ts`](examples/approval-demo.ts):

```bash
OSTRELIO_API_KEY=ost_test_... npm run example
```

## What `guard` does

| Decision | What happens |
| -- | -- |
| `ALLOW` | Runs your callback, then reports `EXECUTED`. |
| `REQUIRE_APPROVAL` | Long-polls until a reviewer acts (default 15 min). On `APPROVED` it consumes the approval, runs the callback, reports `EXECUTED`. |
| `DENY` | Throws `OstrelioDenied`. The callback never runs. |

For sandbox-backed actions the platform runs the action itself when it is allowed or approved. It
records a `VERIFIED` outcome and consumes the approval. `guard` treats a `CONSUMED` approval, or
`APPROVAL_ALREADY_CONSUMED` on its own consume, as approved, and treats `OUTCOME_CONFLICT` on its
`EXECUTED` report as already recorded.

If the callback throws, `guard` reports `FAILED` with the error message and rethrows your error.
If the callback succeeds but reporting `EXECUTED` fails, `guard` still returns the result (the
action already happened) and passes the error to `onOutcomeError` (default: `console.warn`).

`guard` sends one idempotency key for the proposal. Pass `idempotencyKey` yourself to make a
restarted process resume the same decision instead of proposing again. Consume and outcome
calls use keys derived from the approval and decision ids, so retries replay instead of conflicting.

## Wrapping an agent's tools

`wrapTools` governs a whole tool set in one line: every call is authorized before the tool runs,
with the same outcomes as `guard`. It accepts a record of functions, a Vercel AI SDK tool record
(`execute`), OpenAI `runTools` definitions (`function.function`), or Anthropic tool-runner
definitions (`run`), and returns the same shape.

```ts
import { Ostrelio, OstrelioDenied, OstrelioHeld, wrapTools } from '@ostrelio/sdk';

const tools = wrapTools({ read_file, run_shell, rotate_secret, post_message }, {
  client: new Ostrelio({ apiKey: process.env.OSTRELIO_API_KEY! }),
  agent: { externalKey: 'ops-agent', name: 'Ops agent' }, // registered and given an execution on the first call
  request: () => lastUserMessage,                          // sent as context.request
  map: {                                                   // same rules as the gateway's ostrelio.gateway.json
    run_shell: { actionType: 'shell.exec', resourceType: 'shell', map: { resourceId: '$.command' } },
    rotate_secret: { actionType: 'secret.rotate', resourceType: 'secret', map: { resourceId: '$.name' } },
  },
});

await tools.run_shell({ command: 'kubectl get pods' }); // runs only if Ostrelio allows it
```

| Option | Meaning |
| -- | -- |
| `agent` / `executionId` | The agent to open an execution for on the first call, or an execution you already started. |
| `map` | Rules by tool name, or `(toolName, args) => Proposal \| undefined`. Unmapped tools get `tool.<name>` on resource `tool`/`<name>`, with the arguments in context. A rule whose argument is missing throws `TOOL_MAPPING_ERROR` and the tool does not run. |
| `approvalTimeoutMs` | How long a held call waits (default 15 min). On timeout, or at once with `0`, it throws `OstrelioHeld` with `approvalId`; calling the tool again with the same arguments resumes that approval. |
| `request`, `untrustedInputs` | The person's request and extra text the agent read. The last five wrapped-tool results are added to `context.untrustedInputs` too (`trackResults: false` turns that off), so reviewers can tell instructions from the person apart from text a tool returned. |

Deny throws `OstrelioDenied`, a rejected approval `OstrelioApprovalRejected`; the tool never runs.
If the tool throws, `FAILED` is reported and the error rethrown. If your loop dispatches plain tool
definitions itself, create a `ToolGuard` with the same options and call
`guard.run(name, args, () => impl(args))`. A runnable demo is in
[`examples/wrap-tools-demo.ts`](examples/wrap-tools-demo.ts) (`npm run example:tools`).

## Lower-level calls

```ts
const decision = await ostrelio.authorize(execution.id, proposal, { idempotencyKey });
// { decision: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY', decisionId, reason, reasonCode, approval?: { approvalId }, event }

const status = await ostrelio.waitForApproval(approvalId, { timeoutMs: 15 * 60_000 });
// status.status: 'APPROVED' | 'DENIED' | 'EXPIRED' | 'CONSUMED', or 'PENDING' on timeout

await ostrelio.consumeApproval(approvalId, { action: proposal }); // must match the approved proposal
await ostrelio.reportOutcome(decision.decisionId, { status: 'EXECUTED', detail: { paymentId } });
```

`getApproval(approvalId, { waitSeconds })` reads the status once (holding up to 30 s while pending).
Every method takes an optional `signal` (`AbortSignal`).

## Options

| Option | Default | Meaning |
| -- | -- | -- |
| `apiKey` | required | Workspace API key, sent as `x-api-key`. |
| `baseUrl` | `http://127.0.0.1:3100` | API origin. |
| `timeoutMs` | `30000` | Per request. Long polls add their wait on top. |
| `maxAttempts` | `3` | Attempts per request, including the first. |
| `fetch` | `globalThis.fetch` | Custom fetch implementation. |

Retries: only network errors, timeouts, `429`, and `503` are retried, with jittered exponential
backoff (honoring `Retry-After`), up to `maxAttempts`. No other `4xx` or `5xx` is retried.

## Errors

Every error is an `OstrelioError` with `code`, `status` (HTTP status, `0` when no response
arrived), and `requestId` (quote it to support). `ErrorCodes` exports the known codes.

| Code | Status | Meaning / what to do |
| -- | -- | -- |
| `API_KEY_INVALID` | 401 | Unknown or revoked key. |
| `API_KEY_SCOPE` | 403 | The key lacks the scope for this route, or is scoped to another agent or team. |
| `COMPANY_SCOPED_ACCOUNT` | 403 | A company-assigned account tried a workspace-wide operation. |
| `AGENT_PAUSED` | 423 | The agent was paused from the dashboard (kill switch). Stop and wait for an admin to resume it. |
| `AGENT_REVOKED` | 403 | The agent was revoked. It cannot act again. |
| `AGENT_METADATA_TOO_LARGE` | 413 | `registerAgent` metadata is over 4 KB. |
| `EXECUTION_NOT_FOUND`, `DECISION_NOT_FOUND`, `APPROVAL_NOT_FOUND` | 404 | Missing, or belongs to another workspace. |
| `VALIDATION_ERROR` | 400 | The request body failed schema validation. |
| `IDEMPOTENCY_CONFLICT` | 409 | An idempotency key was reused for a different request. |
| `APPROVAL_EXPIRED` | 409 | The approval expired before it was consumed. |
| `APPROVAL_BINDING_MISMATCH` | 409 | `consumeApproval` was called with a different action than the one approved. |
| `APPROVAL_ALREADY_CONSUMED`, `APPROVAL_STATE_CONFLICT` | 409 | The approval was already used, or is not approved. |
| `APPROVAL_NOT_CONSUMED` | 409 | `EXECUTED` was reported for an approval-gated decision before consuming it. |
| `DECISION_NOT_EXECUTABLE` | 409 | `EXECUTED` was reported for a denied decision. |
| `RATE_LIMITED` | 429 | Retried automatically; thrown after the last attempt. |
| `SERVICE_UNAVAILABLE`, `RATE_LIMIT_UNAVAILABLE` | 503 | Retried automatically. |
| `NETWORK_ERROR`, `REQUEST_TIMEOUT` | 0 | No response. Retried automatically. |
| `REQUEST_ABORTED` | 0 | Your `signal` aborted the call. |
| `INVALID_RESPONSE` | any | The server sent something that is not the expected JSON. |

`guard` adds four subclasses, none of which run your callback:

| Class | Code | When |
| -- | -- | -- |
| `OstrelioDenied` | `DENIED` | The decision was `DENY`. `error.decision` holds the reason. |
| `OstrelioApprovalRejected` | `APPROVAL_REJECTED` | A reviewer denied the approval. |
| `OstrelioApprovalExpired` | `APPROVAL_EXPIRED` | The approval expired. |
| `OstrelioApprovalTimeout` | `APPROVAL_WAIT_TIMEOUT` | `approvalTimeoutMs` passed. The approval is still open; call `waitForApproval` again later. |

`wrapTools` throws `OstrelioHeld` (`HELD`, with `approvalId`) instead of `OstrelioApprovalTimeout`,
and `TOOL_MAPPING_ERROR` when a mapped argument is missing.

## Development

```bash
npm install
npm run check   # tsc, including tests
npm test        # unit tests + an integration test against the real backend (needs Backend/node_modules)
npm run build   # emits dist/ with .d.ts
npm pack --dry-run
```

Publishing runs from `.github/workflows/publish-sdk.yml` on an `sdk-v*` tag and needs the
`NPM_TOKEN` secret.
