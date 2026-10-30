# Ostrelio for Cursor

Cursor hooks that send every shell command, MCP call, file read and edit to Ostrelio before it runs. They use the same classifier, policy pack, client and hold/approval behaviour as the [Claude Code](../claude-code-plugin/README.md) and [oh-my-pi](../omp-plugin/README.md) plugins (`packages/agent-guard`). Cursor runs the hooks, not the model, so a prompt cannot skip them. The blocking hooks are installed with `failClosed: true`, and Ostrelio being unreachable or the API key missing denies the call.

| Ostrelio decision | What Cursor gets |
| -- | -- |
| `ALLOW` | `{"permission":"allow"}`. The `after*` hook reports `EXECUTED`. |
| `DENY` | `{"permission":"deny","user_message":…,"agent_message":…}` with Ostrelio's reason. |
| `REQUIRE_APPROVAL` | The hook waits (default 10 minutes) on `GET /v1/agent/approvals/:id?waitSeconds=`, prints the reason and the approval link on stderr (Cursor's Hooks output channel), then answers allow, or deny with the approval id and "Do not retry it." The allow carries `user_message` with the link and the wait. |

Decisions show up in the Ostrelio dashboard at `/platform` (Inbox for anything held, History for the decision).

## Install

Needs Node.js 22.13 or newer on `PATH` (the hooks run `src/hook.ts` with type stripping).

```bash
node packages/cursor-plugin/install.mjs                  # ~/.cursor/hooks.json, every project
node packages/cursor-plugin/install.mjs --project DIR    # DIR/.cursor/hooks.json only
node packages/cursor-plugin/install.mjs --uninstall      # remove again
```

The installer merges into an existing `hooks.json` (other hooks stay) and writes the absolute path to `src/hook.ts`. Running it twice is safe. Then install the shared policy pack once per workspace (see the Claude Code README) and start Cursor from a shell that has the key, because hooks inherit Cursor's environment:

```bash
export OSTRELIO_API_KEY=ost_test_...
export OSTRELIO_BASE_URL=http://127.0.0.1:3100
node packages/agent-guard/install-policies.mjs
cursor .
```

`packages/connect` (`--harness cursor`, #260/#261) is not merged yet; adding `cursor` there is a follow-up that calls this installer.

## Hooks used

| Cursor hook | Ostrelio |
| -- | -- |
| `beforeShellExecution` (`command`, `cwd`) | classified as `Bash`: `shell.exec` or a security action |
| `beforeMCPExecution` (`server`, `tool_name`, `tool_input` as a JSON string) | `mcp.<server>__<tool>` |
| `beforeReadFile` (`file_path`) | `agent.read`, or `secret.read` for credential files |
| `preToolUse` (`tool_name`, `tool_input`, `tool_use_id`), matcher `Write\|StrReplace\|Edit\|MultiEdit\|Delete\|EditNotebook\|Task` | `file.write`, `file.delete`, `agent.tamper`, `agent.spawn`. Shell, read and MCP are left to the specific hooks above, so no call is authorized twice. |
| `beforeSubmitPrompt` (`prompt`) | the request and a new execution; answers `{"continue":true}` |
| `afterShellExecution`, `afterMCPExecution`, `postToolUse` | report `EXECUTED` and keep the last five results as `untrustedInputs` |

Blocking hooks have `timeout: 3600` so a hold can outlast a short default. `OSTRELIO_APPROVAL_TIMEOUT_SECONDS` (default 600) must stay below it. Tamper protection also covers `.cursor/hooks.json` and `.cursor/hooks/` (project or `~/.cursor/`), this plugin's files and `~/.ostrelio-you/`.

Configuration is the same `OSTRELIO_*` environment as the other plugins (`OSTRELIO_API_KEY`, `OSTRELIO_BASE_URL`, `OSTRELIO_AGENT_KEY`, `OSTRELIO_AGENT_NAME` default `cursor-agent` / "Cursor", `OSTRELIO_COMPANY_ID`, `OSTRELIO_APPROVAL_TIMEOUT_SECONDS`, `OSTRELIO_DASHBOARD_URL`). Session state (request, execution id, recent results) is kept per `conversation_id` in `~/.ostrelio-you/cursor-sessions/`.

## What is tested, and what is not

Unit tests (a fake Control Plane) cover the event mapping, allow, deny, hold approved, hold rejected, MCP action types, tamper, missing key, unreachable server, the request/untrusted-input context, and the installer. They do not run Cursor. The hook field names and response shape come from Cursor's documentation and community reports of current builds; they have not yet been exercised against a live Cursor, so `agentSaid` (Cursor's transcript format is undocumented) is not sent, and some Cursor tools (for example the CLI AskQuestion tool) are reported not to fire `preToolUse`.

## Other agents with pre-tool hooks

See the research table in the pull request. Gemini CLI (`BeforeTool`), Codex CLI (`PreToolUse`), Windsurf (`pre_*` hooks) and Cline (SDK `beforeTool`) each have a hook that can block; they are not integrated here and need their own packages. Codex documents its hooks as a guardrail, not a complete enforcement boundary, and its `ask` decision is not supported.

## Test

```bash
npm test --prefix packages/cursor-plugin
```
