# Ostrelio for Claude Code

A Claude Code plugin that sends every tool call to Ostrelio before it runs. Reads, edits, shell commands, web fetches and MCP tools all go through the same classifier as the [oh-my-pi plugin](../omp-plugin/README.md). The harness runs the hooks, not the model, so a prompt cannot skip them. If Ostrelio cannot be reached, the call is blocked.

| Ostrelio decision | What Claude Code does |
| -- | -- |
| `ALLOW` | The `PreToolUse` hook returns `permissionDecision: "allow"`. `PostToolUse` reports `EXECUTED`. |
| `DENY` | The hook returns `permissionDecision: "deny"` with Ostrelio's reason, which Claude sees. |
| `REQUIRE_APPROVAL` | The hook waits (default 10 minutes) on `GET /v1/agent/approvals/:id?waitSeconds=`. Approved calls run. Anything else is denied with the approval id and "Do not retry it." |
| Unreachable, or no API key | The hook denies the call. `onFailure: "block"` also blocks the tool if the hook process crashes. |

Decisions show up in the Ostrelio dashboard at `/platform` (Inbox for anything held, History for the decision itself).

## Install

The plugin root is this directory. It needs Node.js 22.13 or newer on `PATH` (`node`), because the hooks run `src/hook.ts` with type stripping.

```bash
claude --plugin-dir /path/to/packages/claude-code-plugin
```

Claude Code loads `.claude-plugin/plugin.json` and `hooks/hooks.json`. The hook file registers five events:

| Event | Role |
| -- | -- |
| `PreToolUse` (`matcher: "*"`) | Classify and authorize every tool, including `mcp__*`. Timeout 3600 seconds, so a hold can outlast the default 600 second command-hook limit. |
| `UserPromptSubmit` | Store the person's request and start a new Ostrelio execution for that prompt. The execution is opened on the first tool call, with the request as its objective. |
| `PostToolUse` | Report `EXECUTED` and keep the tool result. |
| `PostToolUseFailure` | Report `FAILED`. Permission denials do not fire this event. |
| `Stop` | Print the session summary: counts, anything still waiting, and the session timeline link. |

Each hook is its own process. The plugin keeps the request, the execution id, the last five tool results, the decision ids and the session counts in `~/.ostrelio-you/claude-sessions/`. That directory is covered by the tamper rules.

`OSTRELIO_APPROVAL_TIMEOUT_SECONDS` must stay below the `PreToolUse` timeout (3600). The default is 600.

## At the terminal

- **Approve a held call from another terminal.** Sign in once with `node --experimental-strip-types /path/to/packages/agent-guard/cli.ts login --url http://127.0.0.1:3100` (`ostrelio login`): it stores a reviewer session in `~/.ostrelio-you/reviewer.json`, never the agent's API key. A held call prints its reason, the dashboard link and the exact `ostrelio approve <approval id>` command (hook stderr, shown in verbose mode and by `claude -p`; also the hook's `systemMessage`). `ostrelio pending` lists what is waiting; `approve` and `reject` act on one by id, or on the only one waiting. Claude Code's hook API has no way to prompt in its own session while a hook is waiting, so this is the closest equivalent to omp's in-terminal prompt. An agent that runs the reviewer CLI is classified `agent.tamper`.
- **Live counts.** `src/statusline.ts` prints `Ostrelio ✓ 12 allowed · ⏸ 2 held · ✗ 1 denied · ⏳ waiting for approval: … · last ✓ allowed Read (41 ms) 14:03:22`. Add it to `~/.claude/settings.json`:
  `"statusLine": { "type": "command", "command": "node --experimental-strip-types /path/to/packages/claude-code-plugin/src/statusline.ts" }`
- **Session summary.** The `Stop` hook prints the run's counts, anything still waiting and `<dashboard>/platform/agents/<agent>/sessions/<execution>`.
- **Smarter denials.** A denial tells the model what was blocked, why, and what to do instead (stay in the workspace, ask the person, or stop). An identical call already denied in the session is answered from the session record without calling Ostrelio, and counted in the summary.

## Configuration

| Env | Meaning |
| -- | -- |
| `OSTRELIO_API_KEY` | Workspace API key (`ost_test_…` or `ost_live_…`). Required. Without it every tool call is denied. |
| `OSTRELIO_BASE_URL` | API origin. Default `http://127.0.0.1:3100`. |
| `OSTRELIO_AGENT_KEY`, `OSTRELIO_AGENT_NAME` | How the agent appears in the dashboard. Default `claude-code-agent`, "Claude Code". |
| `OSTRELIO_COMPANY_ID` | Company the session's actions are recorded under. Omit it on a local demo that has one workspace. |
| `OSTRELIO_APPROVAL_TIMEOUT_SECONDS` | How long a held call waits. Default 600. |
| `OSTRELIO_DASHBOARD_URL` | Dashboard origin for the approval link a hold prints (`<dashboard>/platform/approvals?approvalId=<id>`). Default `http://localhost:3000`. |

A hold is announced at once on the hook's stderr with the reason and that link, and the hook's result carries a `systemMessage` with the same text and how long the wait took. Policy rules with `review: false` (the pack sets it on workspace reads and plain listing commands) skip the Jev and Laya reviewers, so those calls return in tens of milliseconds.

```bash
export OSTRELIO_API_KEY=ost_test_...
export OSTRELIO_BASE_URL=http://127.0.0.1:3100
claude --plugin-dir /path/to/packages/claude-code-plugin
```

## What Ostrelio sees

Tool names are Claude Code's (`Bash`, `Read`, `Edit`, …). Action types match the omp plugin.

| Claude Code tools | Action type | Context policies can test |
| -- | -- | -- |
| `Read`, `Grep`, `Glob`, `WebSearch` | `agent.read` | `tool`, `path`, `pathScope` (`workspace` or `outside`; a `Glob` pattern counts when it is absolute or leaves the workspace) |
| `Edit`, `MultiEdit`, `Write`, `NotebookEdit` | `file.write` (or `file.delete` when a patch deletes) | `paths`, `pathScope` (`unknown` when no path can be found), `change` |
| `Bash` | `shell.exec`, or one of the security actions below | `command`, `program`, `programs`, `subcommand`, `compound`; `recursiveDelete` and `deleteScope` when the command runs `rm` |
| `WebFetch` | `network.request` | `url`, `host`, `domain`, `hostScope`, `plainFetch` |
| `Task`, `Agent` | `agent.spawn` | `task` |
| `mcp__<server>__<tool>` | `mcp.<server>__<tool>` | `args` |

Security actions (`agent.tamper`, `audit.tamper`, `secret.read`, `secret.exfiltrate`, `network.upload`, `network.request`, `infra.*`, `code.git.*`) are the ones documented in the [omp plugin](../omp-plugin/README.md). For this harness, tamper also covers:

- this plugin's files
- `.claude/settings*.json`, `.claude/hooks/` and `.claude/plugins/` (project or `~/.claude/`)
- `.claude-plugin/`
- `~/.ostrelio-you/` (the key and the session files)
- setting or unsetting `OSTRELIO_*`

Reading those files is not tampering. Deleting `~/.claude` or `~/.omp` is.

Every call also carries `request` (from `UserPromptSubmit`), `agentSaid` (the last assistant text in the session transcript, when there is one) and `untrustedInputs` (the last five tool results, trimmed, each with its source). A new prompt clears them and opens a new execution.

## Default policies

The pack is shared with omp: [`packages/agent-guard/default-policies.json`](../agent-guard/default-policies.json). Install it once per workspace. On the local demo the development operator key is enough. With a signed-in admin, set `OSTRELIO_SESSION` and `OSTRELIO_CSRF`. Running it again is safe.

```bash
node packages/agent-guard/install-policies.mjs
# or, same installer:
node packages/omp-plugin/install-policies.mjs
```

A fresh install then has these rules, among the rest of the pack:

- reads inside the workspace are allowed
- edits inside the workspace are allowed; edits outside it (and edits with no path) are held (`POL-AGT-23`)
- `rm -rf` outside the workspace is denied (`POL-AGT-22`); other deletes are held
- changing Ostrelio's own enforcement, including this plugin and Claude Code's hook settings, is denied (`POL-AGT-10`)

An action type no enforcing policy matches is held when some policy names that type, and denied when none does. Install the pack before the first session, or every call is denied.

Workspace allows still need Jev and Laya to agree. On the local demo (`REVIEWER_SIMULATION=1`) they follow the policy. A held call waits in `/platform` Inbox until someone approves it. The History view shows the decision, the reason and the agent context (`request`, `agentSaid`, `untrustedInputs`).

## Test

```bash
npm test --prefix packages/claude-code-plugin
npm test --prefix packages/agent-guard
npm test --prefix packages/omp-plugin
```
