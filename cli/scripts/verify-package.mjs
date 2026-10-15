import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Verify the actual tarball via a separate global prefix, with no workspace runtime dependencies.
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(packageDirectory, '..');
const npmEntry = process.env.npm_execpath;
assert(npmEntry, 'Run this verifier with npm run test:package.');
const batchId = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8);
const evidenceDirectory = join(repositoryDirectory, 'Plan', '发布记录', batchId);
const prefix = join(evidenceDirectory, 'global-prefix');
const businessDirectory = join(evidenceDirectory, 'business-directory');
const credentialsDirectory = join(evidenceDirectory, 'fixture-credentials');
await mkdir(businessDirectory, { recursive: true });
const report = { batchId, target: 'npm tarball and isolated global install', status: 'running', steps: [] };
const env = { ...process.env, BM_HOME: credentialsDirectory, NO_COLOR: '1' };
let server;

async function run(command, args, options = {}) {
  const { stdin, expectedExitCode = 0, ...childOptions } = options;
  const child = spawn(command, args, {
    cwd: businessDirectory, env, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'], ...childOptions,
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
    child.stdin.end(stdin);
  });
  report.steps.push({ command, args, expectedExitCode, observedExitCode: exitCode, stdout, stderr });
  assert.equal(exitCode, expectedExitCode, stderr || stdout);
  return stdout;
}
const npm = (args, options) => run(process.execPath, [npmEntry, ...args], options);
const projectId = '11111111-1111-4111-8111-111111111111';
const keyId = '22222222-2222-4222-8222-222222222222';

try {
  await npm(['run', 'build'], { cwd: packageDirectory });
  const packed = JSON.parse(await npm([
    'pack', '--json', '--ignore-scripts', '--pack-destination', evidenceDirectory,
  ], { cwd: packageDirectory }))[0];
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  assert.equal(packed.name, manifest.name);
  assert.equal(packed.version, manifest.version);
  assert(!manifest.private, 'Package must be publishable.');
  assert.equal(manifest.bin.bm, './bin/bm.mjs');
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
  const paths = packed.files.map(file => file.path);
  for (const path of paths) {
    assert(/^(?:package\.json|README\.md|CHANGELOG\.md|LICENSE|bin\/bm\.mjs|dist\/[^/]+\.js)$/.test(path), 'Unexpected published file: ' + path);
  }
  for (const required of ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'bin/bm.mjs', 'dist/index.js']) assert(paths.includes(required), 'Missing ' + required);
  const runtimeFiles = (await readdir(join(packageDirectory, 'dist'))).filter(path => path.endsWith('.js'));
  for (const file of runtimeFiles) assert(paths.includes('dist/' + file), 'Runtime module is missing: ' + file);
  const tarball = join(evidenceDirectory, packed.filename);
  const archive = await readFile(tarball);
  const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
  assert.equal(integrity, packed.integrity);
  report.package = { name: manifest.name, version: manifest.version, tarball, integrity, files: paths };
  await writeFile(join(evidenceDirectory, 'pack-manifest.json'), JSON.stringify(packed, null, 2) + '\n');

  await npm(['install', '--global', tarball, '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/']);
  const installedDirectory = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', manifest.name);
  const installed = JSON.parse(await readFile(join(installedDirectory, 'package.json'), 'utf8'));
  assert.equal(installed.version, manifest.version);
  assert.equal(Object.keys(installed.dependencies ?? {}).length, 0);
  for (const file of paths) {
    assert.deepEqual(await readFile(join(installedDirectory, file)), await readFile(join(packageDirectory, file)), 'Installed contents differ: ' + file);
  }
  const executable = join(installedDirectory, 'bin', 'bm.mjs');
  const cli = async (args, options) => {
    const value = JSON.parse(await run(process.execPath, [executable, ...args], options));
    assert.equal(value.schemaVersion, 1); return value;
  };
  const globalPath = process.platform === 'win32' ? prefix : join(prefix, 'bin');
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const pathEnv = { ...env, [pathKey]: globalPath + (process.platform === 'win32' ? ';' : ':') + (env[pathKey] ?? '') };
  const help = await run(process.platform === 'win32' ? 'bm.cmd' : 'bm', ['--help'], { env: pathEnv, shell: process.platform === 'win32' });
  assert(help.includes('监控平台 CLI'));
  assert(help.includes('sdk export') && help.includes('events wait'));

  // A labeled fixture checks API and file behavior of the installed artifact, not live business data.
  server = createServer(async (request, response) => {
    const send = (status, data, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify(data));
    };
    const origin = 'http://127.0.0.1:' + server.address().port;
    if (request.url.startsWith('/health/')) return send(200, { status: 'ok' });
    if (request.url === '/api/v1/auth/me') return send(401, { code: 'authentication_required' });
    if (request.url === '/api/v1/auth/login' && request.method === 'POST') {
      for await (const _ of request) { /* consume fixture login without recording its password */ }
      return send(200, { user: { id: 'package-fixture-user', email: 'package-fixture@example.test', displayName: 'Package fixture' }, csrfToken: 'package-fixture-csrf' }, { 'Set-Cookie': 'bm_session=package-fixture-session; Max-Age=600; HttpOnly; Path=/' });
    }
    if (request.url === '/api/v1/projects/' + projectId && request.headers.cookie === 'bm_session=package-fixture-session') {
      return send(200, { id: projectId, displayName: 'Package install fixture', appName: 'installed-cli', enabled: true, role: 'owner', origins: ['http://localhost:3000'], keys: [{ id: keyId, active: true, expiresAt: null, dsn: origin + '/ingest/package-fixture' }] });
    }
    return send(404, { code: 'project_not_found' });
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const health = await cli(['health', '--base-url', baseUrl]);
  assert(health.ok); assert.equal(health.data.managementApi.authentication, 'unknown');
  const login = await cli(['auth', 'login', '--base-url', baseUrl, '--email', 'package-fixture@example.test', '--password-stdin'], { stdin: 'package-fixture-password\n' });
  assert(login.ok && login.data.sessionSaved);
  const use = await cli(['project', 'use', projectId, '--base-url', baseUrl]);
  assert(use.ok && use.data.contextSaved);
  assert.equal(resolve(use.data.path), join(businessDirectory, '.browser-monitor.json'));
  const detail = await cli(['project', 'get']);
  assert(detail.ok); assert.equal(detail.context.projectId, projectId);
  const exported = await cli(['sdk', 'export', '--app-version', '1.0.0', '--environment', 'package-smoke', '--out', 'monitor.json', '--example-out', 'monitor.example.ts']);
  assert(exported.ok); assert.equal(exported.data.artifacts.length, 2);
  const config = JSON.parse(await readFile(join(businessDirectory, 'monitor.json'), 'utf8'));
  assert.deepEqual(Object.keys(config).sort(), ['app', 'transport']);
  assert.equal(config.app.name, 'installed-cli'); assert.equal(config.app.environment, 'package-smoke');
  assert.equal(config.transport.dsn, baseUrl + '/ingest/package-fixture');
  assert((await readFile(join(businessDirectory, 'monitor.example.ts'), 'utf8')).includes('import config from "./monitor.json"'));
  const invalid = await cli(['events', 'list', '--limit', '101'], { expectedExitCode: 2 });
  assert(!invalid.ok); assert.equal(invalid.error.code, 'INVALID_ARGUMENT');
  report.assertions = { packageAllowlist: true, integrity: true, installedContents: true, noRuntimeDependencies: true, globalCommand: true, healthJson: true, sessionFile: true, businessContext: true, sdkFiles: true, structuredError: true };
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message };
  process.exitCode = 1;
} finally {
  if (server) await new Promise(resolveClose => server.close(resolveClose));
  await writeFile(join(evidenceDirectory, 'package-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, evidenceDirectory, package: report.package ?? null, error: report.error ?? null }, null, 2));
}
