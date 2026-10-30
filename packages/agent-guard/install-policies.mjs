// Creates and publishes the default agent-tool policies (default-policies.json) in a workspace, or
// another policy file given as the first argument (e.g. examples/payments-policies.json).
//   OSTRELIO_OPERATOR_KEY=dev-operator-a node packages/omp-plugin/install-policies.mjs   (local demo)
//   OSTRELIO_SESSION=... OSTRELIO_CSRF=... node packages/omp-plugin/install-policies.mjs  (signed-in admin)
// A policy whose published rule already matches the file is left alone; one whose rule changed gets a
// new published version. Running it twice is safe.
import { readFileSync } from 'node:fs';

const base = (process.env.OSTRELIO_BASE_URL ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');
const headers = { 'content-type': 'application/json' };
if (process.env.OSTRELIO_SESSION) Object.assign(headers, { 'x-reviewer-session': process.env.OSTRELIO_SESSION, 'x-csrf-token': process.env.OSTRELIO_CSRF ?? '' });
else headers['x-operator-api-key'] = process.env.OSTRELIO_OPERATOR_KEY ?? 'dev-operator-a';

// Key order differs between the file and the stored rule, so compare with sorted keys.
const canonical = (value) => JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));

const call = async (method, path, body) => {
  const response = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
};

const file = process.argv[2] ? new URL(process.argv[2], `file://${process.cwd()}/`) : new URL('./default-policies.json', import.meta.url);
const policies = JSON.parse(readFileSync(file, 'utf8'));
const existing = await call('GET', '/v1/policies');
if (existing.status !== 200) { console.error(`Could not list policies: ${existing.status} ${JSON.stringify(existing.json)}`); process.exit(1); }
const taken = new Map((existing.json.policies ?? []).map((policy) => [policy.displayKey, policy]));
for (const policy of policies) {
  const found = taken.get(policy.displayKey);
  if (found?.published) {
    const current = (await call('GET', `/v1/policies/${found.id}`)).json;
    const live = (current.versions ?? []).find((version) => version.id === found.published.id) ?? current.versions?.at(-1);
    if (canonical(live?.rule) === canonical(policy.rule)) { console.log(`= ${policy.displayKey} ${policy.name} (up to date)`); continue; }
    const next = await call('POST', `/v1/policies/${found.id}/versions`, { mode: 'ENFORCING', rule: policy.rule });
    if (next.status >= 300) { console.error(`! ${policy.displayKey}: ${next.status} ${JSON.stringify(next.json)}`); process.exit(1); }
    const republished = await call('POST', `/v1/policy-versions/${next.json.id}/publish`, {});
    if (republished.status >= 300) { console.error(`! publish ${policy.displayKey}: ${republished.status} ${JSON.stringify(republished.json)}`); process.exit(1); }
    console.log(`~ ${policy.displayKey} ${policy.name} (rule updated)`);
    continue;
  }
  const detail = found
    ? await call('GET', `/v1/policies/${found.id}`)
    : await call('POST', '/v1/policies', { ...policy, mode: 'ENFORCING' });
  if (detail.status >= 300) { console.error(`! ${policy.displayKey}: ${detail.status} ${JSON.stringify(detail.json)}`); process.exit(1); }
  const versions = detail.json.versions ?? [];
  const version = versions[versions.length - 1]?.id;
  const published = await call('POST', `/v1/policy-versions/${version}/publish`, {});
  if (published.status >= 300) { console.error(`! publish ${policy.displayKey}: ${published.status} ${JSON.stringify(published.json)}`); process.exit(1); }
  console.log(`+ ${policy.displayKey} ${policy.name}`);
}
