#!/usr/bin/env node
/**
 * Writes Ostrelio's hooks into a Cursor hooks.json, keeping any other hooks already there.
 *
 *   node packages/cursor-plugin/install.mjs                 ~/.cursor/hooks.json (every project)
 *   node packages/cursor-plugin/install.mjs --project DIR   DIR/.cursor/hooks.json
 *   node packages/cursor-plugin/install.mjs --uninstall     remove Ostrelio's hooks again
 *
 * Cursor runs the command as written, so the path to src/hook.ts is absolute.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const MARKER = 'cursor-plugin/src/hook.ts';
const EDIT_TOOLS = 'Write|StrReplace|Edit|MultiEdit|Delete|EditNotebook|Task';

/** Hold time: an approval can take minutes, so the blocking hooks get an hour. OSTRELIO_APPROVAL_TIMEOUT_SECONDS (default 600) must stay below it. */
export function buildHooks(pluginDir = PLUGIN_DIR) {
  const command = `node --experimental-strip-types "${join(pluginDir, 'src', 'hook.ts')}"`;
  const blocking = { command, timeout: 3600, failClosed: true };
  return {
    beforeSubmitPrompt: [{ command, timeout: 30, failClosed: true }],
    beforeShellExecution: [blocking],
    beforeMCPExecution: [blocking],
    beforeReadFile: [blocking],
    preToolUse: [{ ...blocking, matcher: EDIT_TOOLS }],
    afterShellExecution: [{ command, timeout: 30 }],
    afterMCPExecution: [{ command, timeout: 30 }],
    postToolUse: [{ command, timeout: 30, matcher: EDIT_TOOLS }],
  };
}

const isOurs = (entry) => typeof entry?.command === 'string' && entry.command.includes(MARKER);

/** `existing` with Ostrelio's hooks replaced (or removed), everything else kept. */
export function merge(existing, ours, uninstall = false) {
  const hooks = {};
  for (const [event, entries] of Object.entries(existing?.hooks ?? {})) {
    const kept = Array.isArray(entries) ? entries.filter((entry) => !isOurs(entry)) : [];
    if (kept.length) hooks[event] = kept;
  }
  if (!uninstall) for (const [event, entries] of Object.entries(ours)) hooks[event] = [...entries, ...(hooks[event] ?? [])];
  return { ...existing, version: existing?.version ?? 1, hooks };
}

function main(argv) {
  const projectAt = argv.indexOf('--project');
  const target = projectAt >= 0 ? join(resolve(argv[projectAt + 1] ?? '.'), '.cursor', 'hooks.json') : join(homedir(), '.cursor', 'hooks.json');
  let existing = {};
  try { existing = JSON.parse(readFileSync(target, 'utf8')); } catch { /* a new file */ }
  const uninstall = argv.includes('--uninstall');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(merge(existing, buildHooks(), uninstall), null, 2)}\n`);
  console.log(`${uninstall ? 'Removed Ostrelio hooks from' : 'Installed Ostrelio hooks in'} ${target}`);
  if (!uninstall) console.log('Start Cursor from a shell with OSTRELIO_API_KEY (and OSTRELIO_BASE_URL) exported, e.g. `cursor .`');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
