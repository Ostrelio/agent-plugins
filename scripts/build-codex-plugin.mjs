#!/usr/bin/env node
/**
 * Builds plugins/ostrelio-codex, the installable Codex plugin, from packages/.
 *
 *   node scripts/build-codex-plugin.mjs           write the plugin
 *   node scripts/build-codex-plugin.mjs --check   exit 1 if the committed plugin is stale
 *
 * Codex only runs files inside the plugin root, so the hook and everything it imports is copied into
 * runtime/ with the same relative layout as packages/ (the hook's `../../agent-guard/…` imports keep
 * working unchanged). Hook timeouts and messages come from packages/codex-plugin/install.mjs.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHooks } from '../packages/codex-plugin/install.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(ROOT, 'packages');
const PLUGIN = join(ROOT, 'plugins', 'ostrelio-codex');
const ENTRY = join(PACKAGES, 'codex-plugin', 'src', 'hook.ts');
const VERSION = JSON.parse(readFileSync(join(PACKAGES, 'codex-plugin', 'package.json'), 'utf8')).version;

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** The entry file and every relative import it reaches, plus each package's package.json (ESM type). */
function runtimeFiles(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const [, spec] of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), spec);
      if (!existsSync(target)) throw new Error(`${relative(ROOT, file)} imports ${spec}, which does not exist`);
      visit(target);
    }
  };
  visit(entry);
  for (const file of [...seen]) seen.add(join(PACKAGES, relative(PACKAGES, file).split('/')[0], 'package.json'));
  return [...seen].sort();
}

/** Every file the plugin should contain, as { path relative to the plugin: contents }. */
export function pluginFiles() {
  const files = {};
  for (const file of runtimeFiles(ENTRY)) files[join('runtime', relative(PACKAGES, file))] = readFileSync(file, 'utf8');

  // Same events, timeouts and messages as the hooks.json installer, pointed at the vendored hook.
  const ours = buildHooks(join(PLUGIN, 'runtime', 'codex-plugin'));
  const command = 'node --experimental-strip-types "${PLUGIN_ROOT}/runtime/codex-plugin/src/hook.ts"';
  const hooks = Object.fromEntries(Object.entries(ours).map(([event, groups]) => [event, groups.map((group) => ({
    hooks: group.hooks.map((entry) => ({ ...entry, command })),
  }))]));
  files['hooks/hooks.json'] = json({ description: 'Ostrelio authorizes every Codex tool call before it runs.', hooks });

  const description = 'Every shell command, patch and MCP call Codex makes is authorized by Ostrelio before it runs.';
  const author = { name: 'Ostrelio', url: 'https://github.com/Ostrelio/agent-plugins' };
  const interfaceBlock = {
    displayName: 'Ostrelio',
    shortDescription: 'Authorize every tool call',
    longDescription: `${description} Safe calls run, risky ones wait for a person in the Ostrelio dashboard, and destructive or tampering calls are blocked with the reason.`,
    developerName: 'Ostrelio',
    category: 'Developer Tools',
    capabilities: [],
    websiteURL: 'https://github.com/Ostrelio/agent-plugins',
  };
  files['plugin.json'] = json({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'ostrelio',
    version: VERSION,
    description,
    author,
    repository: 'https://github.com/Ostrelio/agent-plugins',
    license: 'UNLICENSED',
    keywords: ['security', 'authorization', 'guardrails', 'agents'],
    extensions: { 'com.openai': { hooks: './hooks/hooks.json', interface: interfaceBlock } },
  });
  // Compatibility manifest for Codex builds that read .codex-plugin/ (no $schema in this format).
  files['.codex-plugin/plugin.json'] = json({
    name: 'ostrelio', version: VERSION, description, author, license: 'UNLICENSED',
    skills: './skills/', hooks: './hooks/hooks.json', interface: interfaceBlock,
  });
  files['skills/ostrelio/SKILL.md'] = readFileSync(join(ROOT, 'scripts', 'codex-plugin', 'SKILL.md'), 'utf8');
  return files;
}

function listed(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).filter((path) => statSync(join(dir, path)).isFile() && !path.split('/').some((part) => part.startsWith('._')));
}

/** Paths whose committed contents differ from a fresh build, plus stray files. Empty when up to date. */
export function staleFiles() {
  const files = pluginFiles();
  const stale = Object.entries(files).filter(([path, contents]) => !existsSync(join(PLUGIN, path)) || readFileSync(join(PLUGIN, path), 'utf8') !== contents).map(([path]) => path);
  const extra = listed(PLUGIN).filter((path) => !(path in files) && !path.endsWith('.test.ts'));
  return [...stale, ...extra.map((path) => `${path} (not built)`)];
}

function write() {
  const files = pluginFiles();
  rmSync(join(PLUGIN, 'runtime'), { recursive: true, force: true });
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(PLUGIN, path)), { recursive: true });
    writeFileSync(join(PLUGIN, path), contents);
  }
  console.log(`Built ${relative(ROOT, PLUGIN)} (${Object.keys(files).length} files).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const stale = staleFiles();
    if (stale.length) {
      console.error(`plugins/ostrelio-codex is stale; run \`npm run build:codex\`:\n  ${stale.join('\n  ')}`);
      process.exit(1);
    }
    console.log('plugins/ostrelio-codex is up to date.');
  } else write();
}
