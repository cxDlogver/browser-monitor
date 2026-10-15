// Reproducible local integration verification. Uses a dedicated database, never the default monitor database.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url));
const requireDatabase = createRequire(resolve(root, 'platform/packages/database/package.json'));
const { Pool } = requireDatabase('pg');
const { hashPassword } = await import(pathToFileURL(resolve(root, 'platform/packages/shared/dist/index.js')).href);
const { createDatabase } = await import(pathToFileURL(resolve(root, 'platform/packages/database/dist/index.js')).href);
const { createPerformanceEventFixture, createBatchFixture } = await import(pathToFileURL(resolve(root, 'protocol/dist/fixtures.js')).href);
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
const output = resolve(root, 'Plan/evidence', runId);
const work = await mkdtemp(resolve(tmpdir(), 'bm-local-'));
await mkdir(output, { recursive: true });
const baseUrl = 'http://localhost:8080';
const password = randomBytes(24).toString('base64url');
const email = 'cli-' + runId.toLowerCase() + '@example.test';
const databaseName = 'browser_monitor_cli_acceptance';
const admin = new Pool({ connectionString: process.env.CLI_TEST_ADMIN_DATABASE_URL ?? 'postgres://monitor:monitor@localhost:15432/postgres' });
const configuredUrl = new URL(process.env.CLI_TEST_ADMIN_DATABASE_URL ?? 'postgres://monitor:monitor@localhost:15432/postgres');
configuredUrl.pathname = '/' + databaseName;
const connection = configuredUrl.href;
const database = createDatabase(connection);
const children = [];
const checks = [];
const sanitize = (text) => String(text).replaceAll(password, '[redacted]').replaceAll(connection, '[redacted database connection]');
function start(path) {
  const child = spawn(process.execPath, [resolve(root, path)], {
    cwd: root, env: { ...process.env, ...environment }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let log = '';
  child.stdout.on('data', (chunk) => log += sanitize(chunk));
  child.stderr.on('data', (chunk) => log += sanitize(chunk));
  child.on('close', () => writeFile(resolve(output, path.includes('/api/') ? 'api.log' : 'worker.log'), log));
  return child;
}
const environment = {
  NODE_ENV: 'test', DATABASE_URL: connection, REDIS_URL: process.env.CLI_TEST_REDIS_URL ?? 'redis://localhost:16379',
  USER_HASH_SECRET: randomBytes(32).toString('hex'), COOKIE_SECRET: randomBytes(32).toString('hex'),
  AUDIT_HEADER_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
  API_PORT: '8080', PUBLIC_BASE_URL: baseUrl, SMTP_HOST: 'localhost', SMTP_PORT: '1025',
  SMTP_FROM: 'CLI Acceptance <cli@example.test>', WORKER_POLL_INTERVAL_MS: '100',
};
async function cli(label, args, expected = 0, stdin = '') {
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'cli/bin/bm.mjs'), ...args, '--base-url', baseUrl], {
      cwd: work, env: { ...process.env, BM_HOME: resolve(work, 'credentials') }, windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => stdout += chunk); child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', reject); child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
  await writeFile(resolve(output, label + '.json'), JSON.stringify({ invocation: args, stdin: stdin ? '[provided securely]' : null, expectedExitCode: expected, observedExitCode: result.code, result: JSON.parse(result.stdout), stderr: sanitize(result.stderr) }, null, 2) + '\n');
  assert.equal(result.code, expected, label + ': ' + result.stdout);
  checks.push({ name: label, status: 'passed', evidence: label + '.json' });
  return JSON.parse(result.stdout);
}
async function waitReady() {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { const reply = await fetch(baseUrl + '/health/ready'); if (reply.ok) return; } catch {}
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error('API did not start within 20 seconds.');
}
try {
  // Refuse to replace another service already using the baseline port.
  let occupied = false;
  try { await fetch(baseUrl + '/health/live', { signal: AbortSignal.timeout(1000) }); occupied = true; } catch {}
  if (occupied) throw new Error('Port 8080 is already occupied; no existing process was stopped.');
  const found = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName]);
  if (!found.rows.length) await admin.query('CREATE DATABASE "' + databaseName + '"');
  const pool = database.pool;
  await pool.query('CREATE TABLE IF NOT EXISTS monitor_schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const migrations = (await readdir(resolve(root, 'platform/packages/database/migrations'))).filter((name) => name.endsWith('.sql')).sort();
  for (const migration of migrations) {
    if ((await pool.query('SELECT 1 FROM monitor_schema_migrations WHERE name=$1', [migration])).rows.length) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(resolve(root, 'platform/packages/database/migrations', migration), 'utf8'));
      await client.query('INSERT INTO monitor_schema_migrations(name) VALUES ($1)', [migration]); await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const user = (await pool.query('INSERT INTO users(email,password_hash,display_name,email_verified_at) VALUES ($1,$2,$3,now()) RETURNING id',
    [email, await hashPassword(password), 'CLI acceptance'])).rows[0];
  start('platform/apps/api/dist/main.js'); await waitReady();
  await cli('health-anonymous', ['health']);
  await cli('login', ['auth', 'login', '--email', email, '--password-stdin'], 0, password + '\n');
  await cli('auth-status', ['auth', 'status']);
  const fixed = JSON.parse(await readFile(resolve(root, 'Plan/监控平台CLI验收输入.json'), 'utf8'));
  const profiles = [];
  for (const profile of fixed.profiles) {
    const created = await cli(profile.id + '-create', ['project', 'create', '--display-name', profile.displayName, '--app-name', profile.appName]);
    const projectId = created.data.id;
    const args = ['--project', projectId];
    await cli(profile.id + '-get', ['project', 'get', ...args]);
    await cli(profile.id + '-origins', ['origins', 'set', '--origin', profile.origin, ...args]);
    await cli(profile.id + '-origins-readback', ['origins', 'get', ...args]);
    const exported = await cli(profile.id + '-export', ['sdk', 'export', '--app-version', profile.appVersion, '--environment', profile.environment, ...args]);
    await writeFile(resolve(output, profile.id + '-monitor.json'), JSON.stringify(exported.data.config, null, 2) + '\n');
    await writeFile(resolve(output, profile.id + '-monitor.example.ts'), exported.data.example);
    profiles.push({ ...profile, projectId, keyId: exported.data.keyId, dsn: exported.data.config.transport.dsn, config: exported.data.config });
  }
  const profile = profiles[0];
  const projectArgs = ['--project', profile.projectId];
  const occurredAt = Date.now();
  const event = createPerformanceEventFixture({ eventId: randomUUID(), occurredAt, app: profile.config.app });
  event.context.routeName = '/dataVisualization';
  // This is explicitly a controlled protocol fixture. Real business evidence is captured separately.
  const ingest = await fetch(profile.dsn, { method: 'POST', headers: { 'content-type': 'application/json', Origin: profile.origin }, body: JSON.stringify(createBatchFixture([event])) });
  const ingestBody = await ingest.json();
  await writeFile(resolve(output, 'controlled-ingestion.json'), JSON.stringify({ source: 'controlled_protocol_fixture', status: ingest.status, response: ingestBody, identity: { projectId: profile.projectId, eventId: event.eventId, occurredAt: new Date(occurredAt).toISOString() } }, null, 2));
  assert.equal(ingest.status, 202);
  const worker = start('platform/apps/worker/dist/main.js');
  await cli('event-wait-real-worker', ['events', 'wait', '--event-id', event.eventId, '--occurred-at', new Date(occurredAt).toISOString(), '--timeout', '10', '--interval', '1', ...projectArgs]);
  worker.kill();
  await new Promise((done) => worker.once('close', done));
  const summary = await cli('data-summary', ['data', 'summary', ...projectArgs]);
  const reference = (await pool.query('SELECT count(*)::text AS count, max(received_at) AS latest FROM telemetry_events WHERE project_id=$1', [profile.projectId])).rows[0];
  assert.equal(summary.data.retainedRawEventCount, Number(reference.count));
  assert.equal(summary.data.latestReceivedAt, reference.latest.toISOString());
  await writeFile(resolve(output, 'database-reference-summary.json'), JSON.stringify({ source: 'independent_database_query', reference, expected: { retainedRawEventCount: Number(reference.count), latestReceivedAt: reference.latest.toISOString() }, observed: summary.data, equal: true }, null, 2));
  await cli('event-diagnose', ['events', 'diagnose', '--event-id', event.eventId, '--include-payload', ...projectArgs]);
  // Raw query fixtures: 151 records inside a fixed window, including equal sort timestamps.
  const from = new Date(occurredAt - 1000000).toISOString(), to = new Date(occurredAt + 1000).toISOString();
  for (let index = 0; index < 151; index++) {
    const fixture = createPerformanceEventFixture({ eventId: 'page-' + runId + '-' + index.toString().padStart(3, '0'), occurredAt: occurredAt - 100000 - Math.floor(index / 2) * 1000, app: profile.config.app });
    await pool.query('INSERT INTO telemetry_events(project_id,event_id,occurred_at,type,name,environment,app_version,session_id,view_id,route_name,event) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [profile.projectId, fixture.eventId, new Date(fixture.occurredAt), fixture.type, fixture.name, fixture.app.environment, fixture.app.version, fixture.context.sessionId, fixture.context.viewId, fixture.context.routeName, fixture]);
  }
  const seen = []; let cursor;
  for (let page = 1; page <= 4; page++) {
    const result = await cli('events-page-' + page, ['events', 'list', '--from', from, '--to', to, '--limit', '50', ...(cursor ? ['--cursor', cursor] : []), ...projectArgs]);
    seen.push(...result.data.items.map((item) => item.eventId));
    cursor = result.data.nextCursor; if (!cursor) break;
  }
  assert.equal(seen.length, 152); assert.equal(new Set(seen).size, 152);
  await cli('events-payload-filter', ['events', 'list', '--event-id', event.eventId, '--type', event.type, '--name', event.name, '--environment', profile.environment, '--version', profile.appVersion, '--route-name', event.context.routeName, '--session-id', event.context.sessionId, '--view-id', event.context.viewId, '--include-payload', ...projectArgs]);
  await cli('events-empty', ['events', 'list', '--name', 'not-present-' + runId, ...projectArgs]);
  const missing = await cli('event-missing', ['events', 'diagnose', '--event-id', 'not-present-' + runId, ...projectArgs]);
  assert.equal(missing.data.processing.state, 'unknown');
  // Preserve raw processing evidence while deleting only this controlled fixture's completion task.
  await pool.query('DELETE FROM outbox_tasks WHERE project_id=$1 AND event_id=$2', [profile.projectId, event.eventId]);
  await cli('wait-history-incomplete', ['events', 'wait', '--event-id', event.eventId, ...projectArgs], 7);
  // Queue fixtures (timestamps deliberately straddle the executable policy).
  const fixtureIds = [];
  for (const [status, availableOffset, lockOffset, error] of [
    ['pending', -60, null, null], ['pending', 60, null, 'retry'],
    ['processing', 0, -30, null], ['processing', 0, -600, null], ['processing', 0, null, null],
    ...Array.from({ length: 21 }, (_, index) => ['failed', 0, null, 'fixture failure ' + index]),
  ]) {
    const id = randomUUID(); fixtureIds.push(id);
    await pool.query('INSERT INTO outbox_tasks(id,project_id,event_id,occurred_at,event,status,available_at,locked_at,last_error,last_failed_at) VALUES ($1,$2,$3,$4,$5,$6,now()+($7*interval \'1 second\'),CASE WHEN $8::integer IS NULL THEN NULL ELSE now()+($8*interval \'1 second\') END,$9,CASE WHEN $9::text IS NULL THEN NULL ELSE now() END)',
      [id, profile.projectId, 'queue-' + id, new Date(occurredAt), event, status, availableOffset, lockOffset, error]);
  }
  await pool.query('INSERT INTO dead_letter_tasks(id,project_id,event_id,event,attempts,last_error) SELECT id,project_id,event_id,event,attempts,last_error FROM outbox_tasks WHERE id=$1', [fixtureIds.at(-1)]);
  const queue = await cli('queue-status', ['queue', 'status', ...projectArgs]);
  assert.deepEqual([queue.data.pendingTotal, queue.data.readyPending, queue.data.delayedPending, queue.data.processingTotal, queue.data.processingActive, queue.data.processingStale, queue.data.processingUnclassified, queue.data.failed, queue.data.deadLetters], [2,1,1,3,1,1,1,21,1]);
  assert.equal(queue.data.recentFailures.length,20); assert.equal(queue.data.recentFailuresHasMore,true);
  await writeFile(resolve(output, 'queue-reference.json'), JSON.stringify({ source: 'controlled_fixture_manifest', expected: { pendingTotal: 2, readyPending: 1, delayedPending: 1, processingTotal: 3, processingActive: 1, processingStale: 1, processingUnclassified: 1, failed: 21, deadLetters: 1, recentFailuresHasMore: true }, observed: queue.data, equal: true }, null, 2));
  const member = (await pool.query('INSERT INTO users(email,password_hash,display_name,email_verified_at) VALUES ($1,$2,$3,now()) RETURNING id',
    ['member-' + email, await hashPassword(password), 'CLI member'])).rows[0];
  await pool.query('INSERT INTO project_members(project_id,user_id,role) VALUES ($1,$2,\'member\')', [profile.projectId, member.id]);
  await cli('member-login', ['auth', 'login', '--email', 'member-' + email, '--password-stdin'], 0, password + '\n');
  await cli('member-read', ['project', 'get', ...projectArgs]);
  await cli('member-write-denied', ['origins', 'set', '--origin', 'http://localhost:3000', ...projectArgs], 4);
  await cli('logout', ['auth', 'logout']);
  await writeFile(resolve(output, 'runtime.json'), JSON.stringify({ runId, baseUrl, databaseName, profiles, source: 'controlled_fixture_and_actual_api_worker', realBusinessEventEvidence: 'pending', account: { id: user.id, email, role: 'owner' }, workDirectory: work }, null, 2));
  await writeFile(resolve(output, 'checks.json'), JSON.stringify({ runId, checks, result: 'passed', limitations: ['Controlled fixtures do not replace two real business input sources.'] }, null, 2));
  process.stdout.write(JSON.stringify({ ok: true, checks: checks.length, evidence: output }) + '\n');
} catch (error) {
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({ message: sanitize(error.stack ?? error), checks }, null, 2));
  process.stderr.write(sanitize(error.stack ?? error) + '\n'); process.exitCode = 1;
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  await database.close(); await admin.end();
}
