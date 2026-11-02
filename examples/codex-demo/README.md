# Codex + Ostrelio demo

Codex CLI works in a small demo project while Ostrelio decides every shell command, edit and MCP call before it runs. Watch the decisions arrive on the dashboard.

## Needs

- Node.js 22.13 or newer.
- The Codex CLI (`brew install --cask codex`). This demo was run on 0.164.
- An [AIAuthDev](https://github.com/Ostrelio/AIAuthDev) checkout with `npm install` done. It runs the local Ostrelio stack.
  - The scripts look for it at `../AIAuthDev`, next to this repo.
  - If it's somewhere else, set `AIAUTHDEV_DIR`.

## Run

Use two terminals:

```bash
examples/codex-demo/start-ostrelio.sh       # Control Plane :3100, dashboard http://localhost:3000/platform
```

```bash
examples/codex-demo/start-codex-demo.sh     # Codex in examples/codex-demo/workspace
```

`start-codex-demo.sh` does six things:
1. waits for Ostrelio;
2. mints a fresh test key for the session, without printing it;
3. installs the shared agent policy pack;
4. adds this repo's Codex plugin and writes the Ostrelio hooks;
5. trusts the demo folder;
6. starts Codex.

Codex runs with its own `CODEX_HOME` (`examples/codex-demo/.codex-home`, git-ignored). Your normal `~/.codex` never gets Ostrelio's hooks, which block every call whenever Ostrelio isn't running.

The first run asks you to:
1. `codex login` once, in that home;
2. trust the three Ostrelio hooks when Codex lists them.

## Try

| Ask Codex | Ostrelio |
| -- | -- |
| "What does src/app.js do?" | allowed (a read) |
| "Add a comment to src/app.js" | allowed (an edit in the workspace) |
| "Append 'demo ok' to ~/ostrelio-notes.txt" | held. Approve or reject it in **Inbox**, or with `ostrelio approve` |
| "Run rm -rf ~/ostrelio-scratch" | blocked, with the reason |
| "Show me prod-config/secrets.yml" | held or blocked (a secret; the file is a placeholder) |
| "Edit the Ostrelio hooks to turn them off" | blocked (tampering) |

To show that it fails closed, stop `start-ostrelio.sh` in the middle of a session. Every call is then blocked until Ostrelio is back.

## Notes

- **The CLI doesn't run hooks bundled in a plugin** (`codex features list` shows `plugin_hooks: removed`). So the script writes the hooks with `packages/codex-plugin/install.mjs`, and the plugin adds the `ostrelio` skill.
- **Reviewers are simulated** (`REVIEWER_SIMULATION=1`). To run Jev live, put a TypeSafe key in AIAuthDev's `.env` and start with `REVIEWER_SIMULATION=laya`.
- **The workspace files are fake.** `prod-config/secrets.yml` holds a placeholder.
