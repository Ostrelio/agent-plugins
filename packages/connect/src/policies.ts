/**
 * Publishes the agent policy pack (packages/agent-guard/default-policies.json) when the workspace has
 * none of it. Policy routes need an operator or a signed-in admin, not a workspace API key: the local
 * demo accepts its development operator key, a hosted workspace needs OSTRELIO_SESSION + OSTRELIO_CSRF.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultPackagesDir } from './harness.ts';

interface PackPolicy { displayKey: string; category: string; name: string; rule: unknown }
interface Listed { id: string; displayKey: string; source?: string }

export const isLoopback = (baseUrl: string): boolean => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname);

/** Headers that authorize policy changes, or null when this workspace needs credentials we were not given. */
export function policyAuth(baseUrl: string, env: NodeJS.ProcessEnv): Record<string, string> | null {
  if (env.OSTRELIO_SESSION) return { 'x-reviewer-session': env.OSTRELIO_SESSION, 'x-csrf-token': env.OSTRELIO_CSRF ?? '' };
  if (env.OSTRELIO_OPERATOR_KEY) return { 'x-operator-api-key': env.OSTRELIO_OPERATOR_KEY };
  return isLoopback(baseUrl) ? { 'x-operator-api-key': 'dev-operator-a' } : null;
}

export type PolicyOutcome =
  | { status: 'installed'; count: number }
  | { status: 'present' }
  | { status: 'skipped'; reason: string };

export async function installDefaultPolicies(options: {
  baseUrl: string;
  env: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  packagesDir?: string;
}): Promise<PolicyOutcome> {
  const auth = policyAuth(options.baseUrl, options.env);
  if (!auth) {
    return { status: 'skipped', reason: 'Policies are not installed: this workspace needs an admin session. Set OSTRELIO_SESSION and OSTRELIO_CSRF and run again, or ask an admin to run packages/agent-guard/install-policies.mjs. Until then every agent call is denied.' };
  }
  const send = options.fetchFn ?? fetch;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await send(`${options.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...auth },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status >= 300) throw new Error(`${method} ${path} answered ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  const pack = JSON.parse(readFileSync(join(options.packagesDir ?? defaultPackagesDir(), 'agent-guard', 'default-policies.json'), 'utf8')) as PackPolicy[];
  const ours = new Set(pack.map((policy) => policy.displayKey));
  const listed = ((await call('GET', '/v1/policies')).policies ?? []) as Listed[];
  if (listed.some((policy) => policy.source !== 'SYSTEM' && ours.has(policy.displayKey))) return { status: 'present' };
  for (const policy of pack) {
    const created = await call('POST', '/v1/policies', { ...policy, mode: 'ENFORCING' });
    const version = ((created.versions ?? []) as Array<{ id: string }>).at(-1)?.id;
    await call('POST', `/v1/policy-versions/${version}/publish`, {});
  }
  return { status: 'installed', count: pack.length };
}
