# Ostrelio for Codex CLI

Codex CLI hooks that send every shell command, `apply_patch` edit, MCP call and other local tool call to Ostrelio before it runs. They use the same classifier, policy pack, client and hold/approval behaviour as the [Claude Code](../claude-code-plugin/README.md), [Cursor](../cursor-plugin/README.md) and [oh-my-pi](../omp-plugin/README.md) plugins (`packages/agent-guard`).

| Ostrelio decision | What Codex gets |
| -- | -- |
| `ALLOW` | no output, exit 0. `PostToolUse` reports `EXECUTED`. |
| `DENY` | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":…},"systemMessage":…}`. The tool does not run. |
| `REQUIRE_APPROVAL` | The hook waits (default 10 minutes) on `GET /v1/agent/approvals/:id?waitSeconds=`, prints the reason and the approval link on stderr, then allows (with a `systemMessage`), or denies with the approval id and "Do not retry it." Codex's own `ask` decision is not supported, so the wait happens inside the hook. |

Decisions show up in the Ostrelio dashboard at `/platform` (Inbox for anything held, History for the decision).

## Where enforcement stops (read this)

OpenAI documents Codex tool hooks as "a useful guardrail, not a complete enforcement boundary". Specifically:

- **Fails open on a crash.** Codex runs the tool when a `PreToolUse` hook fails: any exit code other than 0 and 2, a timeout, or a hook error. There is no fail-closed setting. The hook catches every error it can reach (Ostrelio unreachable, missing key, bad answer, unreadable input) and turns it into a deny, but if `node` cannot start (not on `PATH`, Node older than 22.13) or the process is killed, the tool runs. Output Codex does not support (`continue`, `stopReason`, `suppressOutput`, `ask`) also fails open, so this hook never sends them.
- **Not every tool is hooked.** Hosted tools such as `WebSearch` do not use the hook path, "some specialized tool paths can opt out", and `write_stdin` does not run `PreToolUse` again for a command that already passed it. A command is authorized once, when it starts.
- **Hooks must be trusted.** Codex skips a non-managed hook until a person reviews and trusts its exact definition in `/hooks`, so the installer cannot switch enforcement on by itself, and any edit to the hook (including re-running the installer from a different checkout path) needs a new review. Project hooks only load in a trusted project. `--dangerously-bypass-hook-trust` and `[features] hooks = false` turn hooks off.
- **A person can still disable hooks** with `/hooks` or by editing `~/.codex/`. Tamper rules only stop the agent from doing it (below). To stop a person, deploy the hooks as managed hooks in `requirements.toml` (`allow_managed_hooks_only = true`), which the installer does not do.
- **Shell commands run in Codex's sandbox after the hook.** Ostrelio sees the command text. A command that hides its effect inside a script file is classified by what is visible.

## Install

The usual way is the Codex plugin: `codex plugin marketplace add Ostrelio/agent-plugins`, then install **Ostrelio** in `/plugins`. The plugin is built from this package into `plugins/ostrelio-codex` (see the [repo README](../../README.md)). The plugin hooks still need trusting in `/hooks`. Installed that way, sessions live in the plugin's data folder (`PLUGIN_DATA`), and the installed plugin folder is tamper-protected.

Without the plugin system, write the hooks into `hooks.json` directly:

Needs Node.js 22.13 or newer on `PATH` (the hooks run `src/hook.ts` with type stripping).

```bash
node packages/codex-plugin/install.mjs                  # ~/.codex/hooks.json, every project
node packages/codex-plugin/install.mjs --project DIR    # DIR/.codex/hooks.json (trusted projects only)
node packages/codex-plugin/install.mjs --uninstall      # remove again
```

The installer merges into an existing `hooks.json` (other hooks stay), writes the absolute path to `src/hook.ts`, and refuses to touch a file that is not valid JSON. Running it twice is safe. Do not keep Ostrelio's hooks in both `hooks.json` and an inline `[hooks]` table of the same layer. Then install the shared policy pack once per workspace (see the Claude Code README), start Codex from a shell that has the key, and trust the hooks:

```bash
export OSTRELIO_API_KEY=ost_test_...
export OSTRELIO_BASE_URL=http://127.0.0.1:3100
node packages/agent-guard/install-policies.mjs
codex          # then /hooks: review and trust the three Ostrelio hooks
```

## Hooks used

| Codex hook | Ostrelio |
| -- | -- |
| `PreToolUse`, no matcher (`tool_name`, `tool_input`, `tool_use_id`) | `Bash` is `shell.exec` or a security action; `apply_patch` is `file.write`, `file.delete`, `agent.tamper` (files read from the `*** Update/Add/Delete File:` headers of `tool_input.command`); `mcp__<server>__<tool>` is `mcp.<server>__<tool>`; other local tools keep their own action type, except `update_plan` (harmless read), `view_image` (read) and `spawn_agent` (`agent.spawn`) |
| `UserPromptSubmit` (`prompt`) | the request and a new execution; prints nothing, because plain text on stdout would become model context |
| `PostToolUse`, no matcher (`tool_response`) | reports `EXECUTED` and keeps the last five results as `untrustedInputs` |

`PreToolUse` has `timeout: 3600` seconds (Codex's default is 600) so a hold can outlast it. `OSTRELIO_APPROVAL_TIMEOUT_SECONDS` (default 600) must stay below it. Tamper protection covers `.codex/hooks.json`, `.codex/config.toml` and `.codex/hooks/` (project or `~/.codex/`), this plugin's files and `~/.ostrelio-you/`.

Configuration is the same `OSTRELIO_*` environment as the other plugins (`OSTRELIO_API_KEY`, `OSTRELIO_BASE_URL`, `OSTRELIO_AGENT_KEY`, `OSTRELIO_AGENT_NAME` default `codex-cli` / "Codex CLI", `OSTRELIO_COMPANY_ID`, `OSTRELIO_APPROVAL_TIMEOUT_SECONDS`, `OSTRELIO_DASHBOARD_URL`). Session state is kept per `session_id` in `~/.ostrelio-you/codex-sessions/`.

## Sources

- Hooks (events, config, matchers, input and output, tool coverage, trust): https://developers.openai.com/codex/hooks
- Exit-code and failure behaviour of `PreToolUse` (a failed hook does not block): https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/pre_tool_use.rs
- Wire schemas: https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated

## What is tested, and what is not

Unit tests (a fake Control Plane) cover the event mapping, allow, deny, patch classification, hold approved, hold rejected, MCP action types, tamper, missing key, unreachable server, the request/untrusted-input context, and the installer. They do not run Codex: the field names and answers come from the documentation above and have not been exercised against a live build.

## Test

```bash
npm test --prefix packages/codex-plugin
```
