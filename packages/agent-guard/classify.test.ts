// node --test --experimental-strip-types packages/agent-guard/classify.test.ts
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { toProposal } from './classify.ts';

const cwd = '/work/app';
const action = (toolName: string, input: unknown) => toProposal(toolName, input, cwd);

test('Claude Code tools map onto the same action types as omp', () => {
  assert.equal(action('Read', { file_path: 'README.md' }).actionType, 'agent.read');
  assert.equal(action('Read', { file_path: 'README.md' }).context.pathScope, 'workspace');
  assert.equal(action('Grep', { pattern: 'TODO', path: 'src' }).actionType, 'agent.read');
  assert.equal(action('Glob', { pattern: '**/*.ts' }).context.pathScope, 'workspace');
  assert.equal(action('Glob', { pattern: '/etc/**' }).context.pathScope, 'outside');
  assert.equal(action('WebSearch', { query: 'ostrelio' }).actionType, 'agent.read');

  const edit = action('Edit', { file_path: 'README.md', old_string: 'smal', new_string: 'small' });
  assert.equal(edit.actionType, 'file.write');
  assert.equal(edit.context.pathScope, 'workspace');
  assert.equal(edit.context.change, 'smal\n---\nsmall');
  assert.equal(action('Write', { file_path: '/tmp/outside.txt', content: 'x' }).context.pathScope, 'outside');
  assert.equal(action('MultiEdit', { file_path: 'src/app.ts', edits: [{ old_string: 'a', new_string: 'b' }] }).actionType, 'file.write');
  assert.equal(action('NotebookEdit', { notebook_path: 'notes.ipynb', new_source: 'print(1)', cell_id: 'c1' }).actionType, 'file.write');

  const fetch = action('WebFetch', { url: 'https://example.com/docs', prompt: 'summarize' });
  assert.equal(fetch.actionType, 'network.request');
  assert.equal(fetch.context.host, 'example.com');
  assert.equal(fetch.context.plainFetch, 'yes');
  assert.equal(action('Task', { prompt: 'look around', subagent_type: 'Explore' }).actionType, 'agent.spawn');
  assert.equal(action('Agent', { description: 'review', prompt: 'read the diff' }).actionType, 'agent.spawn');

  const mcp = action('mcp__payments__send_wire', { amount_cents: 100 });
  assert.equal(mcp.actionType, 'mcp.payments__send_wire');
  assert.deepEqual(mcp.context.args, { amount_cents: 100 });
});

test('rm -rf outside the workspace is marked so a policy can deny it', () => {
  const outside = action('Bash', { command: 'rm -rf /tmp/ostrelio-outside' });
  assert.equal(outside.actionType, 'shell.exec');
  assert.equal(outside.context.recursiveDelete, 'yes');
  assert.equal(outside.context.deleteScope, 'outside');
  const inside = action('Bash', { command: 'rm -rf node_modules' });
  assert.equal(inside.context.recursiveDelete, 'yes');
  assert.equal(inside.context.deleteScope, 'workspace');
  assert.equal(action('Bash', { command: 'rm README.md' }).context.recursiveDelete, 'no');
  assert.equal(action('Bash', { command: 'rm -r -f ../other' }).context.deleteScope, 'outside');
  assert.equal(action('Bash', { command: 'ls' }).context.recursiveDelete, undefined);
});

test('Claude Code settings, plugin files and the key directory are agent.tamper', () => {
  assert.equal(action('Edit', { file_path: '.claude/settings.json', old_string: '{', new_string: '{}' }).actionType, 'agent.tamper');
  assert.equal(action('Write', { file_path: '.claude/settings.local.json', content: '{}' }).actionType, 'agent.tamper');
  assert.equal(action('Edit', { file_path: '.claude-plugin/plugin.json', old_string: 'a', new_string: 'b' }).actionType, 'agent.tamper');
  assert.equal(action('Bash', { command: 'rm -f ~/.claude/settings.json' }).actionType, 'agent.tamper');
  assert.equal(action('Bash', { command: 'unset OSTRELIO_API_KEY' }).actionType, 'agent.tamper');
  assert.equal(action('Read', { file_path: '.claude/settings.json' }).actionType, 'agent.read');
});

test('Cursor hook files are agent.tamper to edit and plain reads to read', () => {
  assert.equal(action('Write', { file_path: '.cursor/hooks.json', content: '{}' }).actionType, 'agent.tamper');
  assert.equal(action('Edit', { file_path: '~/.cursor/hooks.json', old_string: 'a', new_string: 'b' }).actionType, 'agent.tamper');
  assert.equal(action('Bash', { command: 'rm -f .cursor/hooks.json' }).actionType, 'agent.tamper');
  assert.equal(action('Read', { file_path: '.cursor/hooks.json' }).actionType, 'agent.read');
  assert.equal(action('Write', { file_path: '.cursor/rules/style.mdc', content: 'x' }).actionType, 'file.write');
});

test('Gemini CLI, Codex CLI and Windsurf hook config is agent.tamper to edit and a plain read to read', () => {
  for (const file of ['.gemini/settings.json', '~/.gemini/settings.json', '/etc/gemini-cli/settings.json', '.codex/hooks.json', '~/.codex/config.toml', '.windsurf/hooks.json', '.devin/hooks.json', '~/.codeium/windsurf/hooks.json', '~/.codex/plugins/cache/ostrelio/hooks/hooks.json', '.agents/plugins/marketplace.json', '/etc/devin/hooks.json', '/Library/Application Support/Devin/hooks.json']) {
    assert.equal(action('Write', { file_path: file, content: '{}' }).actionType, 'agent.tamper', file);
    assert.equal(action('Read', { file_path: file }).actionType, 'agent.read', file);
  }
  assert.equal(action('Edit', { patch: '*** Begin Patch\n*** Update File: .codex/hooks.json\n@@\n-a\n+b\n*** End Patch' }).actionType, 'agent.tamper');
  assert.equal(action('Bash', { command: 'rm -f .gemini/settings.json' }).actionType, 'agent.tamper');
  assert.equal(action('Bash', { command: 'echo {} > ~/.codeium/windsurf/hooks.json' }).actionType, 'agent.tamper');
  assert.equal(action('Write', { file_path: '.gemini/GEMINI.md', content: 'x' }).actionType, 'file.write');
  assert.equal(action('Write', { file_path: '.windsurf/rules/style.md', content: 'x' }).actionType, 'file.write');
});

test('the shared policy pack allows workspace reads, holds outside writes, denies outside rm -rf, and denies tamper', async () => {
  const policies = JSON.parse(await readFile(new URL('./default-policies.json', import.meta.url), 'utf8')) as Array<{ displayKey: string; rule: { decision: string; actionTypes: string[]; when?: Array<{ field: string; value: unknown }> } }>;
  const byKey = new Map(policies.map((policy) => [policy.displayKey, policy.rule]));
  assert.equal(byKey.get('POL-AGT-01')?.decision, 'ALLOW');
  assert.equal(byKey.get('POL-AGT-10')?.decision, 'DENY');
  assert.deepEqual(byKey.get('POL-AGT-10')?.actionTypes, ['agent.tamper']);
  assert.equal(byKey.get('POL-AGT-22')?.decision, 'DENY');
  assert.equal(byKey.get('POL-AGT-23')?.decision, 'REQUIRE_APPROVAL');
  assert.ok(byKey.get('POL-AGT-22')?.when?.some((condition) => condition.field === 'context.deleteScope' && condition.value === 'outside'));
  assert.ok(byKey.get('POL-AGT-23')?.when?.some((condition) => condition.field === 'context.pathScope'));
});

test('paths with spaces, quotes and ~ or $HOME classify by where they really are', () => {
  const home = homedir();
  const ws = (command: string) => action('Bash', { command }).context.deleteScope;
  assert.equal(ws("rm -rf '/Volumes/ADATA SD810/x'"), 'outside');
  assert.equal(ws('rm -rf "/Volumes/ADATA SD810/x"'), 'outside');
  assert.equal(ws('rm -rf /Volumes/ADATA\\ SD810/x'), 'outside');
  assert.equal(ws('rm -rf ~/ostrelio-scratch'), 'outside');
  assert.equal(ws('rm -rf $HOME/ostrelio-scratch'), 'outside');
  assert.equal(ws('rm -rf "$HOME/ostrelio-scratch"'), 'outside');
  assert.equal(ws("rm -rf 'build output/cache'"), 'workspace');
  assert.equal(toProposal('Bash', { command: 'rm -rf ~/x' }, `${home}/proj`).context.deleteScope, 'outside');
  assert.equal(toProposal('Bash', { command: 'rm -rf ~/proj/x' }, `${home}/proj`).context.deleteScope, 'workspace');
  assert.equal(action('Read', { path: '~/notes.txt' }).context.pathScope, 'outside');
  assert.equal(action('Read', { path: '$HOME/notes.txt' }).context.pathScope, 'outside');
  assert.equal(toProposal('Read', { path: '~/proj/a.ts' }, `${home}/proj`).context.pathScope, 'workspace');
  assert.equal(action('Edit', { file_path: '~/a b/c.txt', old_string: 'a', new_string: 'b' }).context.pathScope, 'outside');
});
