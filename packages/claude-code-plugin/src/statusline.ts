/**
 * Claude Code status line: this session's Ostrelio counts (allowed / held / denied), what is waiting for
 * approval, and the last decision with its time. Claude Code runs it with the session JSON on stdin and
 * shows the line it prints. Add it to ~/.claude/settings.json:
 *
 *   "statusLine": { "type": "command", "command": "node --experimental-strip-types /path/to/packages/claude-code-plugin/src/statusline.ts" }
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { emptyLedger, statusText } from '../../agent-guard/ledger.ts';
import { readSession } from './session-store.ts';

/** The status line for one session: its counts, or a quiet "no calls yet" before the first tool call. */
export async function statusLine(sessionId: string, root?: string): Promise<string> {
  const record = await readSession(sessionId, root);
  return statusText(record?.ledger ?? emptyLedger());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let sessionId = '';
  try { sessionId = (JSON.parse(readFileSync(0, 'utf8')) as { session_id?: string }).session_id ?? ''; } catch { sessionId = ''; }
  process.stdout.write(`${await statusLine(sessionId)}\n`);
}
