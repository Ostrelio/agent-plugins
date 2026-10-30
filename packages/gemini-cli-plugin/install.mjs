#!/usr/bin/env node
/**
 * Writes Ostrelio's hooks into a Gemini CLI settings.json, keeping every other setting and hook.
 *
 *   node packages/gemini-cli-plugin/install.mjs                 ~/.gemini/settings.json (every project)
 *   node packages/gemini-cli-plugin/install.mjs --project DIR   DIR/.gemini/settings.json
 *   node packages/gemini-cli-plugin/install.mjs --uninstall     remove Ostrelio's hooks again
 *
 * Gemini runs the command as written, so the path to src/hook.ts is absolute.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const MARKER = 'gemini-cli-plugin/src/hook.ts';

/** Timeouts are in milliseconds. A hold can last minutes, so BeforeTool gets an hour; OSTRELIO_APPROVAL_TIMEOUT_SECONDS (default 600) must stay below it. */
export function buildHooks(pluginDir = PLUGIN_DIR) {
  const command = `node --experimental-strip-types "${join(pluginDir, 'src', 'hook.ts')}"`;
  const hook = (name, timeout) => ({ matcher: '*', hooks: [{ name, type: 'command', command, timeout }] });
  return {
    BeforeAgent: [hook('ostrelio-prompt', 30_000)],
    BeforeTool: [hook('ostrelio-authorize', 3_600_000)],
    AfterTool: [hook('ostrelio-report', 30_000)],
  };
}

const isOurs = (group) => Array.isArray(group?.hooks) && group.hooks.some((entry) => typeof entry?.command === 'string' && entry.command.includes(MARKER));

/** `existing` with Ostrelio's hooks replaced (or removed), everything else kept. */
export function merge(existing, ours, uninstall = false) {
  const hooks = {};
  for (const [event, groups] of Object.entries(existing?.hooks ?? {})) {
    const kept = Array.isArray(groups) ? groups.filter((group) => !isOurs(group)) : [];
    if (kept.length) hooks[event] = kept;
  }
  if (!uninstall) for (const [event, groups] of Object.entries(ours)) hooks[event] = [...groups, ...(hooks[event] ?? [])];
  const rest = { ...existing };
  delete rest.hooks;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

function main(argv) {
  const projectAt = argv.indexOf('--project');
  const target = projectAt >= 0 ? join(resolve(argv[projectAt + 1] ?? '.'), '.gemini', 'settings.json') : join(homedir(), '.gemini', 'settings.json');
  let existing = {};
  if (existsSync(target)) {
    try { existing = JSON.parse(readFileSync(target, 'utf8')); } catch (error) {
      // Never overwrite a settings file this script cannot read (for example one with comments).
      console.error(`${target} is not plain JSON (${error instanceof Error ? error.message : error}); add the hooks by hand from the README.`);
      process.exit(1);
    }
  }
  const uninstall = argv.includes('--uninstall');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(merge(existing, buildHooks(), uninstall), null, 2)}\n`);
  console.log(`${uninstall ? 'Removed Ostrelio hooks from' : 'Installed Ostrelio hooks in'} ${target}`);
  if (!uninstall) console.log('Start Gemini CLI from a shell with OSTRELIO_API_KEY (and OSTRELIO_BASE_URL) exported. A project install asks you to trust the project hooks the first time.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
