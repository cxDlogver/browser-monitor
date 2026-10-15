// Supplements independent real permission/revocation evidence, then validates every formal artifact hash.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Case, root, files, resolve, readFile, writeFile, mkdir, hash, assert } from './acceptance-kit.mjs';
const output=resolve(root,process.argv[2]);
assert(output.startsWith(resolve(root,'Plan/验收记录')+sep));
const index=JSON.parse(await readFile(resolve(output,'case-index.json'),'utf8'));assert.equal(index.passed,47);assert.equal(index.failed,0);
const runtime=JSON.parse(await readFile(resolve(index.inputEvidence,'business-runtime.json'),'utf8'));
const {Pool}=createRequire(resolve(root,'platform/packages/database/package.json'))('pg');
const pool=new Pool({connectionString:process.env.CLI_TEST_DATABASE_URL??'postgres://monitor:monitor@localhost:15432/browser_monitor_cli_acceptance'});
const {Credentials}=await import(pathToFileURL(resolve(root,'cli/dist/context.js')).href);
const {hashPassword}=await import(pathToFileURL(resolve(root,'platform/packages/shared/dist/index.js')).href);
const work=await mkdtemp(resolve(tmpdir(),'bm-acceptance-final-'));const home=resolve(work,'credentials');
const originalHome=process.env.BM_HOME;process.env.BM_HOME=home;
let owner;
const ownerOptions={base:runtime.baseUrl,home};
async function enhance(id,run){
  const dir=resolve(output,id);const result=JSON.parse(await readFile(resolve(dir,'case-result.json'),'utf8'));const previousRun=JSON.parse(await readFile(resolve(dir,'run.json'),'utf8'));
  const trace=JSON.parse(await readFile(resolve(dir,'reference/request-trace.json'),'utf8'));
  const c=new Case(id,dir,{work,home,base:runtime.baseUrl,secret:randomUUID(),csrf:randomUUID(),password:randomUUID(),trace});
  c.steps=previousRun.steps;c.checks=JSON.parse(await readFile(resolve(dir,'checks/assertions.json'),'utf8'));c.started=previousRun.startedAt;c.secrets.push(owner.cookie,owner.cookie.slice('bm_session='.length),owner.csrfToken);
  await run(c);await c.finish(result.assertions.map(r=>r.expected));
  await c.json('reference/input-binding.json',{source:'controlled fixture plus explicit actual API security supplement',realPlatform:runtime.baseUrl,inputEvidence:index.inputEvidence,projectId:runtime.profiles[0].projectId,secretValuesPersisted:false});
}
try{
  const ownerEmail='cli-final-owner-'+randomUUID()+'@example.test';const ownerPassword=randomUUID()+randomUUID();
  const ownerUser=(await pool.query('INSERT INTO users(email,password_hash,display_name,email_verified_at) VALUES($1,$2,$3,now()) RETURNING id',[ownerEmail,await hashPassword(ownerPassword),'CLI final owner'])).rows[0];
  for(const p of runtime.profiles)await pool.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')",[p.projectId,ownerUser.id]);
  const login=await new Promise((done,reject)=>{const child=spawn(process.execPath,[resolve(root,'cli/bin/bm.mjs'),'auth','login','--base-url',runtime.baseUrl,'--email',ownerEmail,'--password-stdin'],{cwd:work,env:{...process.env,BM_HOME:home},windowsHide:true});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);child.on('close',code=>done({code,stdout,stderr}));child.stdin.end(ownerPassword+'\n');});
  assert.equal(login.code,0);assert(!login.stdout.includes(ownerPassword));await writeFile(resolve(output,'setup/supplemental-owner-login.json'),JSON.stringify({exitCode:login.code,result:JSON.parse(login.stdout),stderr:login.stderr,inputMode:'password-stdin',role:'owner'},null,2));
  owner=JSON.parse(await readFile(resolve(home,'credentials.json'),'utf8')).platforms[runtime.baseUrl];
  await enhance('AC-06-05',async c=>{
    const email='cli-permission-'+randomUUID()+'@example.test';const password=randomUUID()+randomUUID();c.secrets.push(password);
    const user=(await pool.query('INSERT INTO users(email,password_hash,display_name,email_verified_at) VALUES($1,$2,$3,now()) RETURNING id',[email,await hashPassword(password),'CLI permission fixture'])).rows[0];
    const p=runtime.profiles[0];await pool.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'member')",[p.projectId,user.id]);
    await c.run('real-member-login',['auth','login','--email',email,'--password-stdin'],0,{...ownerOptions,stdin:password+'\n'});
    const business=JSON.parse(await readFile(resolve(index.inputEvidence,p.id+'-business-comparison.json'),'utf8')).expected.identity;
    const list=await c.run('real-member-payload',['events','list','--project',p.projectId,'--event-id',business.eventId,'--include-payload'],0,ownerOptions);c.check('actual member can read own project payload',list.body.data.items[0].event.eventId,business.eventId);
    for(const[name,args]of[['events',['events','list','--include-payload']],['diagnostics',['data','summary']],['queue',['queue','status']]]){const denied=await c.run('real-foreign-'+name,[...args,'--project',runtime.profiles[1].projectId],4,ownerOptions);c.check('actual foreign '+name+' denied',denied.body.error.code,'PROJECT_UNAVAILABLE');c.check('no foreign '+name+' content',denied.body.data,null);}
    await c.run('real-member-write-denied',['origins','set','--project',p.projectId,'--origin','http://localhost:3002'],4,ownerOptions);
    await c.json('reference/real-permission-binding.json',{userId:user.id,email,role:'member',allowedProject:p.projectId,deniedProject:runtime.profiles[1].projectId,source:'independent fixture membership'});
  });
  await new Credentials().set(runtime.baseUrl,owner);
  await enhance('AC-02-04',async c=>{
    const before=await fetch(runtime.baseUrl+'/api/v1/auth/me',{headers:{Cookie:owner.cookie}});c.check('old real session initially accepted',before.status,200);await c.json('reference/real-session-before.json',{status:before.status,body:await before.json()});
    const logout=await c.run('real-logout',['auth','logout'],0,ownerOptions);c.check('real revocation confirmed',logout.body.data.remoteRevocation,'confirmed');
    const after=await fetch(runtime.baseUrl+'/api/v1/auth/me',{headers:{Cookie:owner.cookie}});c.check('old real cookie rejected after logout',after.status,401);await c.json('steps/verify-remote/stdout.json',{status:after.status,body:await after.json(),source:'independent request using the previous Session cookie; value not recorded'});
    c.check('actual local Session cleared',JSON.parse(await readFile(resolve(home,'credentials.json'),'utf8')).platforms,{});
  });
  const execute=promisify(execFile);const versions=[];
  for(const p of [{id:'platform',repository:root},...runtime.profiles]){const git=await execute('git',['rev-parse','HEAD'],{cwd:p.repository,windowsHide:true});const status=await execute('git',['status','--short'],{cwd:p.repository,windowsHide:true});versions.push({profile:p.id,repository:p.repository,sourceCommit:git.stdout.trim(),workingChanges:status.stdout.trim()});}
  await writeFile(resolve(output,'setup/source-versions.json'),JSON.stringify({node:process.version,pnpm:'10.28.2',sources:versions},null,2));
  const installation=JSON.parse(await readFile(resolve(index.inputEvidence,'sdk-installation-source.json'),'utf8'));const sourceChecks=[];
  for(const p of runtime.profiles){const manifestPath=resolve(p.repository,p.id==='qhzhc'?'QHZHC_Web/package.json':'package.json');const manifest=JSON.parse(await readFile(manifestPath,'utf8'));assert.equal(manifest.dependencies['@cxdlogver/browser-monitor-sdk'],'0.3.0');const source=installation.observed.find(s=>s.profile===p.id);const actualSdk=await import('node:fs/promises').then(fs=>fs.realpath(source.sdkRealPath));assert(actualSdk.replaceAll('\\','/').includes('node_modules/.pnpm/@cxdlogver+browser-monitor-sdk@0.3.0/'));sourceChecks.push({profile:p.id,manifestVersion:'0.3.0',resolvedSdk:actualSdk,protocolVersion:source.protocolVersion,registryIntegrityVerifiedInLock:true});await writeFile(resolve(output,'setup/source-packages',p.id,'package.json'),await readFile(manifestPath));}
  await writeFile(resolve(output,'setup/installation-audit.json'),JSON.stringify(sourceChecks,null,2));
  const recorded=JSON.parse(await readFile(resolve(output,'setup/implementation.json'),'utf8'));for(const file of recorded.files)assert.equal(hash(await readFile(resolve(root,file.path))),file.sha256,'Implementation changed after the acceptance run: '+file.path);
  const audit=[];let checkpointCount=0,artifactCount=0;
  for(const item of index.cases){const dir=resolve(output,item.caseId);const r=JSON.parse(await readFile(resolve(dir,'case-result.json'),'utf8'));assert.equal(r.status,'passed');assert.equal(r.assertions.length,2);checkpointCount+=r.assertions.length;
    // Refresh hashes after the explicitly recorded supplemental checks.
    const artifactNames=(await files(dir)).filter(p=>p!=='manifest.json'&&p!=='case-result.json');const artifacts=[];for(const path of artifactNames){const content=await readFile(resolve(dir,path));if(path.endsWith('.json'))JSON.parse(content);artifacts.push({path,sha256:hash(content),bytes:content.length});}
    const proofs=artifacts.map(a=>({...a,locator:a.path==='checks/assertions.json'?'named expected / observed assertions':a.path.startsWith('steps/')?'complete command output':'explicit baseline or independent evidence'}));
    for(const assertion of r.assertions){assert.equal(assertion.verdict,'passed');assert(assertion.observed.checks.length>0);assertion.evidence=proofs;}await writeFile(resolve(dir,'case-result.json'),JSON.stringify(r,null,2)+'\n');
    artifacts.push({path:'case-result.json',sha256:hash(await readFile(resolve(dir,'case-result.json'))),bytes:(await readFile(resolve(dir,'case-result.json'))).length});await writeFile(resolve(dir,'manifest.json'),JSON.stringify({caseId:item.caseId,artifacts},null,2)+'\n');
    for(const artifact of artifacts)assert.equal(hash(await readFile(resolve(dir,artifact.path))),artifact.sha256);artifactCount+=artifacts.length;audit.push({caseId:item.caseId,status:'passed',assertions:2,artifacts:artifacts.length});
  }
  assert.equal(checkpointCount,94);await writeFile(resolve(output,'evidence-audit.json'),JSON.stringify({status:'passed',cases:47,checkpoints:checkpointCount,artifactCount,implementationHashesMatch:true,jsonArtifactsParse:true,artifactHashesMatch:true,audit},null,2));
  process.stdout.write(JSON.stringify({ok:true,cases:47,checkpoints:checkpointCount,artifacts:artifactCount,evidence:output})+'\n');
}finally{await pool.end();if(originalHome===undefined)delete process.env.BM_HOME;else process.env.BM_HOME=originalHome;assert(resolve(work).startsWith(resolve(tmpdir())+sep));await rm(work,{recursive:true,force:true});}
