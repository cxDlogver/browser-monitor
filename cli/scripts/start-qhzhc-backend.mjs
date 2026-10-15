import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
let evidence;
for (const run of (await readdir(resolve(root,'Plan/evidence'))).sort().reverse()) {
  if (await readFile(resolve(root,'Plan/evidence',run,'business-runtime.json'),'utf8').catch(()=>false)) { evidence=resolve(root,'Plan/evidence',run); break; }
}
const runtime=JSON.parse(await readFile(resolve(evidence,'business-runtime.json'),'utf8'));
const cwd='F:/CX_notes/cx-learn-notes/qhzhc-realtime-platform/QHZHC_Server';
const requireServer=createRequire(resolve(cwd,'package.json'));
const executable='C:/Users/xiang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe';
const child=spawn(executable,['--import',pathToFileURL(requireServer.resolve('tsx')).href,'src/server/index.ts'],{cwd,windowsHide:true,env:{...process.env,DATABASE_PATH:resolve(runtime.workDirectory,'qhzhc.sqlite'),NODE_ENV:'development'}});
let log='';
for (const stream of [child.stdout,child.stderr]) stream.on('data',(chunk)=>{
  const safe=String(chunk).replace(/Demo account:.*(?:\r?\n|$)/g,'Demo account: [redacted]\n'); log+=safe; process.stdout.write(safe);
});
await writeFile(resolve(evidence,'qhzhc-backend-owned.json'),JSON.stringify({pid:child.pid,parentPid:process.pid,owned:true,executable,source:'local_test_server'},null,2));
child.on('close',async(code)=>{await writeFile(resolve(evidence,'qhzhc-backend.log'),log);process.exitCode=code??1;});
