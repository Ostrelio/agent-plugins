# Ostrelio for Gemini CLI

Gemini CLI hooks that send every shell command, MCP call, file read and edit to Ostrelio before it runs. They use the same classifier, policy pack, client and hold/approval behaviour as the [Claude Code](../claude-code-plugin/README.md), [Cursor](../cursor-plugin/README.md) and [oh-my-pi](../omp-plugin/README.md) plugins (`packages/agent-guard`). Gemini CLI runs the hooks, not the model, so a prompt cannot skip them.

| Ostrelio decision | What Gemini CLI gets |
| -- | -- |
| `ALLOW` | `{"decision":"allow"}`. `AfterTool` reports `EXECUTED`. |
| `DENY` | `{"decision":"deny","reason":…,"systemMessage":…}`. The reason goes to the model as a tool error and the turn continues. |
| `REQUIRE_APPROVAL` | The hook waits (default 10 minutes) on `GET /v1/agent/approvals/:id?waitSeconds=`, prints the reason and the approval link on stderr, then answers allow, or deny with the approval id and "Do not retry it." |

Decisions show up in the Ostrelio dashboard at `/platform` (Inbox for anything held, History for the decision).

## Where enforcement stops (read this)

- **Fails open on a crash.** Gemini CLI documents exit codes other than 0 and 2 (and a hook timeout) as a warning and runs the tool anyway, and it has no fail-closed setting. The hook catches every error it can reach (Ostrelio unreachable, missing key, bad answer, unreadable input) and turns it into a deny, but if `node` itself cannot start (not on `PATH`, a Node older than 22.13) or the process is killed, the tool runs. Check `/hooks panel` after installing.
- **Environment redaction.** Hooks run with Gemini's sanitized environment. It only strips variables when `security.environmentVariableRedaction.enabled` is true, and then it strips names matching `KEY`, `TOKEN` and similar. If you turn that on, list `OSTRELIO_API_KEY`, `OSTRELIO_BASE_URL` and the other `OSTRELIO_*` names under `security.environmentVariableRedaction.allowed`, or every call is blocked for lack of a key.
- **Project hooks are trust-gated.** A project install (`.gemini/settings.json`) is fingerprinted by Gemini CLI and asks the person to trust it. A user install is not.
- **Tools without a path or command are classified by name.** `read_many_files` is authorized by its first `include` pattern, `web_fetch` by the first URL in its prompt, and Gemini's own state tools (`write_todos`, `ask_user`, `activate_skill`, plan mode, the task tracker) as harmless reads. Other tools keep their own action type (`tool.<name>`), so a policy can target them.
- **A person can still turn hooks off** with `/hooks disable-all`, or edit `~/.gemini/settings.json` outside the agent. Tamper rules only stop the agent from doing it (below). For machines where the person must not be able to, deploy the hooks in `/etc/gemini-cli/settings.json` as root.

## Install

Needs Node.js 22.13 or newer on `PATH` (the hook runs `src/hook.ts` with type stripping).

```bash
node packages/gemini-cli-plugin/install.mjs                  # ~/.gemini/settings.json, every project
node packages/gemini-cli-plugin/install.mjs --project DIR    # DIR/.gemini/settings.json only
node packages/gemini-cli-plugin/install.mjs --uninstall      # remove again
```

The installer merges into an existing `settings.json` (other settings and hooks stay), writes the absolute path to `src/hook.ts`, and refuses to touch a file that is not plain JSON. Running it twice is safe. Then install the shared policy pack once per workspace (see the Claude Code README) and start Gemini CLI from a shell that has the key:

```bash
export OSTRELIO_API_KEY=ost_test_...
export OSTRELIO_BASE_URL=http://127.0.0.1:3100
node packages/agent-guard/install-policies.mjs
gemini
```

## Hooks used

| Gemini CLI hook | Ostrelio |
| -- | -- |
| `BeforeTool`, matcher `*` (`tool_name`, `tool_input`, `mcp_context`) | `run_shell_command` is `shell.exec` or a security action; `read_file`, `read_many_files`, `list_directory`, `glob`, `grep_search` are `agent.read` (or `secret.read` for credential files); `write_file`, `replace` are `file.write`, `agent.tamper`; `web_fetch` is `network.request`; MCP tools are `mcp.<server>__<tool>` |
| `BeforeAgent` (`prompt`) | the request and a new execution; answers `{}` |
| `AfterTool` (`tool_response`) | reports `EXECUTED` and keeps the last five results as `untrustedInputs` |

The `BeforeTool` hook has `timeout: 3600000` (milliseconds; Gemini's default is 60 s) so a hold can outlast a short default. `OSTRELIO_APPROVAL_TIMEOUT_SECONDS` (default 600) must stay below it. Tamper protection covers `.gemini/settings.json` and `.gemini/hooks/` (project or `~/.gemini/`), `/etc/gemini-cli/settings.json`, this plugin's files and `~/.ostrelio-you/`.

Configuration is the same `OSTRELIO_*` environment as the other plugins (`OSTRELIO_API_KEY`, `OSTRELIO_BASE_URL`, `OSTRELIO_AGENT_KEY`, `OSTRELIO_AGENT_NAME` default `gemini-cli` / "Gemini CLI", `OSTRELIO_COMPANY_ID`, `OSTRELIO_APPROVAL_TIMEOUT_SECONDS`, `OSTRELIO_DASHBOARD_URL`). Session state is kept per `session_id` in `~/.ostrelio-you/gemini-cli-sessions/`.

## Sources

- Hooks reference (events, schemas, exit codes): https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md
- Hooks overview (config layers, env vars, trust): https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md
- Tool names and argument keys: https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/tools.md

## What is tested, and what is not

Unit tests (a fake Control Plane) cover the event mapping, allow, deny, hold approved, hold rejected, MCP action types, tamper, missing key, unreachable server, the request/untrusted-input context, and the installer. They do not run Gemini CLI: the field names and answers come from the documentation above and have not been exercised against a live build.

## Test

```bash
npm test --prefix packages/gemini-cli-plugin
```
