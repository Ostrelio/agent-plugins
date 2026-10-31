# Ostrelio agent plugins

These plugins put Ostrelio in front of every tool call an AI agent makes. Ostrelio either allows the call, holds it for a person, or blocks it with the reason. This repo holds the agent side; the Control Plane and the dashboard live in [AIAuthDev](https://github.com/Ostrelio/AIAuthDev).

| Folder | What it is |
| -- | -- |
| [`plugins/ostrelio-codex`](plugins/ostrelio-codex) | **The installable Codex plugin**, built from `packages/codex-plugin`. Do not edit it by hand. |
| [`packages/agent-guard`](packages/agent-guard) | The shared core: tool-call classifier, Ostrelio client, session ledger, `ostrelio` reviewer CLI, default policy pack |
| [`packages/codex-plugin`](packages/codex-plugin/README.md) | Codex CLI hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`) |
| [`packages/claude-code-plugin`](packages/claude-code-plugin/README.md) | Claude Code plugin |
| [`packages/omp-plugin`](packages/omp-plugin/README.md) | oh-my-pi (omp) and pi extension |
| [`packages/cursor-plugin`](packages/cursor-plugin/README.md), [`gemini-cli-plugin`](packages/gemini-cli-plugin/README.md), [`windsurf-plugin`](packages/windsurf-plugin/README.md) | Cursor, Gemini CLI and Windsurf hooks |
| [`packages/connect`](packages/connect/README.md) | `ostrelio-connect`: one command to wire up Claude Code, omp or an MCP client |
| [`packages/gateway`](packages/gateway/README.md), [`packages/sdk`](packages/sdk/README.md) | The MCP gateway, and the TypeScript SDK it and custom agents use |

All of them need Node.js 22.13 or newer.

## Codex: install the plugin

1. Add this repo as a plugin marketplace:

   ```bash
   codex plugin marketplace add Ostrelio/agent-plugins
   ```

   For a local checkout, use `codex plugin marketplace add ./ostrelio-agent-plugins` instead.
2. Open `/plugins` in Codex, install **Ostrelio**, and start a new session.
3. Open `/hooks` and trust the three Ostrelio hooks. Codex skips plugin hooks until a person trusts them, and installing the plugin doesn't count as trust.
4. Start Codex from a shell where the key and URL are set:

   ```bash
   export OSTRELIO_API_KEY=ost_test_...
   export OSTRELIO_BASE_URL=http://127.0.0.1:3100
   codex
   ```

Install the shared policy pack once per workspace with `node packages/agent-guard/install-policies.mjs`.

**Codex CLI:** the CLI doesn't run hooks bundled in a plugin. In Codex 0.164, `codex features list` shows `plugin_hooks` as `removed`. So in the CLI, the plugin adds only the skill, and the hooks come from the installer, which writes them into `$CODEX_HOME/hooks.json` (default `~/.codex`):

```bash
node packages/codex-plugin/install.mjs
```

Then trust them in `/hooks`. The desktop app loads the plugin's hooks itself.

The plugin also ships an `ostrelio` skill. It tells Codex what a block or a hold means: don't retry a blocked call, and pass on the approval link for a held one. Sessions are kept in the plugin's data folder.

Codex documents plugin hooks as a guardrail, not a complete enforcement boundary. Read [where enforcement stops](packages/codex-plugin/README.md#where-enforcement-stops-read-this). Hooks also don't run in the IDE extension or in cloud tasks. They are not allowed in the public plugin directory either, so the plugin is installed from this marketplace.

Without the plugin system, `node packages/codex-plugin/install.mjs` writes the same hooks into `~/.codex/hooks.json`.

## Develop

```bash
npm test               # every plugin package, plus the built Codex plugin run as Codex runs it
npm run build:codex    # rebuild plugins/ostrelio-codex after changing packages/
npm run check:codex    # fails if plugins/ostrelio-codex is stale (CI runs this)
```

The SDK and gateway use vitest: run `npm ci && npm test` in each.

Their integration suites boot the Control Plane straight from AIAuthDev's `Backend/`. To run them here, link a checkout in with `ln -s ../AIAuthDev/Backend Backend`. Without it, only their unit tests run, and AIAuthDev's CI runs the integration suites.

These packages were copied from `AIAuthDev/packages/` and are still there too. AIAuthDev will drop its copies once this repo is the source of truth. Until then, make each change in both.
