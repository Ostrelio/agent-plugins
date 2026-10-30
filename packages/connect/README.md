# @ostrelio/connect

Connect an agent to Ostrelio in one command. Not published yet; from a checkout, run `node packages/connect/bin/ostrelio-connect.mjs` wherever the commands below say `npx @ostrelio/connect`. Needs Node 22.13 or newer.

```bash
export OSTRELIO_API_KEY=ost_test_...      # Settings -> API keys in the dashboard
npx @ostrelio/connect claude-code --url http://127.0.0.1:3100
npx @ostrelio/connect omp         --url http://127.0.0.1:3100
npx @ostrelio/connect mcp         --url http://127.0.0.1:3100 --upstream "files=npx -y @modelcontextprotocol/server-filesystem ."
```

`--url` is the workspace API origin: the local demo above, or your hosted workspace. The dashboard's "Connect an agent" dialog shows the same command with the URL filled in, and flips from "Waiting for your agent…" to connected when the first call arrives.

Each run:

1. Checks the key against the workspace (`GET /v1/executions`), so a wrong URL or key fails here, not in the agent.
2. Publishes [`default-policies.json`](../agent-guard/default-policies.json) if the workspace has none of it. Policy routes need an operator, not a workspace key: the local demo uses its development operator key; a hosted workspace needs `OSTRELIO_SESSION` and `OSTRELIO_CSRF` of a signed-in admin (otherwise this step says so and the agent's calls are denied until the pack is installed). `--skip-policies` leaves it out.
3. Writes the harness config in `--dir` (default: the current folder) and prints the line that starts the agent. The key never appears in that line.

| Harness | Writes | Start line |
| -- | -- | -- |
| `claude-code` | `OSTRELIO_*` into `.claude/settings.local.json` `env` (other settings kept) | `claude --plugin-dir <repo>/packages/claude-code-plugin` |
| `omp` | `.ostrelio-you/connect.env` (mode 600) and a `.gitignore` entry | `(set -a; . .ostrelio-you/connect.env; set +a; omp -e <repo>/packages/omp-plugin/ostrelio.ts --config <repo>/packages/omp-plugin/omp-config.yml --tools ...)` |
| `mcp` | `ostrelio.gateway.json` (kept if it exists) and an `ostrelio` entry in `.mcp.json` (or `--mcp-file`, e.g. Claude Desktop's config) | Restart the MCP client; it starts the gateway |

Other options: `--company <id>` records the agent's actions under a company; for `mcp`, `--unmapped allow` forwards tools with no action mapping (the default denies them until you map them in `ostrelio.gateway.json`). The `mcp` harness needs the gateway built (`npm run build --prefix packages/gateway`).

```bash
npm test --prefix packages/connect
```
