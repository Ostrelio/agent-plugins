# Ostrelio for Windsurf (Cascade)

Windsurf (Cascade) hooks that send every terminal command, MCP call, file read and code edit to Ostrelio before it runs. They use the same classifier, policy pack, client and hold/approval behaviour as the [Claude Code](../claude-code-plugin/README.md), [Cursor](../cursor-plugin/README.md) and [oh-my-pi](../omp-plugin/README.md) plugins (`packages/agent-guard`). Windsurf runs the hooks, not the model, so a prompt cannot skip them. The same hooks file format is used by Devin Desktop (the renamed Windsurf), whose docs are the source below.

| Ostrelio decision | What Windsurf gets |
| -- | -- |
| `ALLOW` | exit 0, no output. The `post_*` hook reports `EXECUTED`. |
| `DENY` | exit 2 with Ostrelio's reason on stderr. Windsurf shows it to Cascade (and to the person with `show_output`). |
| `REQUIRE_APPROVAL` | The hook waits (default 10 minutes) on `GET /v1/agent/approvals/:id?waitSeconds=`, prints the reason and the approval link on stderr, then exits 0, or exits 2 with the approval id and "Do not retry it." |

Decisions show up in the Ostrelio dashboard at `/platform` (Inbox for anything held, History for the decision).

## Where enforcement stops (read this)

- **Fails open on a crash.** Windsurf blocks only on exit code 2; any other non-zero exit lets the action proceed, and there is no fail-closed setting. The hook catches every error it can reach (Ostrelio unreachable, missing key, bad answer, unreadable input) and exits 2, but if `node` cannot start (not on `PATH`, Node older than 22.13) or the process is killed, the action runs.
- **No documented hook timeout.** The docs list no timeout setting or default, so how long Windsurf lets a held call wait is unverified. Treat long holds as untested and watch the Inbox.
- **Only five actions can be blocked**: terminal commands, file reads, code writes, MCP calls and prompts (the prompt hook is not used to block). Anything else Cascade does (web search, browser, memory, deleting a file other than through a command) has no pre-hook, so Ostrelio does not see it.
- **Less context than other agents.** `post_run_command`, `post_read_code` and `post_write_code` carry no output or file content, so only `post_mcp_tool_use` results feed `untrustedInputs`. Windsurf gives no tool-call id, so a call is matched to its `post_*` hook by a fingerprint of its arguments.
- **Hooks do not run in Restricted Mode**, and a person can edit or disable the hooks file. Tamper rules only stop the agent from doing it (below). For machines where the person must not be able to, deploy the hooks at the system level (`/Library/Application Support/Devin/hooks.json`, `/etc/devin/hooks.json`) as root, or through the enterprise cloud dashboard; the installer does neither.
- **The app needs the key in its environment.** Hooks inherit Windsurf's environment, so start it from a shell that exports `OSTRELIO_API_KEY` (`windsurf .`). Launched from the Dock, every call is blocked for lack of a key.

## Install

Needs Node.js 22.13 or newer on `PATH` (the hooks run `src/hook.ts` with type stripping).

```bash
node packages/windsurf-plugin/install.mjs                  # ~/.codeium/windsurf/hooks.json, every workspace
node packages/windsurf-plugin/install.mjs --project DIR    # DIR/.windsurf/hooks.json (DIR/.devin/hooks.json if that file already exists)
node packages/windsurf-plugin/install.mjs --uninstall      # remove again
```

The installer merges into an existing `hooks.json` (other hooks stay), writes the absolute path to `src/hook.ts`, and refuses to touch a file that is not valid JSON. Running it twice is safe. Then install the shared policy pack once per workspace (see the Claude Code README) and start Windsurf from a shell that has the key:

```bash
export OSTRELIO_API_KEY=ost_test_...
export OSTRELIO_BASE_URL=http://127.0.0.1:3100
node packages/agent-guard/install-policies.mjs
windsurf .
```

The JetBrains plugin reads `~/.codeium/hooks.json` instead; copy the generated file there.

## Hooks used

| Windsurf hook | Ostrelio |
| -- | -- |
| `pre_run_command` (`command_line`, `cwd`) | classified as `Bash`: `shell.exec` or a security action |
| `pre_read_code` (`file_path`) | `agent.read`, or `secret.read` for credential files |
| `pre_write_code` (`file_path`, `edits`) | `file.write`, or `agent.tamper` for hook files |
| `pre_mcp_tool_use` (`mcp_server_name`, `mcp_tool_name`, `mcp_tool_arguments`) | `mcp.<server>__<tool>` |
| `pre_user_prompt` (`user_prompt`) | the request and a new execution; never blocks |
| `post_run_command`, `post_read_code`, `post_write_code`, `post_mcp_tool_use` | report `EXECUTED`; the MCP result is kept (last five) as `untrustedInputs` |

The pre hooks run with `show_output: true` so a hold's approval link is visible while the hook waits. Tamper protection covers `.windsurf/hooks.json`, `.devin/hooks.json`, `~/.codeium/windsurf/hooks.json`, `~/.codeium/hooks.json`, the system `Devin`/`Windsurf` `hooks.json` paths, this plugin's files and `~/.ostrelio-you/`.

Configuration is the same `OSTRELIO_*` environment as the other plugins (`OSTRELIO_API_KEY`, `OSTRELIO_BASE_URL`, `OSTRELIO_AGENT_KEY`, `OSTRELIO_AGENT_NAME` default `windsurf-cascade` / "Windsurf", `OSTRELIO_COMPANY_ID`, `OSTRELIO_APPROVAL_TIMEOUT_SECONDS`, `OSTRELIO_DASHBOARD_URL`). Session state is kept per `trajectory_id` in `~/.ostrelio-you/windsurf-sessions/`.

## Sources

- Cascade Hooks (events, JSON input, exit codes, config locations, merge order): https://docs.windsurf.com/windsurf/cascade/hooks (served from https://docs.devin.ai/desktop/cascade/hooks)

## What is tested, and what is not

Unit tests (a fake Control Plane) cover the event mapping, allow, deny, hold approved, hold rejected, MCP action types, tamper, missing key, unreachable server, the request/untrusted-input context, and the installer. They do not run Windsurf: the field names and exit codes come from the documentation above and have not been exercised against a live build.

## Test

```bash
npm test --prefix packages/windsurf-plugin
```
