# Ostrelio for oh-my-pi

An omp (and pi) extension that sends every tool call to Ostrelio before it runs. That includes reads, file edits, shell commands, MCP tools and subagents. Nothing needs wrapping and no tools need mapping.

| Ostrelio decision | What omp does |
| -- | -- |
| `ALLOW` | Runs the tool, then reports `EXECUTED` or `FAILED`. |
| `DENY` | Blocks the call and tells the model why. |
| `REQUIRE_APPROVAL` | Holds the call and shows "waiting for approval" in omp until a person approves or rejects it in the dashboard, then runs it or blocks it. |

The harness runs the hook, not the model, so a prompt injection cannot skip it. If Ostrelio cannot be reached, the call is blocked.

## Run it

```bash
OSTRELIO_API_KEY=ost_test_... omp \
  -e /path/to/packages/omp-plugin/ostrelio.ts \
  --config /path/to/packages/omp-plugin/omp-config.yml \
  --tools read,grep,find,glob,edit,write,bash,todo
```

- `omp-config.yml` raises omp's extension timeout (`extensionHandlers.toolCallTimeoutMs`, 30 s by default) to 15 minutes, so a held call can wait for a person.
- `--tools` leaves out `eval`. omp's `eval` runs arbitrary code, and that code calls other tools without passing through this hook. The default policies deny `code.exec` anyway; leaving it out just saves the model wasted attempts.
- Install the extension outside the project the agent works in, for example in the user's own omp config (`~/.omp/agent/extensions/`). The default policies deny any change the agent makes to the plugin's folder, but a copy inside the project is one `git checkout` away from a different version.

| Env | Meaning |
| -- | -- |
| `OSTRELIO_API_KEY` | Workspace API key. Required; without it every call is blocked. |
| `OSTRELIO_BASE_URL` | API origin. Default `http://127.0.0.1:3100`. |
| `OSTRELIO_AGENT_KEY`, `OSTRELIO_AGENT_NAME` | How the agent appears in the dashboard. Default `omp-agent`, "omp agent". |
| `OSTRELIO_COMPANY_ID` | Company the session's actions are recorded under. |
| `OSTRELIO_APPROVAL_TIMEOUT_SECONDS` | How long a held call waits. Default 600. |
| `OSTRELIO_DASHBOARD_URL` | Dashboard origin for the approval link. Default `http://localhost:3000`. |
| `OSTRELIO_DEBUG_TIMING` | When set, each call prints `[ostrelio-timing] <tool> <outcome> <ms>` on stderr (used by `npm run test:omp-live`). |

## Holds and timing

- A held call tells the person at once: omp shows a warning with the reason, `<dashboard>/platform/approvals?approvalId=<id>` and the terminal command, and the status line reads "waiting for approval". In headless runs (`omp -p`) the message goes to stderr. Approving it resumes the tool within about a second (the wait is a 500 ms long-poll).
- After every call the status line shows this session's counts and the last decision with how long Ostrelio took and when: `Ostrelio ✓ 12 allowed · ⏸ 2 held · ✗ 1 denied · last ✓ approved write (4.2 s) 14:03:22`. Identical denied calls answered from the cache add `↺ N repeats`.
- Policy rules can set `review: false` on an `ALLOW` rule (the pack does for reads inside the workspace and plain listing commands). Those calls skip the Jev and Laya reviewers, so they return in tens of milliseconds and never get a reviewer hold. Reviewers still run on everything else.
- Paths are read like a shell reads them: `~` and `$HOME` expand, and quoted or escaped paths with spaces count as one path, so `rm -rf '/Volumes/My Disk/x'` and `rm -rf ~/x` are recognised as outside the workspace.

## Approve in the terminal

1. Sign in once as a reviewer: `node --experimental-strip-types packages/agent-guard/cli.ts login --url http://127.0.0.1:3100` (or `ostrelio login` when the package is installed). It asks for your reviewer email and password and stores a reviewer session in `~/.ostrelio-you/reviewer.json` (owner-only, covered by the tamper rules). It is never the agent's API key, which the approval routes refuse.
2. When a call is held, omp opens a prompt: **Approve**, **Reject** or **Decide in the dashboard**. Your choice is acted on by this extension as you, not by the model. The prompt closes by itself if someone decides in the dashboard first.
3. `/ostrelio` shows the session counts and what is waiting; `/ostrelio approve [id]` and `/ostrelio reject [id]` act on a waiting call by id (the id is optional when only one is waiting).
4. Without a login the held message says so, and prints the command that approves from another terminal: `ostrelio approve <approval id>`. An agent that runs the reviewer CLI is classified `agent.tamper`.

## Session summary and denials

- When the agent finishes, omp prints a summary: allowed / held (approved, rejected) / denied counts for the run, anything still waiting for approval, and `<dashboard>/platform/agents/<agent>/sessions/<execution>`, the session timeline.
- A denied call returns what was blocked, why, and what the model can do instead: keep working inside the workspace, ask the person, or stop. The same call, asked again in the same session, is answered from a local cache without calling Ostrelio, so a retry loop costs nothing; the summary counts those repeats. A hold nobody answered is not cached.

## Live test with a real model

`npm run test:omp-live` runs the four runbook scenarios (read in the workspace, edit outside it, `rm -rf` outside it, edit Ostrelio's own config) and a repeated denied call through `omp -p --model ${OMP_MODEL:-openai-codex/gpt-6-luna}` against a running demo, then approves and rejects a held edit in the terminal through omp's RPC mode with a reviewer signed in by the real `ostrelio login` (into a temporary home, not yours). It publishes the agent pack, mints a test key (never printed), and prints a table of scenario, decision, expected, time, the end-of-run summary counts, whether the timeline link and the Approve / Reject prompt appeared, and whether the status line showed the live counts. It is local only and not part of CI, because it needs your omp login and calls a real model.

```bash
DEMO_NO_OPEN=1 DEMO_AGENT=0 npm run demo     # one terminal
npm run test:omp-live                         # another; DEMO_API_PORT / DEMO_WEB_PORT if you moved the demo
```

## What Ostrelio sees

| omp tools | Action type | Context policies can test |
| -- | -- | -- |
| `read`, `grep`, `find`, `glob`, `todo`, `web_search` … | `agent.read` | `tool`, `path`, `pathScope` (`workspace` or `outside`) |
| `edit`, `write`, `ast_edit` | `file.write` (`file.delete` if a patch deletes a file) | `paths`, `pathScope` (`unknown` when no path can be found) |
| `bash` | `shell.exec`, or one of the security actions below | `command`, `program`, `programs` (space-padded, e.g. `" ls rm "`, including the program after `sudo`, `env` or `xargs`), `subcommand`, `compound` (`yes` for chains, pipes, `$()`, redirects) |
| `ssh` | `shell.remote` | as `bash`, plus `host` |
| `eval` | `code.exec` | `language`, `code` |
| `task` | `agent.spawn` | `task` |
| MCP tools (called directly, or by writing JSON to `xd://mcp__<server>_<tool>`) | `mcp.<server>_<tool>` | `args` (the tool's arguments), `via` |
| anything else | `tool.<name>` | `args` |

### Security actions

Some calls get their own action type, so a policy can hold or deny them however they are phrased. The plugin checks the paths each call names, and for `bash` also the scripts passed to `bash -c` and `eval`. When a command matches several, the first row wins.

| Action type | What it covers | Extra context |
| -- | -- | -- |
| `agent.tamper` | Editing, moving or deleting Ostrelio's own enforcement: this plugin's folder, `omp-config.yml`, `.ostrelio-you/`, `.mcp.json`, `ostrelio*.json` (gateway config and policies), `~/.omp/`, `.claude/settings*.json` and `.claude/hooks/`. Also `rm -rf` of a folder that contains them, and setting or unsetting `OSTRELIO_*`. Covers `edit`, `write`, `delete`, `move`, `bash` (`rm`, `mv`, `sed -i`, `tee`, `>`) and MCP tools, `xd://` included. | `target` |
| `audit.tamper` | Clearing shell history (`history -c`, `unset HISTFILE`, writing `~/.*history`), deleting or truncating `/var/log/**`, `journalctl --vacuum`, `log erase`, `auditctl -e 0`, and stopping security agents (auditd, osquery, Falcon, SentinelOne, …). | |
| `secret.exfiltrate` | A command that reads a credential and also sends data over the network, such as `cat ~/.ssh/id_rsa \| curl -d @- …`. | `secret`, plus the network fields |
| `code.git.force_push`, `code.git.branch_delete`, `code.git.reset_hard` | `git push --force` / `-f` / `+ref`, `git branch -D` / `git push --delete` / `:ref`, and `git reset --hard`. | `branch` (`""` when the command does not name one) |
| `infra.change`, `infra.destroy` | `aws`, `gcloud`, `gsutil`, `az`, `kubectl`, `helm`, `terraform`, `tofu` and `pulumi` commands that change (`apply`, `scale`, `set-iam-policy`) or delete (`delete`, `terminate`, `destroy`, `rm`). An unknown verb counts as a change. | `cli`, `verb`, `effect` |
| `network.upload`, `network.request` | `curl`, `wget`, `scp`, `rsync` to a remote, `nc`, `socat`, `telnet`, `ftp`, `sftp` and `ssh`. Uploads are POSTs, form or file uploads, copies to a remote, and raw sockets. | `network` (`upload` or `download`), `host`, `domain`, `hostScope` (`local` or `external`) |
| `secret.read` | Reading `.env*` (not `.env.example`), `*.env`, `~/.ssh/**`, `~/.aws/**`, `~/.config/gcloud/**`, `~/.kube/config`, `.netrc`, `.npmrc`, `*.pem`, `*.key`, `id_rsa*`, shell history, a keychain or vault CLI, or printing secret env vars. Read tools and `bash`. | `secret` |
| `infra.read` | Cloud CLI reads: `get`, `describe`, `list`, `plan`, `show`. | `cli`, `verb`, `effect` |

The plugin only classifies calls; the workspace's policies and reviewers decide. A policy's ALLOW still needs both reviewers (Jev and Laya) to agree, and they can turn a hold into a denial. So the defaults deny only `agent.tamper` and leave other risky calls to a person or the reviewers.

These checks read the command text. A command built at run time (a script file, base64, a variable holding the path) can get past them, which is why every command that is not on the read-only list is held for approval anyway.

Every call also carries the session's context:
- **`request`**: what the person asked omp to do.
- **`agentSaid`**: what the agent last wrote before acting, sent only when the agent wrote something.

Each new request starts a new Ostrelio execution, whose objective is the request. Approvers see both fields in the dashboard under "Agent context". A reviewer model can compare the request with the action: a mismatch, such as `rm -rf` while asked to fix a typo, is how an injected instruction shows up.

## Default policies

`node install-policies.mjs` creates and publishes [`default-policies.json`](../agent-guard/default-policies.json) (shared with the Claude Code plugin). On the local demo it uses the development operator key. With a signed-in admin, set `OSTRELIO_SESSION` and `OSTRELIO_CSRF`. Running it again is safe.

- Reads and edits inside the workspace are allowed. Edits outside the workspace, and edits whose path cannot be found, are held.
- `rm -rf` outside the workspace is denied. Other deletes, and `rm` inside the workspace, are held.
- Deleting or moving files needs approval.
- A single read-only command (`ls`, `cat`, `grep`, …) runs without review. Every other shell command needs approval, `rm` and `git push` included.
- `sudo` and `code.exec` are denied.
- Changing Ostrelio's own enforcement is denied.
- Other risky calls are held, each with its own reason: clearing history or logs, sending credentials out, reading credentials, uploads, cloud changes and deletions, destructive git (with protected branches called out), paste and file-drop hosts, and edits to `.github/workflows/`.
- A single fetch from a named host and read-only cloud CLI commands are allowed once the reviewers agree.
- Any action type no policy covers is denied.

The `starts_with` and `contains` conditions used here are workspace-policy operators, so the same rules can be edited in the dashboard.

### Example: payment tools

[`examples/payments-policies.json`](examples/payments-policies.json) governs the sample payments MCP server (`packages/gateway/examples/sample-tools.mjs`) when it runs behind this plugin:
- balance reads are allowed;
- refunds up to $250 are allowed;
- refunds over $250 are held, and refunds over $2,500 are denied;
- payments, wires and payout-account changes are held;
- wires over $10,000 are denied.

```bash
node packages/omp-plugin/install-policies.mjs packages/omp-plugin/examples/payments-policies.json
```

## Test

```bash
npm test --prefix packages/omp-plugin
```
