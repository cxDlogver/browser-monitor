import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, realpath, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url));
const runs = (await readdir(resolve(root, 'Plan/evidence'))).sort().reverse();
let evidence;
for (const run of runs) {
  if (await readFile(resolve(root, 'Plan/evidence', run, 'checks.json'), 'utf8').then(JSON.parse).then((v) => v.result === 'passed').catch(() => false)) { evidence = resolve(root, 'Plan/evidence', run); break; }
}
if (!evidence) throw new Error('Run verify-local.mjs successfully first.');
const runtime = JSON.parse(await readFile(resolve(evidence, 'runtime.json'), 'utf8'));
const originalFiles = await readFile(resolve(evidence, 'business-integration-before.json'), 'utf8').then(JSON.parse).catch(() => ({}));
const sources = [];
for (const profile of runtime.profiles) {
  const directory = profile.id === 'qhzhc' ? resolve(profile.repository, 'QHZHC_Web') : profile.repository;
  const businessPackage = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  assert.equal(businessPackage.dependencies['@cxdlogver/browser-monitor-sdk'], '0.3.0', 'Business manifest must use the agreed exact SDK version before preparation.');
  const requireBusiness = createRequire(resolve(directory, 'package.json'));
  const sdkPath = requireBusiness.resolve('@cxdlogver/browser-monitor-sdk/package.json');
  const sdk = JSON.parse(await readFile(sdkPath, 'utf8'));
  const requireSdk = createRequire(sdkPath);
  let protocolPath;
  for (const search of requireSdk.resolve.paths('@cxdlogver/browser-monitor-protocol') ?? []) {
    const candidate = resolve(search, '@cxdlogver/browser-monitor-protocol/package.json');
    if (await readFile(candidate, 'utf8').then(JSON.parse).then((value) => value.name === '@cxdlogver/browser-monitor-protocol').catch(() => false)) { protocolPath = candidate; break; }
  }
  if (!protocolPath) throw new Error('Cannot locate installed ESM protocol manifest.');
  const protocol = JSON.parse(await readFile(protocolPath, 'utf8'));
  const sdkRealPath = await realpath(sdkPath), protocolRealPath = await realpath(protocolPath);
  assert.equal(sdk.version, '0.3.0'); assert.equal(protocol.version, '3.0.0');
  assert(!sdkRealPath.includes('browser-monitor\\sdk\\') && !protocolRealPath.includes('browser-monitor\\protocol\\'), 'Must not resolve workspace source.');
  sources.push({ profile: profile.id, packageName: sdk.name, version: sdk.version, protocolVersion: protocol.version, sdkRealPath, protocolRealPath, dependencies: sdk.dependencies, source: 'installed_registry_package', expectedIntegrity: 'sha512-Se2hUqXtEhxmU02/fIZOIFb+zXkZczJISAnuWKU5gbC7N1ZEtaB2u6et8omBNrMKCWSCfqTHZQXZhsvgKsK9Qw==' });
  const configPath = resolve(profile.repository, profile.configFile);
  await mkdir(dirname(configPath), { recursive: true });
  if (!(configPath in originalFiles)) originalFiles[configPath] = await readFile(configPath, 'utf8').catch(() => null);
  await writeFile(configPath, JSON.stringify(profile.config, null, 2) + '\n');
  if (profile.id === 'qhzhc') {
    const mainPath = resolve(directory, 'src/main.ts');
    const original = await readFile(mainPath, 'utf8'); if (!(mainPath in originalFiles)) originalFiles[mainPath] = original;
    let updated = original;
    if (!updated.includes('import monitorConfig from')) updated = updated.replace('import { monitorPlugin } from "@/plugins/monitor";', 'import { monitorPlugin } from "@/plugins/monitor";\nimport monitorConfig from "@/config/monitor.local.json";');
    updated = updated.replace(/dsn: process\.env\.VUE_APP_MONITOR_DSN \?\? "",/, 'dsn: monitorConfig.transport.dsn,')
      .replace(/appName: process\.env\.VUE_APP_MONITOR_APP_NAME \?\? "qhzhc",/, 'appName: monitorConfig.app.name,')
      .replace(/release: process\.env\.VUE_APP_MONITOR_RELEASE \?\? "1\.0\.0",/, 'release: monitorConfig.app.version,')
      .replace(/environment: "production",/, 'environment: monitorConfig.app.environment,');
    assert(updated.includes('dsn: monitorConfig.transport.dsn') && updated.includes('environment: monitorConfig.app.environment'));
    await writeFile(mainPath, updated);
    const tsconfigPath = resolve(directory, 'tsconfig.json');
    const tsconfig = await readFile(tsconfigPath, 'utf8'); if (!(tsconfigPath in originalFiles)) originalFiles[tsconfigPath] = tsconfig;
    if (!tsconfig.includes('"resolveJsonModule"')) await writeFile(tsconfigPath, tsconfig.replace('"moduleResolution": "Node",', '"moduleResolution": "Node",\n    "resolveJsonModule": true,'));
  } else {
    const pluginPath = resolve(directory, 'app/plugins/monitor.client.ts');
    const original = await readFile(pluginPath, 'utf8'); if (!(pluginPath in originalFiles)) originalFiles[pluginPath] = original;
    let updated = original;
    if (!updated.includes('import monitorConfig from')) updated = updated.replace("import { createMonitor } from '@cxdlogver/browser-monitor-sdk'", "import { createMonitor } from '@cxdlogver/browser-monitor-sdk'\nimport monitorConfig from '~/config/monitor.local.json'");
    updated = updated.replace(/    app: \{\r?\n      name: 'guanwang',\r?\n      version: '1\.0\.0',\r?\n      environment: 'production',\r?\n    \},/, '    app: monitorConfig.app,')
      .replace(/      dsn: 'http:\/\/localhost:8080\/api\/v3\/ingest\/[^']+',/, '      dsn: monitorConfig.transport.dsn,');
    assert(updated.includes('app: monitorConfig.app') && updated.includes('dsn: monitorConfig.transport.dsn'));
    await writeFile(pluginPath, updated);
  }
}
await writeFile(resolve(evidence, 'business-integration-before.json'), JSON.stringify(originalFiles, null, 2));
await writeFile(resolve(evidence, 'sdk-installation-source.json'), JSON.stringify({ expected: { sdk: '0.3.0', protocol: '3.0.0', source: 'registry' }, observed: sources, equal: true }, null, 2));
process.stdout.write(JSON.stringify({ ok: true, evidence, profiles: sources.map((item) => ({ profile: item.profile, sdk: item.version, protocol: item.protocolVersion })) }) + '\n');
