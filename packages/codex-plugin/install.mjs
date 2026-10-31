#!/usr/bin/env node
/**
 * Writes Ostrelio's hooks into a Codex hooks.json, keeping any other hooks already there.
 *
 *   node packages/codex-plugin/install.mjs                 $CODEX_HOME/hooks.json, default ~/.codex (every project)
 *   node packages/codex-plugin/install.mjs --project DIR   DIR/.codex/hooks.json (needs a trusted project)
 *   node packages/codex-plugin/install.mjs --uninstall     remove Ostrelio's hooks again
 *
 * Codex runs the command as written, so the path to src/hook.ts is absolute. Codex skips a hook until
 * a person reviews and trusts it in `/hooks`, so the installer cannot switch enforcement on by itself.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const MARKER = 'codex-plugin/src/hook.ts';

/** Timeouts are in seconds. A hold can last minutes, so PreToolUse gets an hour; OSTRELIO_APPROVAL_TIMEOUT_SECONDS (default 600) must stay below it. */
export function buildHooks(pluginDir = PLUGIN_DIR) {
  const command = `node --experimental-strip-types "${join(pluginDir, 'src', 'hook.ts')}"`;
  const group = (timeout, statusMessage) => ({ hooks: [{ type: 'command', command, timeout, statusMessage }] });
  return {
    UserPromptSubmit: [group(30, 'Ostrelio: recording request')],
    PreToolUse: [group(3600, 'Ostrelio: authorizing tool call')],
    PostToolUse: [group(30, 'Ostrelio: recording result')],
  };
}

/** Codex's user config folder: CODEX_HOME when set (as Codex itself reads it), else ~/.codex. */
export const codexHome = (env = process.env) => (env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homedir(), '.codex'));

const isOurs = (group) => Array.isArray(group?.hooks) && group.hooks.some((entry) => typeof entry?.command === 'string' && entry.command.includes(MARKER));

/** `existing` with Ostrelio's hooks replaced (or removed), everything else kept. */
export function merge(existing, ours, uninstall = false) {
  const hooks = {};
  for (const [event, groups] of Object.entries(existing?.hooks ?? {})) {
    const kept = Array.isArray(groups) ? groups.filter((group) => !isOurs(group)) : [];
    if (kept.length) hooks[event] = kept;
  }
  if (!uninstall) for (const [event, groups] of Object.entries(ours)) hooks[event] = [...groups, ...(hooks[event] ?? [])];
  return { ...existing, hooks };
}

function main(argv) {
  const projectAt = argv.indexOf('--project');
  const target = projectAt >= 0 ? join(resolve(argv[projectAt + 1] ?? '.'), '.codex', 'hooks.json') : join(codexHome(), 'hooks.json');
  let existing = {};
  if (existsSync(target)) {
    try { existing = JSON.parse(readFileSync(target, 'utf8')); } catch (error) {
      // Never overwrite a hooks file this script cannot read.
      console.error(`${target} is not valid JSON (${error instanceof Error ? error.message : error}); fix it or add the hooks by hand from the README.`);
      process.exit(1);
    }
  }
  const uninstall = argv.includes('--uninstall');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(merge(existing, buildHooks(), uninstall), null, 2)}\n`);
  console.log(`${uninstall ? 'Removed Ostrelio hooks from' : 'Installed Ostrelio hooks in'} ${target}`);
  if (!uninstall) console.log('Next: start Codex from a shell with OSTRELIO_API_KEY (and OSTRELIO_BASE_URL) exported, open /hooks and trust the three Ostrelio hooks. Codex skips them until you do.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
