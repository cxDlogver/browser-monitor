import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, readdir, mkdir, mkdtemp, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
let evidence;
for (const run of (await readdir(resolve(root, 'Plan/evidence'))).sort().reverse()) {
  if (await readFile(resolve(root, 'Plan/evidence', run, 'checks.json'), 'utf8').then(JSON.parse).then((v) => v.result === 'passed').catch(() => false)) { evidence = resolve(root, 'Plan/evidence', run); break; }
}
const runtime = JSON.parse(await readFile(resolve(evidence, 'runtime.json'), 'utf8'));
const requireDatabase = createRequire(resolve(root, 'platform/packages/database/package.json'));
const { Pool } = requireDatabase('pg');
const { hashPassword } = await import(pathToFileURL(resolve(root, 'platform/packages/shared/dist/index.js')).href);
const work = await mkdtemp(resolve(tmpdir(), 'bm-business-'));
const secret = randomBytes(24).toString('base64url');
const connection = 'postgres://monitor:monitor@localhost:15432/browser_monitor_cli_acceptance';
const pool = new Pool({ connectionString: connection });
const email = 'business-cli-' + Date.now() + '@example.test';
const user = (await pool.query('INSERT INTO users(email,password_hash,display_name,email_verified_at) VALUES ($1,$2,$3,now()) RETURNING id', [email, await hashPassword(secret), 'Business CLI acceptance'])).rows[0];
for (const profile of runtime.profiles) await pool.query('INSERT INTO project_members(project_id,user_id,role) VALUES ($1,$2,\'owner\')', [profile.projectId, user.id]);
await pool.end();
const children = [];
const services = [];
const environment = {
  NODE_ENV: 'test', DATABASE_URL: connection, REDIS_URL: 'redis://localhost:16379',
  USER_HASH_SECRET: randomBytes(32).toString('hex'), COOKIE_SECRET: randomBytes(32).toString('hex'),
  AUDIT_HEADER_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
  API_PORT: '8080', PUBLIC_BASE_URL: 'http://localhost:8080', SMTP_HOST: 'localhost', SMTP_PORT: '1025',
  SMTP_FROM: 'CLI Acceptance <cli@example.test>', WORKER_POLL_INTERVAL_MS: '200',
};
function start(name, cwd, args, additionalEnvironment = {}, executable = process.execPath) {
  const child = spawn(executable, args, { cwd, env: { ...process.env, ...additionalEnvironment }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); services.push({ name, pid: child.pid, owned: true });
  let text = '';
  const sanitize = (chunk) => String(chunk).replaceAll(secret, '[redacted]').replaceAll(connection, '[redacted connection]').replace(/Demo account:.*(?:\r?\n|$)/g, 'Demo account: [redacted]\n');
  child.stdout.on('data', (chunk) => text += sanitize(chunk)); child.stderr.on('data', (chunk) => text += sanitize(chunk));
  child.on('close', async (code) => { await writeFile(resolve(evidence, 'service-' + name + '.log'), text); process.stderr.write(name + ' exited: ' + code + '\n'); });
  return child;
}
async function available(url) { try { const result = await fetch(url, { signal: AbortSignal.timeout(1500) }); return result.status; } catch { return null; } }
if (await available('http://localhost:8080/health/live')) throw new Error('8080 is already occupied. No service was replaced.');
start('api', root, [resolve(root, 'platform/apps/api/dist/main.js')], environment);
start('worker', root, [resolve(root, 'platform/apps/worker/dist/main.js')], environment);
for (let i=0;i<100;i++) { if (await available('http://localhost:8080/health/ready') === 200) break; await new Promise((done) => setTimeout(done, 200)); }
const login = spawn(process.execPath, [resolve(root, 'cli/bin/bm.mjs'), 'auth', 'login', '--email', email, '--password-stdin'], { cwd: work, env: { ...process.env, BM_HOME: resolve(work, 'credentials') }, windowsHide: true });
let loginOutput = ''; login.stdout.on('data', (chunk) => loginOutput += chunk); login.stdin.end(secret + '\n');
await new Promise((done, reject) => login.on('close', (code) => code === 0 ? done() : reject(new Error('CLI login failed'))));
await writeFile(resolve(evidence, 'business-cli-login.json'), loginOutput);
const qhzhc = 'F:/CX_notes/cx-learn-notes/qhzhc-realtime-platform';
if (!await available('http://127.0.0.1:18080/api/health')) {
  const requireServer = createRequire(resolve(qhzhc, 'QHZHC_Server/package.json'));
  const node24 = process.env.CLI_QHZHC_NODE ?? 'C:/Users/xiang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe';
  start('qhzhc-server', resolve(qhzhc, 'QHZHC_Server'), ['--import', pathToFileURL(requireServer.resolve('tsx')).href, 'src/server/index.ts'], { DATABASE_PATH: resolve(work, 'qhzhc.sqlite'), NODE_ENV: 'development' }, node24);
}
if (!await available('http://127.0.0.1:9527')) {
  const requireFront = createRequire(resolve(qhzhc, 'QHZHC_Web/package.json'));
  start('qhzhc-web', resolve(qhzhc, 'QHZHC_Web'), [requireFront.resolve('@vue/cli-service/bin/vue-cli-service.js'), 'serve'], { VUE_APP_MONITOR_ENABLED: 'true', NODE_ENV: 'development' });
}
if (!await available('http://localhost:3000')) {
  start('official', 'F:/CX_notes/cx-learn-notes/official-network', ['node_modules/nuxt/bin/nuxt.mjs', 'dev', '--host', 'localhost', '--port', '3000'], { NODE_ENV: 'development' });
}
await writeFile(resolve(evidence, 'business-runtime.json'), JSON.stringify({ evidence, workDirectory: work, baseUrl: runtime.baseUrl, profiles: runtime.profiles, services, launcherPid: process.pid }, null, 2));
process.stdout.write(JSON.stringify({ status: 'running', evidence, workDirectory: work, services }) + '\n');
function stop() { for (const child of children) if (child.exitCode === null) child.kill(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
