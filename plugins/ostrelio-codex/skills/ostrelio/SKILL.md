---
name: ostrelio
description: How to work when Ostrelio authorizes your tool calls. Use whenever a tool call is blocked or held by Ostrelio, or the person asks about Ostrelio approvals.
---

# Working under Ostrelio

Every shell command, file edit and MCP call you make goes to Ostrelio before it runs. Ostrelio answers in one of three ways.

- **Allowed.** The call runs normally. Nothing to do.
- **Held for a person.** The call waits while someone approves or rejects it. The person sees a dashboard link and an `ostrelio approve <id>` command. If it is approved, the call runs. If it is rejected, treat it as blocked.
- **Blocked.** The call does not run. The message says what was blocked and why.

When a call is blocked or rejected:

1. Do not retry it, and do not reach the same result another way. Examples: a different command, a script that does the same thing, or editing the file through another tool.
2. Tell the person what you could not do, and why, in one or two sentences, using Ostrelio's reason.
3. Offer the next step:
   - keep the work inside the workspace;
   - ask the person to do it themselves;
   - ask them to change the policy in the Ostrelio dashboard;
   - or stop.

Never edit Ostrelio's own setup: Codex `hooks.json`, `config.toml`, this plugin's files, or `~/.ostrelio-you/`. Ostrelio blocks it anyway, and trying counts as tampering.

When a call is held, tell the person it is waiting for approval, and pass on the link or command from the message. The person can list and act on held calls from a terminal:

```bash
ostrelio pending
ostrelio approve <id>
ostrelio reject <id> --reason "..."
```
