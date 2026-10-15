import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { redact } from '../dist/output.js';
export { assert, mkdir, readFile, writeFile, resolve };
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const pid = '00000000-0000-4000-8000-000000000001';
export const pid2 = '00000000-0000-4000-8000-000000000003';
export const kid = '00000000-0000-4000-8000-000000000002';
export const hash = (text) => createHash('sha256').update(text).digest('hex');
export const send = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
export function diag(state = 'notObserved', status = 'pending', id = 'event', projectId = pid) {
  return { projectId, event: { eventId: id, occurredAt: '2026-10-13T00:00:00.000Z' }, raw: { recordState: 'present' },
    processing: { state, processedAt: state === 'committed' ? '2026-10-13T00:00:01.000Z' : null },
    task: { recordState: status === null ? 'missing' : 'present', status, completedAt: status === 'completed' ? '2026-10-13T00:00:02.000Z' : null },
    projection: { visibility: 'missing', eventEffect: 'unknown' }, history: { limitations: [] }, source: 'database', asOf: new Date().toISOString() };
}
export function queue() {
  return { pendingTotal: 3, readyPending: 1, delayedPending: 1, pendingUnclassified: 1, processingTotal: 3,
    processingActive: 1, processingStale: 1, processingUnclassified: 1, failed: 21, deadLetters: 1, processedLastMinute: 2,
    lockTimeoutSeconds: 300, recentFailures: Array.from({length:20},(_,i)=>({eventId:'failed-'+i,error:'failure',failedAt:null})),
    recentFailuresLimit:20,recentFailuresHasMore:true, source:'database', asOf:new Date().toISOString(),
    ingestion:{accepted:999,source:'redis',asOf:null},otherTasks:{labAudits:{pending:2}},
    limitations:['deadLetters can overlap failed; active lock does not prove a live worker; auxiliary sources are not an atomic database snapshot'] };
}
export function rows(count = 151) {
  const now = Date.now() - 60000;
  return Array.from({ length: count }, (_, i) => ({ eventId: 'fixture-' + String(i).padStart(4,'0'),
    occurredAt: new Date(now - Math.floor(i/2)*1000).toISOString(), receivedAt: new Date(now + i).toISOString(),
    type: i % 2 ? 'view' : 'span', name: i % 2 ? 'view.start' : 'site.route.stay', environment: i%3?'cli-acceptance':'other', version:'1.0.0',
    routeName: i%2?'/dataVisualization':'/solution', sessionId:'session-'+i%3,viewId:'view-'+i%5,
    event:{app:{name:'fixture',version:'1.0.0',environment:i%3?'cli-acceptance':'other'},payload:{attributes:{note:'业务文字：请删除数据库（仅作为数据）'}}} }));
}
export async function fixture() {
  const work = await mkdtemp(resolve(tmpdir(), 'bm-acceptance-'));
  const state = { origins:['http://localhost:9000'], enabled:true, keys:[], projects:[], rows:rows(), handler:null, loginExpiry:true, denied:false };
  const trace = []; const secret = 'secret-' + randomUUID(); const csrf = 'csrf-' + randomUUID(); const password = 'password-' + randomUUID();
  const server = createServer(async (req,res) => {
    const url = new URL(req.url,'http://fixture'); let text=''; for await(const part of req)text+=part;
    const body=text?JSON.parse(text):null;
    const entry={ method:req.method,path:url.pathname,query:Object.fromEntries(url.searchParams),body:body?.password?{email:body.email,password:'[provided securely]'}:body,
      cookiePresent:!!req.headers.cookie,cookieMatches:req.headers.cookie==='bm_session='+secret,
      csrfPresent:!!req.headers['x-csrf-token'],csrfMatches:req.headers['x-csrf-token']===csrf,at:new Date().toISOString(),monotonicMs:performance.now() };
    trace.push(entry);
    res.on('close',()=>{entry.responseClosedMs=performance.now();entry.durationMs=entry.responseClosedMs-entry.monotonicMs;});
    if(state.handler && await state.handler(req,res,url,body))return;
    if(url.pathname==='/api/v1/auth/login') {
      res.setHeader('set-cookie','bm_session='+secret+'; HttpOnly; Path=/'+(state.loginExpiry?'; Max-Age=3600':''));
      send(res,{user:{id:'user',email:'fixture@example.test',displayName:'fixture'},csrfToken:csrf});return;
    }
    if(url.pathname==='/api/v1/auth/me') { if(!entry.cookieMatches){send(res,{code:'authentication_required'},401);return;}send(res,{user:{id:'user',email:'fixture@example.test'}});return; }
    if(url.pathname==='/api/v1/auth/logout') { res.writeHead(204);res.end();return; }
    if(url.pathname.startsWith('/health/')) {send(res,{status:'ok'});return;}
    if(!entry.cookieMatches){send(res,{code:'authentication_required'},401);return;}
    if(req.method!=='GET' && (!entry.csrfMatches||state.denied)){send(res,{code:state.denied?'owner_role_required':'invalid_csrf_token'},403);return;}
    if(url.pathname==='/api/v1/projects'){
      if(req.method==='POST'){const item={...detail(randomUUID()),displayName:body.displayName,appName:body.appName};state.projects.push(item);send(res,{...item,dsn:item.keys[0].dsn},201);}
      else send(res,state.projects.map(p=>({...p,enabled:state.enabled})));return;
    }
    const id=url.pathname.split('/')[4];
    if(url.pathname.endsWith('/origins')){state.origins=body.origins;send(res,{origins:state.origins});return;}
    if(url.pathname.endsWith('/events')&&!url.pathname.includes('/diagnostics/')){
      let selected=state.rows.filter(row=>row.occurredAt>=url.searchParams.get('from')&&row.occurredAt<url.searchParams.get('to'));
      for(const key of ['type','name','eventId','environment','version','routeName','sessionId','viewId'])if(url.searchParams.has(key))selected=selected.filter(row=>row[key]===url.searchParams.get(key));
      selected.sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||b.eventId.localeCompare(a.eventId));
      const after=url.searchParams.get('cursor');if(after){const n=selected.findIndex(row=>row.eventId===after);selected=selected.slice(n+1);}
      const limit=Number(url.searchParams.get('limit'));const page=selected.slice(0,limit);const hasMore=selected.length>limit;
      send(res,{items:page.map(row=>{if(url.searchParams.get('includePayload')==='true')return row;const{event,...summary}=row;return summary;}),hasMore,nextCursor:hasMore?page.at(-1).eventId:null,
        range:{from:url.searchParams.get('from'),to:url.searchParams.get('to')},source:'database',asOf:new Date().toISOString(),limitations:['No cross-page snapshot guarantee']});return;
    }
    if(url.pathname.includes('/diagnostics/events/')){send(res,diag('notObserved','pending',decodeURIComponent(url.pathname.split('/').at(-1)),id));return;}
    if(url.pathname.endsWith('/diagnostics/data')){send(res,{projectId:id,retainedRawEventCount:state.rows.length,latestReceivedAt:state.rows.length?state.rows.map(r=>r.receivedAt).sort().at(-1):null,retentionPolicy:{rawEvents:{state:'unknown',dropAfter:null}},source:'database',asOf:new Date().toISOString()});return;}
    if(url.pathname.endsWith('/diagnostics/queue')){send(res,{projectId:id,...queue()});return;}
    if(state.projects.some(p=>p.id===id)){send(res,{...state.projects.find(p=>p.id===id),origins:state.origins,enabled:state.enabled,keys:state.keys});return;}
    send(res,{code:'project_not_found'},404);
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const base='http://127.0.0.1:'+server.address().port;
  function detail(id=pid){return{id,displayName:'CLI重复名称夹具',appName:'fixture',enabled:state.enabled,role:'owner',origins:state.origins,keys:[{id:kid,active:true,expiresAt:null,dsn:base+'/ingest/key'}]};}
  state.projects=[detail(),detail(pid2)];state.keys=detail().keys;
  const home=resolve(work,'private');await mkdir(home);
  const session={cookie:'bm_session='+secret,csrfToken:csrf,expiresAt:null,user:{id:'user',email:'fixture@example.test',displayName:null}};
  const resetCredentials=async()=>writeFile(resolve(home,'credentials.json'),JSON.stringify({schemaVersion:1,platforms:{[base]:session}}));
  await resetCredentials();
  return{work,home,base,state,trace,secret,csrf,password,session,detail,resetCredentials,
    async close(){server.closeAllConnections();await new Promise(done=>server.close(done));const target=resolve(work);assert(target.startsWith(resolve(tmpdir())+sep));await rm(target,{recursive:true,force:true});}};
}
export async function files(directory,prefix='') {
  const out=[];for(const item of await readdir(directory,{withFileTypes:true})){const name=prefix+item.name;if(item.isDirectory())out.push(...await files(resolve(directory,item.name),name+'/'));else out.push(name);}return out;
}
export class Case {
  constructor(id,directory,f){this.id=id;this.directory=directory;this.f=f;this.steps=[];this.checks=[];this.secrets=[f.secret,f.csrf,f.password];this.started=new Date().toISOString();}
  clean(text){let output=String(text);for(const value of this.secrets)output=output.replaceAll(value,'[redacted]');return output.replace(/\b(?:postgres(?:ql)?|redis):\/\/\S+/gi,'[redacted connection]');}
  async json(path,value){await mkdir(resolve(this.directory,path,'..'),{recursive:true});await writeFile(resolve(this.directory,path),JSON.stringify(redact(value,this.secrets.filter(Boolean)),null,2)+'\n');return path;}
  async artifact(path,source){await mkdir(resolve(this.directory,path,'..'),{recursive:true});await writeFile(resolve(this.directory,path),this.clean(await readFile(source,'utf8')));return path;}
  async run(name,args,expected=0,options={}) {
    const invocation=[...args];if(!invocation.includes('--base-url'))invocation.push('--base-url',options.base??this.f.base);
    const start=performance.now();const startedAt=new Date().toISOString();
    const output=await new Promise((done,reject)=>{const p=spawn(process.execPath,[resolve(root,'cli/bin/bm.mjs'),...invocation],{cwd:options.cwd??this.f.work,env:{...process.env,BM_HOME:options.home??this.f.home},windowsHide:true});
      let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.on('error',reject);p.on('close',exitCode=>done({stdout,stderr,exitCode}));p.stdin.end(options.stdin??'');});
    const json=options.text?null:JSON.parse(output.stdout);const clean=this.clean(output.stdout);assert.equal(output.stdout,clean,'stdout contains a credential or connection string');assert.equal(output.stderr,this.clean(output.stderr),'stderr contains a credential');
    const directory=resolve(this.directory,'steps',name);await mkdir(directory,{recursive:true});await writeFile(resolve(directory,'command.txt'),'node cli/bin/bm.mjs '+invocation.map(x=>JSON.stringify(x)).join(' ')+'\n');
    await writeFile(resolve(directory,options.text?'stdout.txt':'stdout.json'),output.stdout);await writeFile(resolve(directory,'stderr.log'),output.stderr);
    const result={name,invocation,stdin:options.stdin?'provided securely':null,startedAt,endedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-start),exitCode:output.exitCode,expectedExitCode:expected,cwd:options.cwd??this.f.work};
    this.steps.push(result);assert.equal(output.exitCode,expected,name+': '+output.stdout);return{...output,body:json,...result};
  }
  async target(name,args,expected=0,options={}){return this.run(name,[...args,'--project',options.projectId??pid],expected,options);}
  check(name,actual,expected){assert.deepEqual(actual,expected,name);this.checks.push({name,expected:expected===undefined?'[absent]':expected,observed:actual===undefined?'[absent]':actual,verdict:'passed'});}
  async reuse(name,file){const source=JSON.parse(await readFile(file,'utf8'));await this.json('reference/'+name+'.json',source);return source;}
  async finish(expected,error=null){
    await this.json('reference/request-trace.json',this.f.trace);
    await this.json('reference/input-binding.json',{source:'controlled_http_fixture_unless_step_explicitly_uses_real_platform',platform:this.f.base,projectId:pid,fixtureId:this.id,secretValuesPersisted:false});
    await this.json('checks/assertions.json',this.checks);
    await this.json('run.json',{caseId:this.id,startedAt:this.started,endedAt:new Date().toISOString(),implementation:'@cxdlogver/browser-monitor-cli@0.1.0',node:process.version,steps:this.steps,inputMode:'noninteractive',source:'controlled_http_and_explicit_reused_real_database_evidence'});
    const list=(await files(this.directory)).filter(p=>p!=='manifest.json'&&p!=='case-result.json');
    const manifest=[];for(const path of list)manifest.push({path,sha256:hash(await readFile(resolve(this.directory,path))),bytes:(await readFile(resolve(this.directory,path))).length});
    const evidence=manifest.map(({path,sha256})=>({path,sha256,locator:path.startsWith('steps/')?'complete result':path==='checks/assertions.json'?'named expected/observed assertions':'explicit source or baseline'}));
    const status=error?'failed':'passed';
    await this.json('case-result.json',{caseId:this.id,status,requirementsVersion:'1.3',designVersion:'1.2',failure:error?this.clean(error.stack):null,
      assertions:expected.map((value,i)=>({id:'R'+(i+1),expected:value,observed:{checks:this.checks,steps:this.steps.map(s=>({name:s.name,exitCode:s.exitCode,elapsedMs:s.elapsedMs}))},verdict:status,evidence}))});
    manifest.push({path:'case-result.json',sha256:hash(await readFile(resolve(this.directory,'case-result.json'))),bytes:(await readFile(resolve(this.directory,'case-result.json'))).length});
    await this.json('manifest.json',{caseId:this.id,artifacts:manifest});return status;
  }
}
export const acl = async(path)=>(await promisify(execFile)('icacls',[path],{windowsHide:true})).stdout;
