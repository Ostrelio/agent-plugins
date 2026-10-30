#!/usr/bin/env -S node --experimental-strip-types
/**
 * `ostrelio`: a person approves or rejects held agent calls from the terminal.
 *
 *   ostrelio login [--url http://127.0.0.1:3100] [--email you@company.com] [--password-stdin]
 *   ostrelio pending                 held calls waiting for you
 *   ostrelio approve [id] [--reason "..."]
 *   ostrelio reject  [id] [--reason "..."]
 *   ostrelio whoami | logout
 *
 * It acts as the reviewer who ran `ostrelio login` (a reviewer session stored in ~/.ostrelio-you/),
 * never with an agent API key. `approve` and `reject` without an id act on the one held call, or list them.
 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { clearReviewerSession, loadReviewerSession, loginReviewer, ReviewerClient, type PendingApproval } from './reviewer.ts';

/** `--name value` pairs and bare words; `--password-stdin` is the only flag without a value. */
function parse(args: string[]): { words: string[]; flags: Map<string, string> } {
  const words: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const item = args[index]!;
    if (!item.startsWith('--')) { words.push(item); continue; }
    flags.set(item.slice(2), item === '--password-stdin' ? '1' : args[++index] ?? '');
  }
  return { words, flags };
}

async function ask(question: string, hidden = false): Promise<string> {
  const output = new Writable({ write(chunk, _encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
  const lines = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  process.stdout.write(question);
  try { return (await lines.question('')).trim(); } finally { lines.close(); if (hidden) process.stdout.write('\n'); }
}

const describe = (item: PendingApproval) => `${item.id}  ${item.actionType} ${item.resourceId}${item.reason ? `\n    ${item.reason}` : ''}`;

/** The held call to act on: the id given (a unique prefix is enough), or the only one waiting. */
async function pick(client: ReviewerClient, wanted: string | undefined, verb: string): Promise<PendingApproval | string> {
  const pending = await client.pending();
  if (wanted) {
    const matches = pending.filter((item) => item.id === wanted || item.id.startsWith(wanted));
    if (matches.length === 1) return matches[0]!;
    // Not in the pending list (already decided, or a full id from the dashboard): the server answers.
    if (matches.length === 0 && /^[0-9a-f-]{36}$/i.test(wanted)) return { id: wanted, actionType: '', resourceId: '', reason: '', expiresAt: '' };
    return matches.length ? `"${wanted}" matches ${matches.length} held calls; use more of the id.` : `No held call matches "${wanted}". Run \`ostrelio pending\`.`;
  }
  if (pending.length === 1) return pending[0]!;
  if (pending.length === 0) return 'Nothing is waiting for approval.';
  return `${pending.length} calls are waiting; name one:\n${pending.map(describe).join('\n')}\n(ostrelio ${verb} <id>)`;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...rest] = argv;
  const { words, flags } = parse(rest);
  try {
    if (command === 'login') {
      const baseUrl = flags.get('url') ?? env.OSTRELIO_BASE_URL ?? 'http://127.0.0.1:3100';
      const email = flags.get('email') ?? await ask('Reviewer email: ');
      const password = flags.has('password-stdin') ? await ask('') : await ask('Password: ', true);
      const session = await loginReviewer({ baseUrl, email, password, env });
      console.log(`Signed in to ${session.baseUrl} as ${session.email}. Held calls can now be approved from this terminal (session expires ${session.expiresAt}).`);
      return 0;
    }
    if (command === 'logout') { await clearReviewerSession(env); console.log('Signed out. The reviewer session is removed from this machine.'); return 0; }
    if (!['whoami', 'pending', 'approve', 'reject'].includes(command ?? '')) {
      console.error('Usage: ostrelio login | pending | approve [id] | reject [id] | whoami | logout');
      return command ? 1 : 0;
    }
    const session = await loadReviewerSession(env);
    if (!session) { console.error('Not signed in. Run `ostrelio login` first (it stores a reviewer session; the agent API key cannot approve).'); return 1; }
    const client = new ReviewerClient(session);
    if (command === 'whoami') { console.log(`${session.email} at ${session.baseUrl} (session expires ${session.expiresAt})`); return 0; }
    if (command === 'pending') {
      const pending = await client.pending();
      console.log(pending.length ? pending.map(describe).join('\n') : 'Nothing is waiting for approval.');
      return 0;
    }
    const verdict = command === 'approve' ? 'approve' : 'reject';
    const target = await pick(client, words[0], verdict);
    if (typeof target === 'string') { console.error(target); return 1; }
    const result = await client.review(target.id, verdict, 'ostrelio CLI', flags.get('reason'));
    console.log(`${verdict === 'approve' ? 'Approved' : 'Rejected'} ${target.actionType ? `${target.actionType} ${target.resourceId} ` : ''}(${target.id}): ${result.status}.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
