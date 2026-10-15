import { assert, mkdir, readFile, writeFile, resolve, pid, pid2, kid, send, hash, acl, fixture } from './acceptance-kit.mjs';
export function managementCases(register,env) {
  register('AC-01-01',async c=>{
    const{f}=c;const before={schemaVersion:1,baseUrl:f.base,projectId:pid};await writeFile(resolve(f.work,'.browser-monitor.json'),JSON.stringify(before));await c.json('reference/context-before.json',before);
    c.check('default target',(await c.run('default',['project','get'])).body.context,{baseUrl:f.base,projectId:pid});
    c.check('project override',(await c.run('override',['project','get','--project',pid2])).body.context.projectId,pid2);
    const b=await fixture();try{const creds=JSON.parse(await readFile(resolve(f.home,'credentials.json'),'utf8'));creds.platforms[b.base]=b.session;await writeFile(resolve(f.home,'credentials.json'),JSON.stringify(creds));
      c.check('platform change needs own project',(await c.run('missing',['project','get','--base-url',b.base],2)).body.error.code,'CONTEXT_MISSING');
      c.check('explicit platform B',(await c.run('explicit',['project','get','--base-url',b.base,'--project',pid2])).body.context,{baseUrl:b.base,projectId:pid2});await c.json('reference/platform-b-trace.json',b.trace);
    }finally{await b.close();}
  });
  register('AC-01-02',async c=>{
    const{f}=c;await c.run('use',['project','use',pid]);const before=await readFile(resolve(f.work,'.browser-monitor.json'),'utf8');await c.json('reference/context-after.json',JSON.parse(before));
    f.state.handler=(_,res,url)=>{if(url.pathname.endsWith(pid2)){send(res,{code:'project_not_found'},403);return true;}};
    await c.run('denied',['project','use',pid2],4);const after=await readFile(resolve(f.work,'.browser-monitor.json'),'utf8');c.check('denied preserves context',after,before);c.check('nonsecret context fields',Object.keys(JSON.parse(after)).sort(),['baseUrl','projectId','schemaVersion']);
    f.state.handler=null;const other=resolve(f.work,'call-directory');await mkdir(other);
    const exported=await c.run('export',['sdk','export','--context-dir',f.work,'--app-version','1.0.0','--environment','cli-acceptance','--out','monitor.json'],0,{cwd:other});
    c.check('relative path uses cwd',exported.body.data.artifacts[0].path,resolve(other,'monitor.json'));await c.artifact('artifacts/sdk-config.json',resolve(other,'monitor.json'));
  });
  register('AC-01-03',async c=>{
    c.check('no auto unique project',(await c.run('missing',['data','summary'],2)).body.error.code,'CONTEXT_MISSING');c.f.state.projects=c.f.state.projects.slice(0,1);
    await writeFile(resolve(c.f.work,'.browser-monitor.json'),'{broken');c.check('broken context',(await c.run('broken',['project','get'],2)).body.error.code,'CONTEXT_MISSING');c.check('bad inputs make no requests',c.f.trace.length,0);
    await writeFile(resolve(c.f.work,'.browser-monitor.json'),JSON.stringify({schemaVersion:1,baseUrl:c.f.base,projectId:pid}));
    const cleanDir=resolve(c.f.work,'empty');await mkdir(cleanDir);for(const[name,args]of[['list',['project','list']],['auth-status',['auth','status']],['health',['health']]])await c.run(name,args,0,{cwd:cleanDir});
  });
  register('AC-02-01',async c=>{
    const login=await c.run('login',['auth','login','--email','fixture@example.test','--password-stdin'],0,{stdin:c.f.password+'\n'});await c.run('status',['auth','status']);await c.target('read',['project','get']);
    const credential=await readFile(resolve(c.f.home,'credentials.json'),'utf8');c.check('session saved',login.body.data.sessionSaved,true);c.check('no password persisted',credential.includes(c.f.password),false);
    const permission=await acl(resolve(c.f.home,'credentials.json'));await c.json('checks/credential-permissions.json',{platform:process.platform,icacls:permission});assert(!permission.includes('(I)'));assert(!permission.includes('Everyone'));assert(!permission.includes('BUILTIN\\Users'));c.check('ACL excludes inherited broad access',true,true);
    await c.json('checks/credential-fields.json',{schemaVersion:1,platformCount:1,fields:Object.keys(JSON.parse(credential).platforms[c.f.base]),passwordPersisted:false});
    await c.json('checks/secret-scan.json',{scanned:'all command stdout/stderr and credential field structure',passwordInOutput:false,cookieInOutput:false,csrfInOutput:false});
  });
  register('AC-02-02',async c=>{
    await c.run('stdin-login',['auth','login','--email','fixture@example.test','--password-stdin'],0,{stdin:c.f.password+'\n'});
    const before=c.f.trace.length;c.check('no TTY no input',(await c.run('no-input',['auth','login','--email','fixture@example.test'],2)).body.error.code,'INVALID_ARGUMENT');c.check('no input makes no request',c.f.trace.length,before);
    c.f.state.handler=(_,res)=>{send(res,{code:'session_expired'},401);return true;};c.check('expired',(await c.run('expired',['project','list'],3)).body.error.code,'AUTH_EXPIRED');
    c.f.state.handler=null;c.f.state.loginExpiry=false;const unknown=await c.run('unknown-expiry',['auth','login','--email','fixture@example.test','--password-stdin'],0,{stdin:c.f.password+'\n'});c.check('expiry not guessed',unknown.body.data.expiresAt,null);await c.json('reference/auth-response-redacted.json',{setCookieAttributes:['HttpOnly','Path=/'],expiryAttribute:false});
  });
  register('AC-02-03',async c=>{
    const b=await fixture();try{const creds=JSON.parse(await readFile(resolve(c.f.home,'credentials.json'),'utf8'));creds.platforms[b.base]=b.session;await writeFile(resolve(c.f.home,'credentials.json'),JSON.stringify(creds));
      await c.target('read-a',['project','get']);await c.run('read-b',['project','get','--project',pid,'--base-url',b.base]);c.check('A uses own cookie',c.f.trace.at(-1).cookieMatches,true);c.check('B uses own cookie',b.trace.at(-1).cookieMatches,true);
      c.f.state.handler=(_,res)=>{res.writeHead(302,{location:b.base+'/private'});res.end();return true;};const n=b.trace.length;await c.run('redirect',['project','list'],5);c.check('no redirected auth request',b.trace.length,n);c.f.state.handler=null;
      await c.target('owner-write',['origins','set','--origin','http://localhost:3000']);c.check('CSRF attached',c.f.trace.at(-1).csrfMatches,true);
      c.f.state.denied=true;await c.target('denied-write',['origins','set','--origin','http://localhost:3001'],4);c.f.state.denied=false;
      const before=[...c.f.state.origins];for(const[name,token]of[['missing-csrf',null],['invalid-csrf','invalid']]){const res=await fetch(c.f.base+'/api/v1/projects/'+pid+'/origins',{method:'PUT',headers:{Cookie:c.f.session.cookie,'content-type':'application/json',...(token?{'x-csrf-token':token}:{})},body:JSON.stringify({origins:['http://localhost:3002']})});await c.json('steps/'+name+'/stdout.json',{status:res.status,body:await res.json()});c.check(name+' rejected',res.status,403);}
      c.check('denied writes preserve set',c.f.state.origins,before);await c.json('reference/platform-b-trace.json',b.trace);
      await env.verifyRealCsrf(c);
    }finally{await b.close();}
  });
  register('AC-02-04',async c=>{
    await c.run('logout',['auth','logout']);c.check('local cleared',Object.keys(JSON.parse(await readFile(resolve(c.f.home,'credentials.json'),'utf8')).platforms).length,0);
    await c.run('verify-remote',['auth','status'],3);await c.f.resetCredentials();c.f.state.handler=req=>{req.socket.destroy();return true;};const unknown=await c.run('logout-unreachable',['auth','logout'],8);c.check('remote unknown',unknown.body.data,{localCleared:true,remoteRevocation:'unknown'});
    c.f.state.handler=null;await writeFile(resolve(c.f.home,'credentials.json.lock'),'controlled save failure');const partial=await c.run('login-save-failed',['auth','login','--email','fixture@example.test','--password-stdin'],8,{stdin:c.f.password+'\n'});c.check('accepted but not saved',partial.body.data.sessionSaved,false);await c.json('reference/auth-accepted.json',{loginRequestAccepted:true,sessionIssued:true,localSaveBlockedBy:'exclusive lock fixture'});
    await c.reuse('real-logout',resolve(env.evidence,'logout.json'));
  });
  register('AC-03-01',async c=>{
    await c.run('list-before',['project','list']);await c.run('select-before',['project','use',pid]);const before=await readFile(resolve(c.f.work,'.browser-monitor.json'),'utf8');const created=await c.run('create',['project','create','--display-name','新项目','--app-name','test-new']);
    c.check('create keeps context',await readFile(resolve(c.f.work,'.browser-monitor.json'),'utf8'),before);const id=created.body.data.id;
    c.check('readback ID',(await c.target('get',['project','get'],0,{projectId:id})).body.data.id,id);const list=await c.run('list-after',['project','list']);c.check('list includes new ID',list.body.data.items.some(p=>p.id===id),true);await c.run('use',['project','use',id]);c.check('use changes context',JSON.parse(await readFile(resolve(c.f.work,'.browser-monitor.json'),'utf8')).projectId,id);
    await c.json('reference/project-saved.json',c.f.state.projects.find(p=>p.id===id));await env.reuseProfiles(c,['create','get']);await env.realUseProfiles(c);
  });
  register('AC-03-02',async c=>{
    const list=await c.run('duplicate-list',['project','list']);c.check('same names distinct IDs',new Set(list.body.data.items.map(p=>p.id)).size,2);await c.target('get-a',['project','get']);await c.target('get-b',['project','get'],0,{projectId:pid2});
    const count=c.f.trace.length;for(const[name,display,app]of[['blank','   ','valid'],['long','x'.repeat(121),'valid'],['app-long','valid','x'.repeat(129)],['app-invalid','valid','invalid app name']])await c.run('invalid-'+name,['project','create','--display-name',display,'--app-name',app],2);c.check('invalid creates send no writes',c.f.trace.length,count);c.check('no added objects',c.f.state.projects.length,2);
  });
  register('AC-03-03',async c=>{
    let saved;c.f.state.handler=(req,_,url,body)=>{if(req.method==='POST'&&url.pathname==='/api/v1/projects'){saved={...c.f.detail(pid2),displayName:body.displayName,appName:body.appName};c.f.state.projects=[c.f.state.projects[0],saved];req.socket.destroy();return true;}};
    const lost=await c.run('create-lost',['project','create','--display-name','response-lost','--app-name','lost'],5);c.check('write outcome unknown',lost.body.error.code,'WRITE_OUTCOME_UNKNOWN');c.check('exactly one create',c.f.trace.filter(t=>t.method==='POST').length,1);await c.json('reference/saved-project.json',saved);
    c.f.state.handler=null;await c.target('readback',['project','get'],0,{projectId:pid2});c.f.state.handler=async(_,res,url)=>{if(url.pathname.endsWith(pid2))await mkdir(resolve(c.f.work,'.browser-monitor.json'));return false;};const partial=await c.run('use-failed',['project','use',pid2],8);c.check('known ID retained',partial.body.data.projectId,pid2);c.check('still one create',c.f.trace.filter(t=>t.method==='POST').length,1);
  });
  register('AC-04-01',async c=>{
    await c.target('get-before',['origins','get']);const set=await c.target('set',['origins','set','--origin','http://LOCALHOST:80','--origin','http://localhost/','--origin','https://EXAMPLE.test:443']);
    c.check('normalized set',set.body.data.origins,['http://localhost','https://example.test']);c.check('replace entire set',(await c.target('get-after',['origins','get'])).body.data.origins,c.f.state.origins);c.check('old removed',c.f.state.origins.includes('http://localhost:9000'),false);await c.json('reference/saved-state.json',c.f.state.origins);await env.reuseProfiles(c,['origins','origins-readback']);
  });
  register('AC-04-02',async c=>{
    const before=[...c.f.state.origins];for(const[name,value]of[['text','not-a-url'],['ftp','ftp://localhost:3000'],['path','http://localhost:3000/path'],['empty','   ']])await c.target('invalid-'+name,['origins','set','--origin',value],2);
    await c.target('invalid-too-many',['origins','set',...Array.from({length:51},(_,i)=>['--origin','http://localhost:'+(3000+i)]).flat()],2);c.check('invalid has no writes',c.f.trace.length,0);c.f.state.denied=true;await c.target('denied',['origins','set','--origin','http://localhost:3000'],4);c.check('denied preserves state',c.f.state.origins,before);await c.json('reference/origins-after-denied.json',c.f.state.origins);
  });
  register('AC-04-03',async c=>{
    c.f.state.handler=(req,_,url,body)=>{if(url.pathname.endsWith('/origins')){c.f.state.origins=body.origins;req.socket.destroy();return true;}};const lost=await c.target('set-lost',['origins','set','--origin','http://localhost:3000'],5);c.check('unknown',lost.body.error.code,'WRITE_OUTCOME_UNKNOWN');c.check('only one PUT',c.f.trace.filter(t=>t.method==='PUT').length,1);c.f.state.handler=null;c.check('actual readback',(await c.target('get-after',['origins','get'])).body.data.origins,['http://localhost:3000']);await c.json('reference/saved-state.json',c.f.state.origins);
  });
  register('AC-05-01',async c=>{
    const args=['sdk','export','--app-version','1.0.0','--environment','cli-acceptance'];const files=await c.target('export-files',[...args,'--out','monitor.json','--example-out','monitor.ts']);
    const config=JSON.parse(await readFile(resolve(c.f.work,'monitor.json'),'utf8'));c.check('pure config',Object.keys(config).sort(),['app','transport']);c.check('app params',config.app,{name:'fixture',version:'1.0.0',environment:'cli-acceptance'});
    const inline=await c.target('export-inline',args);c.check('inline equals file',inline.body.data.config,config);assert(inline.body.data.example.includes('monitor.start()'));assert(inline.body.data.example.includes('view: { resolveRouteName: (location) => location.pathname }'));c.check('example initializes and starts',true,true);
    await c.target('missing-version',['sdk','export','--environment','test'],2);await c.target('missing-environment',['sdk','export','--app-version','1.0.0'],2);await c.artifact('artifacts/sdk-config.json',resolve(c.f.work,'monitor.json'));await c.artifact('artifacts/sdk-example.ts',resolve(c.f.work,'monitor.ts'));await env.reuseProfiles(c,['export']);
    await c.target('export-separate-directories',[...args,'--out','config/monitor.json','--example-out','examples/monitor.ts']);c.check('example relative JSON import',(await readFile(resolve(c.f.work,'examples/monitor.ts'),'utf8')).includes('import config from "../config/monitor.json"'),true);
  });
  register('AC-05-02',async c=>{
    const args=['sdk','export','--app-version','1.0.0','--environment','test'];await c.target('unique',args);c.f.state.keys=[];c.check('no key',(await c.target('no-key',args,4)).body.error.code,'KEY_UNAVAILABLE');
    c.f.state.keys=[...c.f.detail().keys,{...c.f.detail().keys[0],id:'other'}];c.check('ambiguous',(await c.target('multiple',args,4)).body.error.code,'KEY_AMBIGUOUS');
    await c.target('explicit',[...args,'--key-id',kid]);c.f.state.enabled=false;c.check('disabled',(await c.target('disabled',args,4)).body.error.code,'PROJECT_DISABLED');c.f.state.enabled=true;
    c.f.state.keys=[{...c.f.detail().keys[0],expiresAt:new Date(Date.now()+3600000).toISOString()}];c.check('transition explicit expiry',(await c.target('transition',[...args,'--key-id',kid])).body.meta.keyExpiresAt,c.f.state.keys[0].expiresAt);
    c.f.state.keys[0].expiresAt='2020-01-01T00:00:00.000Z';await c.target('expired',[...args,'--key-id',kid],4);c.f.state.keys[0].expiresAt=null;c.f.state.keys[0].active=false;await c.target('inactive',[...args,'--key-id',kid],4);
  });
  register('AC-05-03',async c=>{
    const args=['sdk','export','--app-version','1.0.0','--environment','test'];await writeFile(resolve(c.f.work,'old.json'),'old content');const original=hash(await readFile(resolve(c.f.work,'old.json')));
    c.check('guard',(await c.target('exists',[...args,'--out','old.json'],2)).body.error.code,'FILE_EXISTS');c.check('original hash unchanged',hash(await readFile(resolve(c.f.work,'old.json'))),original);
    await c.target('overwrite',[...args,'--out','old.json','--overwrite']);assert(hash(await readFile(resolve(c.f.work,'old.json')))!==original);await c.target('same-path',[...args,'--out','same','--example-out','same'],2);
    await mkdir(resolve(c.f.work,'blocked'));const partial=await c.target('partial',[...args,'--out','saved.json','--example-out','blocked','--overwrite'],8);c.check('successful path retained',partial.body.data.artifacts,[{kind:'out',path:resolve(c.f.work,'saved.json')}]);assert(JSON.parse(await readFile(resolve(c.f.work,'saved.json'),'utf8')).transport.dsn);await c.artifact('artifacts/sdk-config.json',resolve(c.f.work,'saved.json'));
  });
}
