#!/usr/bin/env node
// Sample MCP servers for the systems a company's operations agent touches, beyond payments. One
// process plays one system, chosen with --system: files, it-admin, infra, data or comms. Nothing
// here touches a real system; every tool returns a plausible result.
//   node ops-tools.mjs --system it-admin
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const text = (description) => ({ type: 'string', minLength: 1, description });
const tool = (name, description, properties, required = Object.keys(properties)) => ({
  name, description, inputSchema: { type: 'object', properties, required },
});
const id = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const SYSTEMS = {
  files: {
    tools: [
      tool('list_dir', 'List a directory on the shared file server.', { path: text('Directory, e.g. /srv/reports') }),
      tool('delete_path', 'Delete a file or directory on the shared file server.', {
        path: text('Path to delete, e.g. /srv/logs/2025'), recursive: { type: 'string', enum: ['yes', 'no'], description: 'Delete directory contents too' },
      }),
    ],
    handlers: {
      list_dir: ({ path }) => `${path}: q3-board.pdf, payroll.xlsx, archive/ (3 entries).`,
      delete_path: ({ path, recursive }) => `Deleted ${path}${recursive === 'yes' ? ' and everything in it' : ''}.`,
    },
  },
  'it-admin': {
    tools: [
      tool('list_users', 'List directory users.', { team: text('Team, e.g. finance') }),
      tool('grant_role', 'Grant a directory role to a user.', { user: text('User email'), role: text('Role, e.g. admin, billing-viewer') }),
      tool('disable_mfa', "Turn off a user's multi-factor authentication.", { user: text('User email') }),
      tool('read_secret', 'Read a secret from the secrets manager.', { name: text('Secret name, e.g. prod/db-password') }),
      tool('create_api_key', 'Create an API key for a service account.', { service: text('Service account'), scope: text('Scope, e.g. read, admin') }),
    ],
    handlers: {
      list_users: ({ team }) => `${team}: ana@nimbuspay.example, ben@nimbuspay.example, cai@nimbuspay.example.`,
      grant_role: ({ user, role }) => `Granted ${role} to ${user}.`,
      disable_mfa: ({ user }) => `MFA disabled for ${user}.`,
      read_secret: ({ name }) => `Secret ${name}: ********** (value withheld in this sample).`,
      create_api_key: ({ service, scope }) => `Created key ${id('key')} for ${service} with ${scope} scope.`,
    },
  },
  infra: {
    tools: [
      tool('scale_service', 'Change the number of replicas of a service.', {
        service: text('Service, e.g. checkout-api'), environment: { type: 'string', enum: ['staging', 'production'] }, replicas: { type: 'integer', minimum: 0 },
      }),
      tool('terminate_instance', 'Terminate a compute instance.', { instance: text('Instance id'), environment: { type: 'string', enum: ['staging', 'production'] } }),
      tool('set_bucket_acl', 'Change who can read a storage bucket.', { bucket: text('Bucket name'), acl: { type: 'string', enum: ['private', 'authenticated-read', 'public-read'] } }),
      tool('open_pull_request', 'Open a pull request.', { repo: text('Repository'), branch: text('Source branch'), title: text('Title') }),
      tool('push_branch', 'Push a branch to the remote.', { repo: text('Repository'), branch: text('Branch'), force: { type: 'string', enum: ['yes', 'no'] } }),
    ],
    handlers: {
      scale_service: ({ service, environment, replicas }) => `${service} in ${environment} scaled to ${replicas} replicas.`,
      terminate_instance: ({ instance, environment }) => `Instance ${instance} in ${environment} terminated.`,
      set_bucket_acl: ({ bucket, acl }) => `Bucket ${bucket} is now ${acl}.`,
      open_pull_request: ({ repo, branch, title }) => `Opened pull request #${Math.floor(Math.random() * 900) + 100} in ${repo} from ${branch}: ${title}.`,
      push_branch: ({ repo, branch, force }) => `Pushed ${branch} to ${repo}${force === 'yes' ? ' (forced)' : ''}.`,
    },
  },
  data: {
    tools: [
      tool('run_query', 'Run a SQL statement on the production database.', { sql: text('SQL statement') }),
      tool('export_table', 'Export a table to a CSV file in the data share.', { table: text('Table'), rows: { type: 'integer', minimum: 1 } }),
      tool('upload_to_url', 'Upload a file to an external URL.', { file: text('File in the data share'), url: text('Destination URL') }),
    ],
    handlers: {
      run_query: ({ sql }) => `${sql.split(/\s+/)[0].toUpperCase()} ok: ${Math.floor(Math.random() * 500) + 1} rows.`,
      export_table: ({ table, rows }) => `Exported ${rows} rows of ${table} to ${table}.csv.`,
      upload_to_url: ({ file, url }) => `Uploaded ${file} to ${url}.`,
    },
  },
  comms: {
    tools: [
      tool('send_email', 'Send an email.', { to: text('Recipient address'), subject: text('Subject'), body: text('Body') }),
      tool('send_bulk_notice', 'Email a notice to a customer segment.', { segment: text('Segment, e.g. all-customers'), recipients: { type: 'integer', minimum: 1 }, subject: text('Subject') }),
    ],
    handlers: {
      send_email: ({ to, subject }) => `Email "${subject}" sent to ${to}.`,
      send_bulk_notice: ({ segment, recipients, subject }) => `Notice "${subject}" queued for ${recipients} recipients in ${segment}.`,
    },
  },
};

const name = process.argv[process.argv.indexOf('--system') + 1];
const system = SYSTEMS[name];
if (!system || !process.argv.includes('--system')) {
  console.error(`Usage: ops-tools.mjs --system ${Object.keys(SYSTEMS).join('|')}`);
  process.exit(2);
}

const server = new Server({ name: `sample-${name}`, version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: system.tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const handler = system.handlers[request.params.name];
  if (!handler) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${request.params.name}.` }] };
  console.error(`[sample-${name}] ${request.params.name} ${JSON.stringify(request.params.arguments ?? {})}`);
  return { content: [{ type: 'text', text: handler(request.params.arguments ?? {}) }] };
});
await server.connect(new StdioServerTransport());
console.error(`[sample-${name}] ready`);
