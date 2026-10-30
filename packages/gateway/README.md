# @ostrelio/gateway

An MCP server that sits between an MCP client (Claude Desktop, Cursor, your own agent) and the MCP
servers that hold your real tools. Every tool call you map to an Ostrelio action is sent to Ostrelio
first and gets `ALLOW`, `REQUIRE_APPROVAL`, or `DENY`. Only allowed or approved calls reach the
upstream tool. The agent needs no code changes.

## Install and run

```bash
npx @ostrelio/gateway --config /absolute/path/to/ostrelio.gateway.json
```

Not published yet. Until it is, run it from the repo:

```bash
npm install --prefix packages/gateway
npm run build --prefix packages/gateway
OSTRELIO_API_KEY=ost_test_... node packages/gateway/dist/cli.js --config ./ostrelio.gateway.json
```

Needs Node 20.3+.

| Setting | Meaning |
| -- | -- |
| `OSTRELIO_API_KEY` | Workspace API key (`ost_test_…` or `ost_live_…`). Required. |
| `OSTRELIO_BASE_URL` | API origin. Defaults to the SDK default (`http://127.0.0.1:3100`). |
| `--config <path>` | Gateway config. Default `./ostrelio.gateway.json` in the working directory. |
| `--workspace <name>` | Workspace name, logged only. |

### API key scopes

A workspace admin creates the key in the dashboard under Settings → API keys, or with
`POST /v1/api-keys` (the plaintext key is shown once). The gateway needs exactly these scopes:

- `actions:authorize`: register the agent, start the execution, authorize actions, consume approvals.
- `approvals:read`: wait for an approval's status.
- `outcomes:write`: report `EXECUTED` or `FAILED` after a forwarded call.

## Connect an MCP client

The gateway needs a config file to know which upstream servers to start, and MCP clients launch
servers in an unpredictable working directory, so the default `./ostrelio.gateway.json` will not be
found. Pass an absolute `--config`, and set `OSTRELIO_BASE_URL` if you are not using the default API. The
dashboard's "Connect an agent manually" dialog and `docs/QUICKSTART.md` show the same entry, filled in
with your workspace:

```json
{
  "mcpServers": {
    "ostrelio": {
      "command": "npx",
      "args": ["-y", "@ostrelio/gateway", "--workspace", "<workspace>", "--config", "/absolute/path/to/ostrelio.gateway.json"],
      "env": { "OSTRELIO_API_KEY": "ost_live_...", "OSTRELIO_BASE_URL": "https://api.example.com" }
    }
  }
}
```

## Config file

```json
{
  "agent": { "externalKey": "payments-agent", "name": "Payments agent" },
  "upstreams": [
    { "name": "payments", "command": "node", "args": ["sample-tools.mjs"] }
  ],
  "actions": [
    {
      "tool": "payments.create_refund",
      "actionType": "refund.create",
      "resourceType": "charge",
      "map": {
        "resourceId": "$.charge",
        "context.amount": "$.amount_cents",
        "context.currency": "$.currency",
        "context.customerId": "$.customer"
      }
    }
  ],
  "unmappedTools": "deny",
  "approvalWaitSeconds": 0
}
```

Unknown keys are rejected, and every error names the JSON path that is wrong.

| Field | Required | Meaning |
| -- | -- | -- |
| `agent.externalKey` | yes | Stable id of the agent in Ostrelio. Registered on startup (safe to repeat). |
| `agent.name` | yes | Display name. |
| `agent.principalId` | no | Who the agent acts for. Default `mcp-client`. |
| `agent.companyId` | no | Id (UUID) of a company in your workspace. The agent's session is attributed to it, so its decisions and approvals show under that company in the dashboard. Without it they show under the workspace entry. Must belong to the key's workspace. |
| `upstreams[].name` | yes | Letters, digits, `_`, `-`. Unique. Prefixes the tool names. |
| `upstreams[].command`, `args` | yes, no | Stdio MCP server to spawn. Relative paths resolve against the gateway's working directory. |
| `upstreams[].env` | no | Extra environment for that upstream. |
| `upstreams[].cwd` | no | Working directory for that upstream. |
| `actions[].tool` | yes | Exposed tool name, `<upstream>.<tool>`. One mapping per tool. |
| `actions[].actionType` | yes | The Ostrelio action type policies match on, e.g. `refund.create`. |
| `actions[].resourceType` | yes* | Resource type. *Or set `map.resourceType`. |
| `actions[].map` | no | Targets `resourceType`, `resourceId`, or `context.<path>` (dots nest) mapped to `$.arg` (a tool argument; `$.a.b` nests, `$` is all of them) or a literal string. `resourceId` defaults to the tool name. Every mapped argument is required: a call that omits one is refused, so a policy always sees the values it checks. `resourceType` and `resourceId` must resolve to a string or a number. |
| `unmappedTools` | no | `"deny"` (default) refuses tools with no mapping. `"allow"` forwards them with no authorization and a warning on stderr. |
| `approvalWaitSeconds` | no | Integer 0 to 900. How long a call that needs approval blocks waiting for a reviewer. Default 0. |

The example uses `deny` on purpose: an agent that gains a new tool upstream should not be able to
use it until someone decides what it is. `allow` suits upstreams that are mostly harmless reads.

## What happens to a call

| Outcome | What the client sees |
| -- | -- |
| `ALLOW` | The call is forwarded and its result returned. Ostrelio is told `EXECUTED`, or `FAILED` if the upstream tool returned an error (the upstream's own error is still passed back). |
| `REQUIRE_APPROVAL` | Returns at once (or after `approvalWaitSeconds`) with an error result: `Approval required: <reason>. Approval id <id>. Ask a human to approve…`. Once a reviewer approves, call again with identical arguments: the retry reuses the same idempotency key and is forwarded. An approval can only be used once; a repeat after it ran is a new action. If a reviewer denies it, the caller is told not to retry. |
| `DENY` | `Denied by Ostrelio: <reason>`. Never forwarded. |
| Unmapped tool | Refused with `unmappedTools: "deny"`; forwarded unchecked with `"allow"`. |
| Agent paused or revoked | Every mapped call is refused with a message saying so. Resume it in the dashboard. |

## Guarantees

- stdout carries only MCP frames. All logs go to stderr.
- Upstreams start with a minimal environment (plus their `env`), so `OSTRELIO_API_KEY` never reaches them.
- If an upstream crashes, the call returns an error, the gateway stays up, and the upstream is restarted on the next call.
- If Ostrelio cannot be reached or errors, the call is refused, never forwarded.

## Demo

A terminal demo spawns the gateway in front of a sample payments server and walks through allow, deny,
an unmapped tool, and the vendor-bank-details-then-pay approval flow:

```bash
OSTRELIO_API_KEY=ost_test_... npm run example
```

Files are in [`examples/`](examples/): `sample-tools.mjs`, `ostrelio.gateway.json`, `demo-client.mjs`.
Set `OSTRELIO_BASE_URL` for a non-default API. In the last step, approve the payment in the dashboard
at `/platform` (Approvals); the demo retries every 5 seconds for up to 10 minutes. It assumes the
workspace policies from the SDK demo: small refunds allowed, refunds over 250,000 denied, and a
payment after a payout destination change held for approval.

## Limits

- Stdio upstreams only. No HTTP or SSE upstreams yet.
- No auto-mapping: every consequential tool needs an entry in `actions`.
- Tool names are `<upstream>.<tool>` and contain a dot, so some clients that restrict tool name characters may need a newer version.
- One shared Ostrelio execution per gateway process.
