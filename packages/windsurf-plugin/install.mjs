#!/usr/bin/env node
/**
 * Writes Ostrelio's hooks into a Windsurf (Cascade) hooks.json, keeping any other hooks already there.
 *
 *   node packages/windsurf-plugin/install.mjs                 ~/.codeium/windsurf/hooks.json (every workspace)
 *   node packages/windsurf-plugin/install.mjs --project DIR   DIR/.windsurf/hooks.json (DIR/.devin/hooks.json if that file exists)
 *   node packages/windsurf-plugin/install.mjs --uninstall     remove Ostrelio's hooks again
 *
 * Windsurf runs the command through `bash -c`, so the path to src/hook.ts is absolute and quoted.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const MARKER = 'windsurf-plugin/src/hook.ts';
const PRE = ['pre_user_prompt', 'pre_run_command', 'pre_read_code', 'pre_write_code', 'pre_mcp_tool_use'];
const POST = ['post_run_command', 'post_read_code', 'post_write_code', 'post_mcp_tool_use'];

/** Windsurf has no hook timeout setting. `show_output` makes a hold's approval link visible while the hook waits. */
export function buildHooks(pluginDir = PLUGIN_DIR) {
  const command = `node --experimental-strip-types "${join(pluginDir, 'src', 'hook.ts')}"`;
  const hooks = {};
  for (const event of PRE) hooks[event] = [{ command, show_output: true }];
  for (const event of POST) hooks[event] = [{ command, show_output: false }];
  return hooks;
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
  return { ...existing, hooks };
}

/** Windsurf reads `.devin/hooks.json` first and falls back to `.windsurf/hooks.json`; write where it will be read. */
export function projectTarget(dir) {
  const devin = join(dir, '.devin', 'hooks.json');
  return existsSync(devin) ? devin : join(dir, '.windsurf', 'hooks.json');
}

function main(argv) {
  const projectAt = argv.indexOf('--project');
  const target = projectAt >= 0 ? projectTarget(resolve(argv[projectAt + 1] ?? '.')) : join(homedir(), '.codeium', 'windsurf', 'hooks.json');
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
  if (!uninstall) console.log('Start Windsurf from a shell with OSTRELIO_API_KEY (and OSTRELIO_BASE_URL) exported, e.g. `windsurf .`, so the hooks inherit them. Hooks do not run in Restricted Mode.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
