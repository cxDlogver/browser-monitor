import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url));
let evidence;
for (const run of (await readdir(resolve(root,'Plan/evidence'))).sort().reverse()) {
  if (await readFile(resolve(root,'Plan/evidence',run,'business-runtime.json'),'utf8').catch(()=>false)) { evidence=resolve(root,'Plan/evidence',run); break; }
}
const runtime=JSON.parse(await readFile(resolve(evidence,'business-runtime.json'),'utf8'));
// A new batch supplies browser action records before capture. Replays may reuse the same recorded actions.
const declaredActions=process.argv[2]?JSON.parse(await readFile(resolve(root,process.argv[2]),'utf8')):
  await Promise.all(runtime.profiles.map(async profile=>({profileId:profile.id,...JSON.parse(await readFile(resolve(evidence,profile.id+'-action-record.json'),'utf8'))})));
const { Pool }=createRequire(resolve(root,'platform/packages/database/package.json'))('pg');
const pool=new Pool({connectionString:'postgres://monitor:monitor@localhost:15432/browser_monitor_cli_acceptance'});
const observations=[];
async function cli(profile,label,args) {
  const result=await new Promise((done,reject)=>{
    const child=spawn(process.execPath,[resolve(root,'cli/bin/bm.mjs'),...args,'--project',profile.projectId,'--base-url',runtime.baseUrl],{cwd:runtime.workDirectory,env:{...process.env,BM_HOME:resolve(runtime.workDirectory,'credentials')},windowsHide:true});
    let stdout='',stderr=''; child.stdout.on('data',(chunk)=>stdout+=chunk);child.stderr.on('data',(chunk)=>stderr+=chunk);
    child.on('error',reject);child.on('close',(code)=>done({code,stdout,stderr}));child.stdin.end();
  });
  const body=JSON.parse(result.stdout);
  await writeFile(resolve(evidence,profile.id+'-business-'+label+'.json'),JSON.stringify({invocation:args,expectedExitCode:0,observedExitCode:result.code,result:body,stderr:result.stderr},null,2));
  assert.equal(result.code,0,label+': '+result.stdout);
  return body;
}
try {
  for (const profile of runtime.profiles) {
    const definition=profile.businessEvents.find((event)=>event.primary);
    const declared=declaredActions.find(action=>action.profileId===profile.id);
    assert(declared,'A recorded browser action is required for '+profile.id);
    const {actionStartedAt,actionEndedAt}=declared;
    assert(Number.isFinite(Date.parse(actionStartedAt))&&Number.isFinite(Date.parse(actionEndedAt))&&Date.parse(actionStartedAt)<Date.parse(actionEndedAt),'Action times must form a valid UTC interval.');
    const reference=await pool.query('SELECT event_id,occurred_at,received_at,processed_at,event FROM telemetry_events WHERE project_id=$1 AND type=$2 AND name=$3 AND route_name=$4 AND occurred_at >= $5 AND occurred_at < $6 ORDER BY occurred_at',
      [profile.projectId,definition.type,definition.name,definition.routeName,new Date(actionStartedAt),new Date(actionEndedAt)]);
    const candidates=reference.rows.filter((row)=>profile.id==='qhzhc'||row.event.payload.startedAt>=Date.parse(actionStartedAt));
    await writeFile(resolve(evidence,profile.id+'-business-candidates.json'),JSON.stringify({source:'independent_database_ingestion_envelope',definitionId:definition.id,actionStartedAt,actionEndedAt,rows:reference.rows},null,2));
    assert.equal(candidates.length,1,'Expected one unambiguous business event for '+profile.id+', got '+candidates.length);
    const selected=candidates[0];const event=selected.event;
    assert.equal(event.app.name,profile.appName);assert.equal(event.app.version,'1.0.0');assert.equal(event.app.environment,'cli-acceptance');
    assert.equal(event.context.runtime.sdk.version,'0.3.0');
    if(profile.id==='official'){
      assert.equal(event.payload.attributes.section,'/solution');assert.equal(event.payload.attributes.path,'/solution');
      assert.equal(event.payload.metrics.visibleMs.unit,'ms');assert(event.payload.metrics.visibleMs.value>=0);
      assert(event.correlation.traceId&&event.correlation.spanId);
    }
    const list=await cli(profile,'list',['events','list','--from',actionStartedAt,'--to',actionEndedAt,'--event-id',event.eventId,'--name',definition.name,'--type',definition.type,'--environment',profile.environment,'--version',profile.appVersion,'--route-name',definition.routeName,'--session-id',event.context.sessionId,'--view-id',event.context.viewId,'--include-payload']);
    assert.equal(list.data.items.length,1);assert.deepEqual(list.data.items[0].event,event);
    const diagnostic=await cli(profile,'diagnose',['events','diagnose','--event-id',event.eventId,'--occurred-at',selected.occurred_at.toISOString(),'--include-payload']);
    assert.equal(diagnostic.data.processing.state,'committed');assert.equal(diagnostic.data.task.status,'completed');
    const waited=await cli(profile,'wait',['events','wait','--event-id',event.eventId,'--occurred-at',selected.occurred_at.toISOString(),'--timeout','5']);
    const summary=await cli(profile,'summary',['data','summary']);
    const queue=await cli(profile,'queue',['queue','status']);
    const identity={projectId:profile.projectId,eventId:event.eventId,occurredAt:selected.occurred_at.toISOString(),sessionId:event.context.sessionId,viewId:event.context.viewId,traceId:event.correlation.traceId??null,spanId:event.correlation.spanId??null};
    const action={source:'actual_browser_business_action',definitionId:definition.id,businessAction:definition.businessAction,actionStartedAt,actionEndedAt,observedEntryUrl:profile.entryUrl,observedExitUrl:profile.id==='qhzhc'?'http://127.0.0.1:9527/#/index':'http://localhost:3000/',screenshot:profile.id+'-business-page.jpg',probeUsed:false,identity};
    await writeFile(resolve(evidence,profile.id+'-action-record.json'),JSON.stringify(action,null,2));
    await writeFile(resolve(evidence,profile.id+'-business-comparison.json'),JSON.stringify({expected:{definition,app:profile.config.app,sdkVersion:'0.3.0',identity,processing:'committed',taskStatus:'completed'},observed:{event:list.data.items[0],diagnostic:diagnostic.data,wait:waited.data,data:summary.data,queue:queue.data},evidence:{reference:profile.id+'-business-candidates.json',action:profile.id+'-action-record.json',sdk:'sdk-installation-source.json'},equal:true},null,2));
    observations.push({profile:profile.id,definitionId:definition.id,status:'passed',identity,evidence:profile.id+'-business-comparison.json'});
  }
  await writeFile(resolve(evidence,'business-checks.json'),JSON.stringify({source:'business_event',probeUsed:false,observations,status:'passed'},null,2));
  process.stdout.write(JSON.stringify({ok:true,observations:observations.map((item)=>({profile:item.profile,eventId:item.identity.eventId})),evidence})+'\n');
} catch(error) {
  await writeFile(resolve(evidence,'business-failure.json'),JSON.stringify({message:error.stack,observations},null,2));
  process.stderr.write(error.stack+'\n');process.exitCode=1;
} finally {await pool.end();}
