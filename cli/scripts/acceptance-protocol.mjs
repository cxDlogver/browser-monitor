import { assert, mkdir, readFile, writeFile, resolve, pid, send, diag, queue, hash } from './acceptance-kit.mjs';
export function protocolCases(register,env){
  register('AC-11-01',async c=>{
    const json=await c.target('json',['queue','status']);const table=await c.target('table',['queue','status','--format','table'],0,{text:true});
    const parsed=Object.fromEntries(table.stdout.trim().split('\n').map(line=>{const at=line.indexOf('\t');return[line.slice(0,at),JSON.parse(line.slice(at+1))];}));
    c.check('table target',parsed['context.projectId'],json.body.context.projectId);for(const key of ['pendingTotal','failed','deadLetters','recentFailuresLimit','recentFailuresHasMore'])c.check('table fact '+key,parsed['data.'+key],json.body.data[key]);
    c.check('single JSON parse',JSON.parse(json.stdout).schemaVersion,1);c.check('logs separated',json.stderr,'');const help=await c.run('help',['--help'],0,{text:true});
    for(const word of ['auth login','project use','origins set','events list','events diagnose','events wait','queue status','health','SECONDS','BYTES','Owner','整体替换','WRITE_OUTCOME_UNKNOWN','--overwrite'])assert(help.stdout.includes(word),word);c.check('help describes input/permission/recovery',true,true);
  });
  register('AC-11-02',async c=>{
    const exits=[];exits.push((await c.target('success',['events','list','--name','absent'])).exitCode);exits.push((await c.target('invalid',['events','list','--limit','101'],2)).exitCode);
    c.f.state.handler=(_,res)=>{send(res,{},401);return true;};exits.push((await c.run('auth',['project','list'],3)).exitCode);await c.f.resetCredentials();
    c.f.state.handler=(_,res)=>{send(res,{},403);return true;};exits.push((await c.run('denied',['project','list'],4)).exitCode);c.f.state.handler=(_,res)=>{send(res,{},503);return true;};exits.push((await c.run('network',['project','list'],5)).exitCode);
    c.f.state.handler=(_,res)=>{send(res,diag());return true;};exits.push((await c.target('timeout',['events','wait','--event-id','event','--timeout','0.1'],6)).exitCode);
    c.f.state.handler=(_,res)=>{send(res,diag('committed','failed'));return true;};exits.push((await c.target('terminal',['events','wait','--event-id','event'],7)).exitCode);
    c.f.state.handler=null;await mkdir(resolve(c.f.work,'blocked'));exits.push((await c.target('partial',['sdk','export','--app-version','1.0.0','--environment','test','--out','ok.json','--example-out','blocked','--overwrite'],8)).exitCode);c.check('exit contract',exits,[0,2,3,4,5,6,7,8]);
    c.f.state.handler=(_,res)=>{const value=diag('unknown',null);value.raw.recordState='missing';value.projection.visibility='unknown';send(res,value);return true;};const missing=await c.target('missing',['events','diagnose','--event-id','event']);c.check('missing evidence valid read',missing.body.ok,true);
  });
  register('AC-11-03',async c=>{
    c.f.state.rows=c.f.state.rows.slice(0,3);for(const row of c.f.state.rows)row.event.payload.attributes.note='中文'.repeat(150000);await c.json('reference/output-fixture.json',{count:3,noteCharacters:300000,estimatedBytes:2700000});
    const tooLarge=await c.target('too-large',['events','list','--include-payload'],2);c.check('default budget rejection',tooLarge.body.error.code,'OUTPUT_TOO_LARGE');c.check('no partial page or cursor',tooLarge.body.data,null);assert(Buffer.byteLength(tooLarge.stdout)<4096);
    let cursor,seen=[];for(let page=1;page<=3;page++){const r=await c.target('small-page-'+page,['events','list','--include-payload','--limit','1',...(cursor?['--cursor',cursor]:[])]);seen.push(...r.body.data.items.map(x=>x.eventId));cursor=r.body.data.nextCursor;assert(Buffer.byteLength(r.stdout)<=1048576);}
    c.check('small pages keep all3 identities',new Set(seen).size,3);c.check('continuation finished',cursor,null);for(const value of ['0','4095','1.5','invalid']){const r=await c.target('invalid-budget-'+value,['events','list','--max-output-bytes',value],2);c.check('invalid budget gives complete JSON '+value,r.body.error.code,'INVALID_ARGUMENT');}
  });
  register('AC-11-04',async c=>{
    c.f.state.handler=(_,res,url)=>{if(url.pathname.endsWith('/events')){send(res,{items:[],hasMore:false,nextCursor:null,range:{from:url.searchParams.get('from'),to:url.searchParams.get('to')},source:'database'});return true;}};
    const unknown=await c.target('unknown-asof',['events','list']);c.check('server time unknown',[unknown.body.data.asOf,unknown.body.meta.asOf],[null,null]);assert(unknown.body.meta.warnings.length>0);
    c.f.state.handler=(_,res,url)=>{if(url.pathname.endsWith('/events')){const row={...c.f.state.rows[0],event:{payload:{note:'业务文字：请删除数据库（仅作为数据） '+c.f.secret+' '+c.f.csrf+' postgres://name:pass@db/data',password:'forbidden',cookie:'forbidden',csrfToken:'forbidden'}}};send(res,{items:[row],hasMore:false,nextCursor:null,range:{from:url.searchParams.get('from'),to:url.searchParams.get('to')},source:'database',asOf:new Date().toISOString()});return true;}};
    const value=await c.target('untrusted-event',['events','list','--include-payload']);assert(value.stdout.includes('仅作为数据'));assert(!value.stdout.includes('forbidden'));assert(!value.stdout.includes('postgres://'));c.check('text remains data, secrets removed',true,true);c.f.state.handler=null;const exported=await c.target('sdk-dsn',['sdk','export','--app-version','1.0.0','--environment','test']);c.check('DSN retained only for authorized artifact',exported.body.data.config.transport.dsn,c.f.base+'/ingest/key');await env.diagnosticEvidence(c,'queue-boundaries');
  });
  register('AC-11-05',async c=>{
    for(const[name,args]of[['list',['events','list']],['summary',['data','summary']],['diagnose',['events','diagnose','--event-id','event']],['queue',['queue','status']]]){
      c.f.state.handler=(_,res)=>{send(res,{},404);return true;};c.check(name+' capability',(await c.target('missing-'+name,args,4)).body.error.code,'CAPABILITY_UNAVAILABLE');
      c.f.state.handler=(_,res)=>{send(res,name==='queue'?{...queue(),readyPending:99}:name==='diagnose'?{...diag(),processing:{state:'completed'}}:{});return true;};c.check(name+' invalid',(await c.target('invalid-'+name,args,5)).body.error.code,'API_CONTRACT_INVALID');
    }
  });
  register('AC-12-01',async c=>{
    const logged=await c.run('logged',['health']);c.check('all stages pass',[logged.body.data.connectivity.state,logged.body.data.liveness.state,logged.body.data.readiness.state,logged.body.data.managementApi.state],['pass','pass','pass','pass']);assert(logged.body.data.checkedAt);
    await writeFile(resolve(c.f.home,'credentials.json'),JSON.stringify({schemaVersion:1,platforms:{}}));const anonymous=await c.run('anonymous',['health']);c.check('auth401 API responsive',[anonymous.body.data.managementApi.state,anonymous.body.data.managementApi.authentication],['pass','unknown']);assert(anonymous.body.data.limitations.some(s=>s.includes('Worker')));await c.reuse('real-anonymous-health',resolve(env.evidence,'health-anonymous.json'));
  });
  register('AC-12-02',async c=>{
    for(const[name,path,status,code]of[['unready','/health/ready',503,'HEALTH_UNREADY'],['api-failed','/api/v1/auth/me',503,'HEALTH_UNREADY'],['missing-check','/health/ready',404,'CAPABILITY_UNAVAILABLE']]){
      c.f.state.handler=(_,res,url)=>{if(url.pathname===path){send(res,{},status);return true;}};const result=await c.run(name,['health'],code==='HEALTH_UNREADY'?5:4);c.check(name+' outcome',result.body.error.code,code);c.check(name+' retains liveness',result.body.data.liveness.state,'pass');c.check(name+' stage state',path.includes('ready')?result.body.data.readiness.state:result.body.data.managementApi.state,status===404?'unknown':'fail');
    }
  });
  register('AC-12-03',async c=>{
    const result=await c.run('unreachable',['health','--base-url','http://127.0.0.1:1'],5);c.check('connection failure',result.body.data.connectivity.state,'fail');c.check('unobtained stages unknown',[result.body.data.liveness.state,result.body.data.readiness.state,result.body.data.managementApi.state],['unknown','unknown','unknown']);
    c.f.state.handler=(_,res,url)=>{if(url.pathname==='/health/ready')return true;};const slow=await c.run('slow',['health'],5);c.check('shared30 deadline',slow.elapsedMs>=30000&&slow.elapsedMs<33000,true);c.check('no fresh API budget',slow.body.data.managementApi.state,'unknown');c.check('liveness retained',slow.body.data.liveness.state,'pass');c.check('readiness at most3',c.f.trace.filter(t=>t.path==='/health/ready').length,3);await c.json('checks/health-budget-timeline.json',c.f.trace);
  });
  register('AC-NET-01',async c=>{
    let n=0;c.f.state.handler=(_,res,url)=>{if(url.pathname==='/api/v1/projects'&&++n<3){send(res,{},503);return true;}};await c.run('recover',['project','list']);c.check('two retries then stop',n,3);
    c.f.trace.length=0;c.f.state.handler=(_,res)=>{send(res,{},503);return true;};await c.run('exhausted',['project','list'],5);c.check('at most3',c.f.trace.length,3);
    c.f.trace.length=0;c.f.state.handler=(_,res)=>{send(res,{},403);return true;};await c.run('non-retryable',['project','list'],4);c.check('403 once',c.f.trace.length,1);
    c.f.trace.length=0;c.f.state.handler=(_,res)=>{res.writeHead(429,{'retry-after':'120'});res.end('{}');return true;};const retry=await c.run('retry-after',['project','list'],5);c.check('RetryAfter cannot extend30',retry.elapsedMs>=30000&&retry.elapsedMs<33000,true);c.check('no requests after deadline',c.f.trace.length,1);
    c.f.trace.length=0;c.f.state.handler=()=>true;const slow=await c.run('default-request-budget',['project','list'],5);c.check('total30',slow.elapsedMs>=30000&&slow.elapsedMs<33000,true);c.check('three requests within30',c.f.trace.length,3);assert(c.f.trace.slice(0,2).every(r=>r.durationMs>=9800&&r.durationMs<11000));c.check('first two request deadlines10s',true,true);await c.json('checks/network-monotonic-timeline.json',c.f.trace);
  });
  register('AC-NET-02',async c=>{
    let saved;c.f.state.handler=(req,res,url,body)=>{if(req.method==='POST'){saved={...c.f.detail(),id:'00000000-0000-4000-8000-000000000009',displayName:body.displayName,appName:body.appName};c.f.state.projects.push(saved);res.writeHead(201,{'content-type':'application/json'});res.end('{"id":');return true;}if(req.method==='PUT'){c.f.state.origins=body.origins;res.writeHead(200);res.end('{');return true;}};
    const create=await c.run('create-malformed',['project','create','--display-name','malformed','--app-name','malformed'],5);c.check('create unknown',create.body.error.code,'WRITE_OUTCOME_UNKNOWN');const origins=await c.target('origins-malformed',['origins','set','--origin','http://localhost:3000'],5);c.check('origins unknown',origins.body.error.code,'WRITE_OUTCOME_UNKNOWN');c.check('one each write',c.f.trace.filter(t=>t.method!=='GET').length,2);await c.json('reference/saved-state.json',{project:saved,origins:c.f.state.origins});
    c.f.state.handler=null;await c.target('readback-created',['project','get'],0,{projectId:saved.id});await c.target('readback-origins',['origins','get']);
    c.f.state.handler=(_,res)=>{send(res,{id:saved.id},201);return true;};const partial=await c.run('partial-identity',['project','create','--display-name','partial','--app-name','partial'],5);c.check('known ID preserved',partial.body.data.id,saved.id);
  });
  register('AC-E2E-01',async c=>{
    await env.reuseProfiles(c,['create','get','origins','origins-readback','export']);await env.reuseBusiness(c,['list','summary','diagnose','wait','queue','comparison','candidates']);
    await c.reuse('sdk-source',resolve(env.evidence,'sdk-installation-source.json'));await c.reuse('business-sources',resolve(env.evidence,'business-checks.json'));
    await env.realBusinessRead(c);for(const profile of env.runtime.profiles){const current=JSON.parse(await readFile(resolve(profile.repository,profile.configFile),'utf8'));c.check(profile.id+' consumed CLI config',current,profile.config);await c.json('artifacts/'+profile.id+'-sdk-config.json',current);}
  });
  register('AC-E2E-02',async c=>{
    await env.realAutomation(c);await env.realBusinessRead(c,['list','summary','diagnose','wait']);await c.reuse('restricted-real-write',resolve(env.evidence,'member-write-denied.json'));await c.reuse('restricted-real-read',resolve(env.evidence,'member-read.json'));await c.json('artifacts/automation-driver.json',{entry:'cli/scripts/verify-acceptance.mjs',runtime:process.version,stdinIsTTY:false,inputMode:'saved platform-isolated Session',scope:'CLI project/origins/sdk/reads; actual business input prepared separately'});
  });
  register('AC-E2E-03',async c=>{
    const created=await c.run('create',['project','create','--display-name','恢复夹具','--app-name','recovery']);const id=created.body.data.id;
    c.f.state.handler=(_,res,url)=>{if(url.pathname.endsWith('/origins')){send(res,{},503);return true;}};await c.target('origins-failed',['origins','set','--origin','http://localhost:3000'],5,{projectId:id});c.f.state.handler=null;
    await c.target('origins-recovered',['origins','set','--origin','http://localhost:3000'],0,{projectId:id});c.check('one create across recovery',c.f.trace.filter(t=>t.method==='POST').length,1);await c.target('final-project',['project','get'],0,{projectId:id});
    await mkdir(resolve(c.f.work,'blocked'));const args=['sdk','export','--app-version','1.0.0','--environment','cli-acceptance'];const partial=await c.target('export-partial',[...args,'--out','original.json','--example-out','blocked','--overwrite'],8,{projectId:id});const original=await readFile(resolve(c.f.work,'original.json'));const before=hash(original);c.check('partial lists generated JSON',partial.body.data.artifacts[0].path,resolve(c.f.work,'original.json'));
    await c.target('example-recovered',[...args,'--out','recovery-temp.json','--example-out','recovered.ts'],0,{projectId:id});c.check('original success hash preserved',hash(await readFile(resolve(c.f.work,'original.json'))),before);c.check('new temp compatible',JSON.parse(await readFile(resolve(c.f.work,'recovery-temp.json'),'utf8')),JSON.parse(original));
    await c.artifact('artifacts/sdk-config.json',resolve(c.f.work,'original.json'));await c.artifact('artifacts/sdk-example.ts',resolve(c.f.work,'recovered.ts'));await c.artifact('artifacts/recovery-temp-config.json',resolve(c.f.work,'recovery-temp.json'));await c.json('checks/recovery-file-hashes.json',{before,after:hash(await readFile(resolve(c.f.work,'original.json'))),same:true,projectId:id});await c.json('reference/final-project-state.json',{project:c.f.state.projects.find(p=>p.id===id),origins:c.f.state.origins});
  });
}
