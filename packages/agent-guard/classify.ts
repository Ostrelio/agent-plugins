/**
 * Classifies one agent tool call into an Ostrelio proposal. Harness plugins (oh-my-pi, Claude Code)
 * share this so a Bash command and a file edit mean the same action whichever harness runs them.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

type Context = Record<string, unknown>;
export interface Proposal { actionType: string; resourceType: string; resourceId: string; context: Context }
interface ToolResultEvent { toolCallId: string; toolName?: string; isError?: boolean; input?: unknown; content?: Array<{ type?: string; text?: string }> }

const MAX_INTENT = 500;
/** The person's request or the agent's last message, flattened and capped for reviewer context. */
export const intentText = (text: string) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > MAX_INTENT ? `${flat.slice(0, MAX_INTENT)}…` : flat; };

const MAX_TEXT = 2_000;
// omp's built-in tools (omp --tools lists them). Anything not named here keeps its own action type.
const READ_TOOLS = new Set(['read', 'grep', 'find', 'glob', 'ls', 'lsp', 'ast_grep', 'todo', 'todos', 'web_search', 'web_search_exa', 'websearch', 'recall', 'context_notes', 'ask', 'wait']);
const WRITE_TOOLS = new Set(['edit', 'edits', 'write', 'ast_edit', 'replace', 'notebook', 'notebookedit', 'multiedit', 'memory_edit', 'replace_memory_files']);
const SHELL_TOOLS = new Set(['bash', 'shell', 'ssh']);
const CODE_TOOLS = new Set(['eval', 'evaluate', 'python', 'js']);

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);
const MAX_READ_TEXT = 1_500;

/** A tool's output as an untrusted input: where it came from (tool and target) and its text, trimmed. */
export function untrustedInput(toolName: string, input: unknown, text: string): { source: string; text: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const record = (input && typeof input === 'object' ? input : {}) as Context;
  const target = pathOf(record) || str(record.command) || str(record.url) || str(record.pattern) || str(record.query);
  const tool = toolName || 'tool';
  return {
    source: (target ? `${tool} ${target}` : tool).slice(0, 200),
    text: trimmed.length > MAX_READ_TEXT ? `${trimmed.slice(0, MAX_READ_TEXT)}…` : trimmed,
  };
}

/** omp's tool result content blocks, as an untrusted input. */
export function resultText(event: ToolResultEvent): { source: string; text: string } | null {
  const text = (event.content ?? []).filter((part) => part.type === 'text' && part.text).map((part) => part.text).join('\n');
  return untrustedInput(event.toolName ?? 'tool', event.input, text);
}
const str = (value: unknown) => (typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value));

function pathOf(input: Context): string {
  for (const key of ['path', 'file_path', 'filePath', 'file', 'notebook_path', 'notebookPath', 'target', 'source', 'from']) {
    if (typeof input[key] === 'string' && input[key]) return input[key] as string;
  }
  if (Array.isArray(input.paths) && typeof input.paths[0] === 'string') return input.paths[0];
  return '';
}

/** Files a patch touches: omp's `[path#hash]` headers and `*** Update|Add|Delete File: path` lines. */
export function patchFiles(patch: string): { paths: string[]; deletes: boolean } {
  const paths = new Set<string>();
  for (const match of patch.matchAll(/^\[([^\]#\n]+)#[^\]]*\]/gm)) paths.add(match[1]!.trim());
  for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete|Move) File: (.+)$/gm)) paths.add(match[1]!.trim());
  for (const match of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) paths.add(match[1]!.trim());
  return { paths: [...paths], deletes: /^\*\*\* Delete File:/m.test(patch) };
}

/** "workspace" when the path is inside the session's folder, "outside" otherwise. */
function scopeOf(path: string, cwd: string): 'workspace' | 'outside' {
  const rel = relative(cwd, absolute(path, cwd));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? 'workspace' : 'outside';
}

// Commands that run another command: `sudo rm x` runs rm, so rm is one of its programs too.
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'time', 'nohup', 'nice', 'command', 'exec', 'xargs', 'builtin']);
const base = (word: string) => word.replace(/^.*\//, '');

/** Splits on whitespace like a shell: quotes group and are dropped (`'/a b/c'` is one word), and `a\ b` keeps its space. */
function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"' && index + 1 < text.length) word += text[++index]!;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === '\\' && index + 1 < text.length) {
      word += text[++index]!;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || word) words.push(word);
      word = '';
      started = false;
    } else word += char;
  }
  if (started || word) words.push(word);
  return words;
}

/** Each simple command's words, without leading VAR=value assignments. Splits on ; & && || | newlines, $( ) and backticks. */
function segmentsOf(command: string, quoteAware = false): string[][] {
  return command.replace(/\d*[<>]&\d*-?/g, ' ').split(/;|&&|\|\||\||&|\n|\$\(|`|\(|\)/).map((part) => {
    // Quote-aware words are for reading paths (`rm -rf '/a b'`). Other checks keep the plain split, which fails closed.
    const words = (quoteAware ? shellWords(part) : part.trim().split(/\s+/)).filter((word) => word && !/^\d*[<>]+$/.test(word));
    let first = 0;
    while (first < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[first]!)) first++;
    return words.slice(first);
  }).filter((words) => words.length > 0);
}

/** A segment's words from the program it really runs: `sudo -u x rm y` gives `rm y`. */
function unwrap(words: string[]): string[] {
  let index = 0;
  while (index < words.length - 1 && WRAPPERS.has(base(words[index]!))) {
    index++;
    while (index < words.length - 1 && (words[index]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!))) index++;
  }
  return words.slice(index);
}

/**
 * Programs a shell command runs, space-padded so a policy can test `contains " rm "`. Keeps the first
 * word of each simple command, and the program a wrapper runs (`sudo rm` gives sudo and rm).
 */
export function programsOf(command: string): string[] {
  return segmentsOf(command).flatMap((words) => {
    const inner = unwrap(words);
    return inner.length === words.length ? [base(words[0]!)] : [base(words[0]!), base(inner[0]!)];
  }).filter(Boolean);
}

/** The command plus the scripts it hands to a shell (`bash -c '…'`, `eval "…"`), so those are classified too. */
function withInnerScripts(command: string): string {
  const inner = [...command.matchAll(/(?:\b(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*-c|\beval)\s+(['"])([\s\S]*?)\1/g)].map((match) => match[2]);
  return inner.length ? `${command}\n${inner.join('\n')}` : command;
}

// Paths that matter to security, each tested against the absolute path with `~` expanded.
const HOME = homedir();
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const registeredDirs = new Set<string>();

/** A harness registers its install directory so an edit to that plugin is `agent.tamper`. */
export function registerEnforcementDir(dir: string): void {
  if (dir) registeredDirs.add(resolve(dir));
}

/** This package, plus every directory a loaded harness registered. */
function enforcementDirs(): string[] {
  return [MODULE_DIR, ...registeredDirs];
}

/** Ostrelio's own enforcement: the plugins, omp and Claude Code settings and hooks, MCP and gateway config, keys. */
const ENFORCEMENT_FILES = [
  /(^|\/)\.ostrelio-you(\/|$)/, /(^|\/)\.mcp\.json$/, /(^|\/)ostrelio[^/]*\.(json|ya?ml)$/, /(^|\/)omp-config\.ya?ml$/,
  /(^|\/)\.omp(\/|$)/, /(^|\/)\.claude-plugin(\/|$)/, /(^|\/)\.claude\/plugins(\/|$)/,
  /(^|\/)\.claude\/(settings[^/]*\.json|hooks(\/|$))/,
  /(^|\/)\.cursor\/(hooks\.json|hooks(\/|$))/,
  // Gemini CLI, Codex CLI and Windsurf/Devin hook config (user, project and system layers).
  /(^|\/)\.gemini\/(settings[^/]*\.json|hooks(\/|$))/, /(^|\/)gemini-cli\/settings\.json$/,
  /(^|\/)\.codex\/(hooks\.json|config\.toml|hooks(\/|$)|plugins(\/|$))/, /(^|\/)\.agents\/plugins(\/|$)/,
  /(^|\/)\.(windsurf|devin)\/hooks\.json$/, /(^|\/)\.codeium\/(windsurf\/)?hooks\.json$/, /(^|\/)(devin|windsurf)\/hooks\.json$/i,
];
const CREDENTIAL_FILES = [
  /(^|\/)([^/]*\.env|\.env\.(?!(example|sample|template|dist)$)[^/]+)$/, /(^|\/)\.(ssh|aws|azure|gnupg)\//, /(^|\/)\.config\/(gcloud|gh)\//,
  /(^|\/)\.kube\/config$/, /(^|\/)\.docker\/config\.json$/, /(^|\/)\.(netrc|npmrc|pypirc|pgpass|git-credentials)$/,
  /\.(pem|key|p12|pfx|jks|keystore)$/, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)[^/]*$/, /(^|\/)\.ostrelio-you(\/|$)/,
  /(^|\/)Library\/Keychains\//, /(^|\/)\.[a-z_]*history$/,
];
const AUDIT_FILES = [/^(\/private)?\/var\/log(\/|$)/, /(^|\/)\.[a-z_]*history$/];

/** `path` made absolute against the session's folder, with `~` and `$HOME` expanded. */
function absolute(path: string, cwd: string): string {
  return resolve(cwd, path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, HOME));
}
// Case-insensitive, as on macOS's default file system.
const inside = (path: string, dir: string) => path.toLowerCase() === dir.toLowerCase() || path.toLowerCase().startsWith(`${dir.toLowerCase()}/`);
const matching = (patterns: RegExp[]) => (path: string, cwd: string) => { const abs = absolute(path, cwd); return patterns.some((pattern) => pattern.test(abs)); };
const isCredential = matching(CREDENTIAL_FILES);
const isAuditLog = matching(AUDIT_FILES);
const ENFORCEMENT_NAMES = ['.mcp.json', 'omp-config.yml', 'omp-config.yaml', 'ostrelio.gateway.json', '.ostrelio-you', '.omp', '.claude-plugin', '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks', '.claude/plugins', '.cursor/hooks.json', '.cursor/hooks', '.gemini/settings.json', '.gemini/hooks', '.codex/hooks.json', '.codex/config.toml', '.codex/hooks', '.codex/plugins', '.agents/plugins', '.windsurf/hooks.json', '.devin/hooks.json', '.codeium/windsurf/hooks.json'];

/** A path with `*`, `?` or `[…]` in its last part also stands for every protected name it could match. */
function globCandidates(path: string): string[] {
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  if (!/[*?[]/.test(name)) return [path];
  // Fails closed: everything from the first `[` on matches anything, so this matches at least what the
  // shell would, and a pattern that cannot be compiled counts as matching every protected name.
  let pattern: RegExp;
  try {
    pattern = new RegExp(`^${name.replace(/\[.*$/, '\u0002').replace(/[.+^${}()|\\[\]]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\u0002/, '.*')}$`);
  } catch {
    pattern = /^/;
  }
  const dir = path.slice(0, slash + 1);
  return [path, ...ENFORCEMENT_NAMES.map((protectedName) => protectedName.split('/')[0]!).filter((candidate) => pattern.test(candidate)).map((candidate) => `${dir}${candidate}`)];
}

function isEnforcement(path: string, cwd: string): boolean {
  return globCandidates(path).some((candidate) => {
    const abs = absolute(candidate, cwd);
    return ENFORCEMENT_FILES.some((pattern) => pattern.test(abs)) || enforcementDirs().some((dir) => inside(abs, dir));
  });
}

/**
 * Deleting or moving `path` would remove an enforcement directory (`rm -rf ~` removes ~/.omp), or a
 * folder that holds enforcement files, such as a project with a .mcp.json.
 */
function holdsEnforcement(path: string, cwd: string): boolean {
  const abs = absolute(path, cwd);
  // ~/.omp and ~/.claude are deletion roots only: removing them takes the harness config with them.
  // A file inside ~/.claude is enforcement only when ENFORCEMENT_FILES names it (settings, hooks, plugins).
  const deletionRoots = [...enforcementDirs(), `${HOME}/.omp`, `${HOME}/.claude`];
  if (deletionRoots.some((dir) => inside(dir, abs))) return true;
  try { return statSync(abs).isDirectory() && ENFORCEMENT_NAMES.some((name) => existsSync(`${abs}/${name}`)); } catch { return false; }
}

/**
 * Words of a command or JSON text that could name a file: split on quotes and shell operators, with
 * quoted strings and `a\ b` kept whole, and `--flag=value` and `@file` unwrapped.
 */
function tokensOf(text: string): string[] {
  const quoted = [...text.matchAll(/(['"])([^'"]+)\1/g)].map((match) => match[2]!);
  return [...text.replace(/\\ /g, '\u0000').split(/[\s'"`;|&()<>,{}]+/).map((token) => token.replace(/\u0000/g, ' ')), ...quoted]
    .flatMap((token) => (token.includes('=') ? [token, token.slice(token.indexOf('=') + 1)] : [token]))
    .map((token) => token.replace(/^@/, '').replace(/:$/, ''))
    .filter((token) => token && token !== '-' && !token.startsWith('-'));
}

// Programs that only read what they are given. Any other program that names a protected file may change it.
const READ_ONLY = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'rg', 'ls', 'stat', 'wc', 'file', 'diff', 'cmp', 'jq', 'bat', 'echo', 'printf', 'md5sum', 'shasum', 'sha256sum', 'realpath', 'readlink', 'basename', 'dirname', 'test', '[', 'pwd', 'which']);
const DESTRUCTIVE = new Set(['rm', 'rmdir', 'mv', 'shred', 'unlink', 'truncate', 'chmod', 'chown', 'chattr']);

/** The command names a file `isProtected` accepts and may change it: a writing program, or a redirect into it. */
function changes(command: string, programs: string[], cwd: string, isProtected: (path: string, cwd: string) => boolean): boolean {
  const redirected = [...command.matchAll(/>>?\|?\s*([^\s;|&<>]+)/g)].map((match) => match[1]!);
  if (redirected.some((target) => isProtected(target.replace(/^['"]|['"]$/g, ''), cwd))) return true;
  return tokensOf(command).some((token) => isProtected(token, cwd)) && programs.some((program) => !READ_ONLY.has(program));
}

const EGRESS = new Set(['curl', 'wget', 'scp', 'rsync', 'sftp', 'ftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh']);
const REMOTE = /^(?:[^@\s/]+@)?([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):(?!\/\/)/;

/** Where a network command connects, and whether it sends data (upload) or only fetches (download). */
function egressOf(words: string[]): { network: 'upload' | 'download'; host: string } | null {
  const program = base(words[0]!);
  const args = words.slice(1);
  const plain = args.filter((word) => !word.startsWith('-'));
  const urlHosts = args.map((word) => /^['"]?[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?(\[[^\]]+\]|[^/:?#\s'"]+)/i.exec(word)?.[1]).filter((host) => host !== undefined);
  const url = urlHosts[0];
  // One destination or none: a request naming several hosts has no single host a policy could trust.
  const only = (hosts: string[]) => (new Set(hosts.map((host) => host.toLowerCase().replace(/\.$/, ''))).size > 1 ? '' : hosts[0] ?? '');
  if (program === 'curl') {
    // A config file, --resolve, --connect-to, a proxy, DoH, a socket or a Host header send the request
    // somewhere the URL does not say, in any spelling (`-x host`, `-xhost`, `--proxy=host`).
    const redirects = args.some((word, index) => /^-[a-zA-Z]*[Kx]|^--(config|resolve|connect-to|proxy|preproxy|socks|doh-url|unix-socket|abstract-unix-socket|interface|dns-servers)/.test(word)
      || /^(-H|--header)=?\s*['"]?host\s*:/i.test(word) || (/^(-H|--header)$/.test(word) && /^['"]?host\s*:/i.test(args[index + 1] ?? '')));
    if (redirects) return { network: 'upload', host: '' };
    const sends = args.some((word, index) => /^(-[a-zA-Z]*[dFT].*|--data.*|--form.*|--upload-file|--json|-XP(OST|UT|ATCH)|-XDELETE)$/.test(word)
      || (/^(-X|--request)$/.test(word) && /^(POST|PUT|PATCH|DELETE)$/i.test(args[index + 1] ?? '')));
    const bare = plain.filter((word) => !/:\/\//.test(word) && /^[\w.-]+\.[a-z]{2,}(?:[:/]|$)/i.test(word)).map((word) => word.replace(/[:/].*$/, ''));
    return { network: sends ? 'upload' : 'download', host: only([...urlHosts, ...bare]) };
  }
  if (program === 'wget') {
    // -e/--execute and a config file can set a proxy or any other option.
    if (args.some((word) => /^-[a-zA-Z]*e|^--(execute|config|proxy|bind-address)/.test(word))) return { network: 'upload', host: '' };
    const sends = args.some((word) => /^--(post|body)-(data|file)|^--method=(POST|PUT|PATCH|DELETE)/i.test(word));
    return { network: sends ? 'upload' : 'download', host: urlHosts.length ? only(urlHosts) : plain[0]?.replace(/[:/].*$/, '') ?? '' };
  }
  if (program === 'scp' || program === 'rsync') {
    const remote = plain.map((word) => REMOTE.exec(word)?.[1] ?? /^rsync:\/\/([^/:]+)/.exec(word)?.[1]);
    const host = remote.find(Boolean);
    if (!host) return null;
    return { network: remote.at(-1) ? 'upload' : 'download', host: host.replace(/^\[|\]$/g, '') };
  }
  if (program === 'socat') {
    return { network: 'upload', host: args.map((word) => /^(?:TCP|UDP|OPENSSL|SSL)[46]?(?:-CONNECT)?:([^:]+):/i.exec(word)?.[1]).find(Boolean) ?? '' };
  }
  // nc, telnet, ftp, sftp and ssh can send anything, so they always count as uploads.
  return { network: 'upload', host: url ?? (plain[0] ?? '').replace(/^[^@]*@/, '').replace(/:.*$/, '') };
}

/** The registrable part of a host (`eo1.m.pipedream.net` gives `pipedream.net`), so a policy can list domains. */
function domainOf(host: string): string {
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host;
  const labels = host.split('.');
  const keep = labels.length > 2 && /^[a-z]{2}$/.test(labels.at(-1)!) && /^(co|com|org|net|ac|gov|edu)$/.test(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-keep).join('.');
}
// Options a plain fetch may use. Anything else (output files, cookie jars, traces, config, URL lists) fails the check.
const CURL_FLAGS = /^-[sSfLiIv]+$|^--(silent|show-error|fail|fail-with-body|location|include|head|verbose|compressed)$/;
const CURL_VALUE_OPTIONS = /^(-m|--max-time|--connect-timeout|--retry|-A|--user-agent|-H|--header)$/;
const WGET_OPTIONS = /^(-q|--quiet|-nv|--no-verbose|-S|--server-response|--spider|-qO-|-O-|--timeout=\d+|--tries=\d+|--header=.*|--user-agent=.*)$/;

/**
 * A curl or wget call that only fetches one URL and prints it: every option is on the read-only list and
 * there is exactly one operand, a URL. Allow rules for fetches require this, so an unknown option fails closed.
 */
function isPlainFetch(words: string[]): boolean {
  const program = base(words[0]!);
  const args = words.slice(1);
  // Words are split on spaces, not parsed like the shell, so quotes, escapes and expansions fail closed.
  if (args.some((word) => /['"\\$`{}*?[\]~]/.test(word))) return false;
  const operands: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    if (program === 'curl') {
      if (CURL_FLAGS.test(word)) continue;
      if (CURL_VALUE_OPTIONS.test(word)) { index++; continue; }
    } else if (program === 'wget') {
      if (WGET_OPTIONS.test(word)) continue;
      if (word === '-O' && args[index + 1] === '-') { index++; continue; }
    } else return false;
    if (word.startsWith('-')) return false;
    operands.push(word);
  }
  // wget saves to a file unless told to print (-O -) or only check (--spider).
  const prints = program === 'curl' || args.some((word, index) => /^(-qO-|-O-|--spider)$/.test(word) || (word === '-O' && args[index + 1] === '-'));
  return prints && operands.length === 1 && /^['"]?https?:\/\//i.test(operands[0]!);
}

const PROXY_ENV = /(^|[\s;&|(])(https?_proxy|HTTPS?_PROXY|ALL_PROXY|all_proxy|CURL_HOME|WGETRC|SSL_CERT_FILE)=/;
const isLocal = (host: string) => /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|[\w-]+\.localhost)$/i.test(host);

const CLOUD = new Set(['aws', 'gcloud', 'gsutil', 'az', 'kubectl', 'helm', 'terraform', 'tofu', 'pulumi']);
const DESTROY_VERB = /^(delete|destroy|terminate|remove|rm|rb|uninstall|purge|deregister|drain)(-|$)/;
// No plan or preview: terraform plan and pulumi preview run provider code.
const READ_VERB = /^(get|describe|list|ls|show|status|validate|output|logs|top|history|search|version|explain|view|head|template|fmt|graph|providers|whoami|info|cat|wait)(-|$)/;
const CLI_REDIRECT = /^-{1,2}(kubeconfig|server|endpoint-url|endpoint|api-endpoint|post-renderer|plugins?-dir|chdir|config-file)(=|$)/;
const CLI_REDIRECT_ENV = /(^|[\s;&|(])(KUBECONFIG|AWS_ENDPOINT_URL\w*|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|CLOUDSDK_\w+|TF_CLI_\w+|TF_PLUGIN\w*|HELM_\w+|PULUMI_\w+)=/;
/** Cloud reads whose answer is a secret: secret values, parameters, login passwords and tokens. */
const CLOUD_SECRET = /\b(get-secret-value|batch-get-secret-value|get-parameters?(-by-path)?|get-login-password|get-authorization-token|get-session-token|print-(access|identity)-token|secrets?)\b/;
const CHANGE_VERB = /^(apply|create|update|set|put|patch|edit|scale|run|start|stop|reboot|attach|detach|modify|replace|install|upgrade|rollback|rollout|deploy|import|taint|untaint|cp|sync|mv|exec|label|annotate|expose|cordon|uncordon|authorize|revoke|add|enable|disable|tag|untag|copy|restore|invoke|publish|send|resize|up|refresh|mb|init)(-|$)/;

/** What a cloud CLI call does: `read` (get, describe, list, plan), `destroy` (delete, terminate), or `change`. */
function infraOf(words: string[], redirected: boolean): { cli: string; verb: string; effect: 'read' | 'change' | 'destroy'; secret: boolean } {
  const plain = words.slice(1).filter((word) => !word.startsWith('-'));
  const destroy = plain.find((word) => DESTROY_VERB.test(word));
  const change = plain.find((word) => CHANGE_VERB.test(word));
  const read = plain.find((word) => READ_VERB.test(word));
  const verb = destroy ?? change ?? read ?? plain[0] ?? '';
  // Any change or delete verb anywhere wins over a read, and an unknown verb counts as a change. A CLI
  // pointed at another config, server, endpoint or plugin can run anything, so that is a change too.
  const effect = destroy || words.includes('-destroy') ? 'destroy'
    : change || !read || redirected || words.some((word) => CLI_REDIRECT.test(word)) ? 'change' : 'read';
  return { cli: base(words[0]!), verb, effect, secret: CLOUD_SECRET.test(words.join(' ')) };
}

/** Destructive git (force-push, deleting a branch here or on the remote, `reset --hard`) and the branch it hits. */
function gitOf(words: string[]): { actionType: string; branch: string } | null {
  const args = words.slice(1);
  let index = 0;
  while (index < args.length && args[index]!.startsWith('-')) index += /^-[Cc]$|^--(git-dir|work-tree|namespace)$/.test(args[index]!) ? 2 : 1;
  const sub = args[index] ?? '';
  const rest = args.slice(index + 1);
  const plain = rest.filter((word) => !word.startsWith('-'));
  const has = (pattern: RegExp) => rest.some((word) => pattern.test(word));
  if (sub === 'push') {
    const refspec = plain[1] ?? '';
    if (has(/^(-d|--delete)$/) || refspec.startsWith(':')) return { actionType: 'code.git.branch_delete', branch: plain.slice(1).join(' ').replace(/^:/, '') };
    // With no refspec the branch is unknown, and policies treat "" like a protected branch.
    const branch = refspec.replace(/^\+/, '').replace(/^.*:/, '').replace(/^refs\/heads\//, '');
    if (has(/^(-[a-zA-Z]*f[a-zA-Z]*|--force.*|--mirror)$/) || refspec.startsWith('+')) return { actionType: 'code.git.force_push', branch };
    return null;
  }
  if (sub === 'branch' && (has(/^-[a-zA-Z]*D/) || (has(/^(-d|--delete)$/) && has(/^(-f|--force)$/)))) return { actionType: 'code.git.branch_delete', branch: plain.join(' ') };
  if (sub === 'reset' && has(/^--hard$/)) return { actionType: 'code.git.reset_hard', branch: '' };
  return null;
}

const SECURITY_AGENTS = /\b(auditd|osquery\w*|falcon\w*|crowdstrike\w*|sentinel\w*|carbonblack\w*|cbagent\w*|wazuh\w*|ossec\w*|santa\w*|r?syslog\w*|elastic-agent|mdatp|defender\w*|xagt)\b/i;
const CLEARS_AUDIT = [
  /\bhistory\s+-[a-zA-Z]*[cdw]/, /\bset\s+\+o\s+history\b/, /\bunset\s+(-v\s+)?HIST/, /\bHIST(FILE|SIZE|FILESIZE)=/,
  /\bjournalctl\b[^;|&\n]*--(vacuum|rotate)/, /\blog\s+erase\b/, /\bwevtutil(\.exe)?\s+(cl|clear-log)\b/i, /\bauditctl\b[^;|&\n]*\s-(D|e\s*0)\b/,
];

/** Clearing shell history or logs, or stopping a security agent. */
function clearsAudit(command: string, segments: string[][], programs: string[], cwd: string): boolean {
  if (CLEARS_AUDIT.some((pattern) => pattern.test(command))) return true;
  const stopsAgent = segments.some((words) => {
    const program = base(unwrap(words)[0]!);
    const text = words.join(' ');
    return SECURITY_AGENTS.test(text) && (/^(kill|pkill|killall)$/.test(program)
      || (/^(systemctl|service|launchctl)$/.test(program) && /\b(stop|disable|mask|unload|bootout|remove)\b/.test(text)));
  });
  return stopsAgent || changes(command, programs, cwd, isAuditLog);
}

const KEYCHAIN = /\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export)\b|(^|[;&|]\s*)(op|pass|gopass|lpass|bw|vault)\s+(read|show|get|item|kv)\b/m;
const SECRET_VAR = /\$\{?[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)\b/;

/** What a command reads that is a secret: a credential file, a keychain or vault, or secret environment variables. */
function secretOf(command: string, segments: string[][], cwd: string): string {
  const file = tokensOf(command).find((token) => isCredential(token, cwd));
  if (file) return file;
  if (KEYCHAIN.test(command)) return 'keychain';
  const printsEnv = segments.map(unwrap).some((words) => {
    const program = base(words[0]!);
    if (/^(printenv|env|export|declare|set)$/.test(program) && words.slice(1).every((word) => word.startsWith('-'))) return true;
    return /^(echo|printf)$/.test(program) ? SECRET_VAR.test(words.join(' ')) : program === 'printenv' && /KEY|TOKEN|SECRET|PASSWORD/.test(words.join(' '));
  });
  return printsEnv ? 'environment' : '';
}

/** Setting or unsetting OSTRELIO_* in the shell or a profile changes how this plugin enforces. */
// The reviewer CLI (`ostrelio approve|reject|login`) acts as the person; an agent that runs it would approve its own held calls.
const RUNS_REVIEWER_CLI = /(^|[\s;&|(`/"'])(ostrelio|cli)(\.ts)?["']?\s+(approve|reject|deny|login|logout)\b/;
const CHANGES_OSTRELIO_ENV = /\b(export|unset|setenv|launchctl\s+(un)?setenv)\b[^;|&\n]*\bOSTRELIO_/;

/** Classifies one shell command. The first match wins, most severe first. */
function shellAction(command: string, cwd: string): { actionType: string; context: Context } {
  const script = withInnerScripts(command);
  const segments = segmentsOf(script);
  const programs = programsOf(script);
  const tokens = tokensOf(script);
  const tamper = changes(script, programs, cwd, isEnforcement)
    || ((programs.some((program) => DESTRUCTIVE.has(program)) || /\bfind\b[^;|&\n]*\s-(delete|exec)/.test(script)) && tokens.some((token) => holdsEnforcement(token, cwd)))
    || CHANGES_OSTRELIO_ENV.test(script) || RUNS_REVIEWER_CLI.test(script);
  if (tamper) return { actionType: 'agent.tamper', context: { target: tokens.find((token) => isEnforcement(token, cwd) || holdsEnforcement(token, cwd)) ?? (RUNS_REVIEWER_CLI.test(script) ? 'ostrelio reviewer CLI' : 'OSTRELIO_*') } };
  if (clearsAudit(script, segments, programs, cwd)) return { actionType: 'audit.tamper', context: {} };

  const commands = segments.map(unwrap);
  const egress = commands.filter((words) => EGRESS.has(base(words[0]!))).map(egressOf).filter((found) => found !== null);
  const network = egress.find((found) => found.network === 'upload') ?? egress[0];
  // Hosts are case-insensitive and may end in a dot (`Paste.EE.` is paste.ee).
  // Hosts are case-insensitive and may end in a dot. A proxy set in the environment hides the real destination.
  const host = PROXY_ENV.test(script) ? '' : network?.host.toLowerCase().replace(/\.$/, '') ?? '';
  const fetches = commands.filter((words) => EGRESS.has(base(words[0]!)));
  const plain = fetches.length === 1 && isPlainFetch(fetches[0]!);
  const networkContext = network ? { network: network.network, host, domain: domainOf(host), hostScope: isLocal(host) ? 'local' : 'external', plainFetch: plain ? 'yes' : 'no' } : {};
  const infra = commands.filter((words) => CLOUD.has(base(words[0]!))).map((words) => infraOf(words, CLI_REDIRECT_ENV.test(script)));
  const cloud = infra.find((found) => found.effect === 'destroy') ?? infra.find((found) => found.effect === 'change') ?? infra[0];
  const secret = secretOf(script, segments, cwd) || (infra.some((found) => found.effect === 'read' && found.secret) ? 'cloud secret' : '');
  if (secret && network) return { actionType: 'secret.exfiltrate', context: { secret, ...networkContext } };

  const git = commands.filter((words) => base(words[0]!) === 'git').map(gitOf).find(Boolean);
  if (git) return { actionType: git.actionType, context: { branch: git.branch } };
  const cloudContext = cloud ? { cli: cloud.cli, verb: cloud.verb, effect: cloud.effect } : {};
  if (cloud && cloud.effect !== 'read') return { actionType: `infra.${cloud.effect}`, context: cloudContext };
  if (network) return { actionType: network.network === 'upload' ? 'network.upload' : 'network.request', context: networkContext };
  if (secret) return { actionType: 'secret.read', context: { secret } };
  if (cloud) return { actionType: 'infra.read', context: cloudContext };
  return { actionType: 'shell.exec', context: {} };
}

/**
 * `rm -rf` (recursive and forced) and where its targets sit. Empty when the command does not run `rm`.
 * `deleteScope` is `outside` when any target leaves the workspace, so a policy can deny that case.
 */
function rmContext(command: string, cwd: string): Context {
  const commands = segmentsOf(withInnerScripts(command), true).map(unwrap).filter((words) => base(words[0]!) === 'rm');
  if (!commands.length) return {};
  const recursiveForce = commands.some((words) => {
    const flags = words.slice(1).filter((word) => word.startsWith('-'));
    const recursive = flags.some((flag) => flag === '--recursive' || /^-[^-]*[rR]/.test(flag));
    const force = flags.some((flag) => flag === '--force' || /^-[^-]*f/.test(flag));
    return recursive && force;
  });
  const targets = commands.flatMap((words) => words.slice(1).filter((word) => word && !word.startsWith('-')));
  const deleteScope = targets.length === 0 ? 'unknown' : targets.some((target) => scopeOf(target, cwd) === 'outside') ? 'outside' : 'workspace';
  return { recursiveDelete: recursiveForce ? 'yes' : 'no', deleteScope };
}

/** What a named tool's arguments do to Ostrelio's files, audit logs or credentials, judged from the paths they name. */
function namedToolAction(name: string, args: unknown, cwd: string): string | null {
  const tokens = tokensOf(JSON.stringify(args ?? {}));
  const readsOnly = /(^|_)(read|get|list|search|view|show|find|stat|describe)(_|$)/.test(name);
  if (!readsOnly && tokens.some((token) => isEnforcement(token, cwd) || holdsEnforcement(token, cwd))) return 'agent.tamper';
  if (!readsOnly && tokens.some((token) => isAuditLog(token, cwd))) return 'audit.tamper';
  if (tokens.some((token) => isCredential(token, cwd))) return 'secret.read';
  return null;
}

/** An MCP or other named tool: its own action type, so a policy can target it exactly. */
function namedTool(toolName: string, args: unknown, cwd: string, via?: string): Proposal {
  const name = toolName.toLowerCase();
  const prefix = name.startsWith('mcp') ? 'mcp' : 'tool';
  const bare = name.replace(/^mcp[_:.-]*/, '');
  // A tool that writes Ostrelio's files, clears logs or reads credentials is classified by that effect.
  const effect = namedToolAction(bare, args, cwd);
  return {
    actionType: effect ?? `${prefix}.${bare}`, resourceType: prefix, resourceId: bare,
    context: { tool: toolName, args: JSON.parse(clip(JSON.stringify(args ?? {}))) as unknown, ...(via ? { via } : {}) },
  };
}

/** omp invokes MCP and device tools by writing JSON to `xd://<tool>`; that is a tool call, not a file write. */
function deviceCall(path: string, input: Context, cwd: string): Proposal | null {
  if (!/^xd:\/\//i.test(path)) return null;
  const target = path.slice(5).replace(/\/.*$/, '');
  const raw = input.content ?? input.input ?? input.data;
  let args: unknown = raw;
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw); } catch { args = { raw: clip(raw) }; }
  }
  return namedTool(target || 'xd', args, cwd, 'xd');
}

/** Turns one omp tool call into an Ostrelio proposal. Pure, so it is unit-tested directly. */
export function toProposal(toolName: string, rawInput: unknown, cwd: string): Proposal {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Context;
  const name = toolName.toLowerCase();
  const invoked = deviceCall(pathOf(input), input, cwd);
  // Reading xd:// is reading a tool's documentation; writing it runs the tool.
  if (invoked && !READ_TOOLS.has(name)) return invoked;
  if (name === 'webfetch' || name === 'web_fetch') {
    const url = str(input.url);
    let host = '';
    try { host = new URL(url).hostname; } catch { host = ''; }
    host = host.toLowerCase().replace(/\.$/, '');
    const plain = /^https?:\/\//i.test(url) && !/['"\\$`{}*?[\]~]/.test(url);
    return {
      actionType: 'network.request', resourceType: 'network', resourceId: host || 'fetch',
      context: {
        tool: name, url: clip(url), command: clip(url), network: 'download', host, domain: domainOf(host),
        hostScope: isLocal(host) ? 'local' : 'external', plainFetch: plain ? 'yes' : 'no', compound: 'no',
        program: 'webfetch', programs: ' webfetch ',
      },
    };
  }
  if (READ_TOOLS.has(name)) {
    let path = pathOf(input);
    // Glob's pattern is the path when it points outside the workspace. Grep's pattern is a search, not a path.
    if (!path && name === 'glob' && typeof input.pattern === 'string' && (isAbsolute(input.pattern) || /^(~|\$HOME|\$\{HOME\}|\.\.)/.test(input.pattern))) path = input.pattern;
    // Reading a credential file is its own action, so it can be held however the read is phrased.
    if (path && isCredential(path, cwd)) return { actionType: 'secret.read', resourceType: 'secret', resourceId: path, context: { tool: name, path, secret: path, pathScope: scopeOf(path, cwd) } };
    // A read with no path (todo, a search of the current folder) stays in the workspace.
    return { actionType: 'agent.read', resourceType: 'tool', resourceId: name, context: { tool: name, ...(path ? { path } : {}), pathScope: path ? scopeOf(path, cwd) : 'workspace' } };
  }
  if (WRITE_TOOLS.has(name) || name === 'delete' || name === 'move') {
    const patch = typeof input.input === 'string' ? patchFiles(input.input) : typeof input.patch === 'string' ? patchFiles(input.patch) : null;
    const paths = patch?.paths.length ? patch.paths : [pathOf(input)].filter(Boolean);
    const removes = name === 'delete' || name === 'move' || Boolean(patch?.deletes);
    // Ostrelio's own files and audit logs are never edited by the agent, whatever the edit is.
    const actionType = paths.some((path) => isEnforcement(path, cwd) || (removes && holdsEnforcement(path, cwd))) ? 'agent.tamper'
      : paths.some((path) => isAuditLog(path, cwd)) ? 'audit.tamper'
        : name === 'delete' || patch?.deletes ? 'file.delete' : name === 'move' ? 'file.move' : 'file.write';
    // A path the plugin cannot see is never treated as safe: "unknown" matches no allow rule.
    const pathScope = paths.length === 0 ? 'unknown' : paths.every((path) => scopeOf(path, cwd) === 'workspace') ? 'workspace' : 'outside';
    // The change itself, so reviewers can judge what the edit does, not only where.
    const rawChange = input.input ?? input.patch ?? input.content ?? input.new_source ?? (
      typeof input.old_string === 'string' || typeof input.new_string === 'string'
        ? [input.old_string, input.new_string].filter((part) => typeof part === 'string').join('\n---\n')
        : input.newText ?? input.edits ?? ''
    );
    const change = clip(str(rawChange));
    return { actionType, resourceType: 'file', resourceId: paths.join(', ') || '(unknown)', context: { tool: name, path: paths.join(', '), paths, pathScope, ...(change ? { change } : {}) } };
  }
  if (SHELL_TOOLS.has(name)) {
    const command = str(input.command ?? input.cmd ?? input.script);
    const programs = programsOf(command);
    const classified = name === 'ssh' ? { actionType: 'shell.remote', context: {} } : shellAction(command, cwd);
    return {
      actionType: classified.actionType, resourceType: 'shell', resourceId: programs[0] ?? 'shell',
      context: {
        tool: name, command: clip(command), program: programs[0] ?? '', programs: ` ${programs.join(' ')} `,
        // The first word after the program (`status` in `git status`), for read-only subcommand rules.
        subcommand: command.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))[1] ?? '',
        // Pipes, chains, subshells and redirects make the first program a poor guide to the effect.
        compound: programs.length > 1 || /[`$<>]|\(/.test(command) ? 'yes' : 'no',
        ...(typeof input.host === 'string' ? { host: input.host } : {}),
        ...classified.context,
        ...rmContext(command, cwd),
      },
    };
  }
  if (CODE_TOOLS.has(name)) {
    const code = str(input.code ?? input.source ?? input.script);
    return { actionType: 'code.exec', resourceType: 'code', resourceId: str(input.language) || name, context: { tool: name, language: str(input.language) || name, code: clip(code) } };
  }
  if (name === 'task' || name === 'agent') return { actionType: 'agent.spawn', resourceType: 'agent', resourceId: str(input.agent) || str(input.subagent_type) || 'subagent', context: { tool: name, task: clip(str(input.task ?? input.prompt ?? input.description)) } };
  if (name === 'browser') return { actionType: 'browser.action', resourceType: 'browser', resourceId: str(input.url) || str(input.action) || 'browser', context: { tool: name, action: str(input.action), url: str(input.url) } };
  // MCP tools and anything else keep their own name, so a policy can target one tool exactly.
  return namedTool(toolName, input, cwd);
}
