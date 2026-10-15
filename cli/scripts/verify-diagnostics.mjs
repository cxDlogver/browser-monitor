import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url));
const apiRequire=createRequire(resolve(root,'platform/apps/api/package.json'));
apiRequire('reflect-metadata');
const { createDatabase }=await import(pathToFileURL(resolve(root,'platform/packages/database/dist/index.js')).href);
const { DiagnosticsService }=await import(pathToFileURL(resolve(root,'platform/apps/api/dist/diagnostics/diagnostics.service.js')).href);
const { ProjectsService }=await import(pathToFileURL(resolve(root,'platform/apps/api/dist/projects/projects.service.js')).href);
const { EventProcessor }=await import(pathToFileURL(resolve(root,'platform/apps/worker/dist/processor.js')).href);
const { createPerformanceEventFixture }=await import(pathToFileURL(resolve(root,'protocol/dist/fixtures.js')).href);
let evidence;
for(const run of(await readdir(resolve(root,'Plan/evidence'))).sort().reverse()){
  if(await readFile(resolve(root,'Plan/evidence',run,'business-runtime.json'),'utf8').catch(()=>false)){evidence=resolve(root,'Plan/evidence',run);break;}
}
const logged=JSON.parse(await readFile(resolve(evidence,'business-cli-login.json'),'utf8'));
const userId=logged.data.user.id;
const database=createDatabase('postgres://monitor:monitor@localhost:15432/browser_monitor_cli_acceptance');
const projects=new ProjectsService(database,{PUBLIC_BASE_URL:'http://localhost:8080'},{});
const processor=new EventProcessor(database);
const frozenTime=new Date();
const frozenClientDatabase={...database,pool:{...database.pool,connect:async()=>{
  const client=await database.pool.connect();
  return{query:(sql,values)=>sql==='SELECT transaction_timestamp() AS as_of'?Promise.resolve({rows:[{as_of:frozenTime}]}):client.query(sql,values),release:()=>client.release()};
}}};
const service=new DiagnosticsService(frozenClientDatabase,projects,{hgetall:async()=>({accepted:'999',duplicate:'3',rejected:'2'})});
const checks=[];
async function record(name,expected,observed,compare){
  compare();
  await writeFile(resolve(evidence,'diagnostics-'+name+'.json'),JSON.stringify({source:'actual_database_queries_with_controlled_snapshot_clock',snapshotClock:frozenTime.toISOString(),expected,observed,equal:true},null,2));
  checks.push({name,status:'passed',evidence:'diagnostics-'+name+'.json'});
}
let projectId;
async function raw(event,processedAt=null){
  await database.pool.query('INSERT INTO telemetry_events(project_id,event_id,occurred_at,type,name,environment,app_version,session_id,view_id,route_name,event,processed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[projectId,event.eventId,new Date(event.occurredAt),event.type,event.name,event.app.environment,event.app.version,event.context.sessionId,event.context.viewId,event.context.routeName,event,processedAt]);
}
async function task(event,status='pending',availableAt=frozenTime,lockedAt=null,completedAt=null,error=null,lastFailedAt=null){
  return(await database.pool.query('INSERT INTO outbox_tasks(project_id,event_id,occurred_at,event,status,available_at,locked_at,completed_at,last_error,last_failed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',[projectId,event.eventId,new Date(event.occurredAt),event,status,availableAt,lockedAt,completedAt,error,lastFailedAt])).rows[0].id;
}
const fixture=(id,offset=0)=>createPerformanceEventFixture({eventId:id,occurredAt:frozenTime.getTime()+offset,app:{name:'diagnostic-fixture',version:'1.0.0',environment:'cli-acceptance'}});
try{
  projectId=(await projects.create(userId,'CLI诊断边界-'+randomUUID(),'diagnostic-fixture')).id;
  const empty=await service.data(userId,projectId);
  await record('zero-summary',{count:0,latest:null},empty,()=>{assert.equal(empty.retainedRawEventCount,0);assert.equal(empty.latestReceivedAt,null);});
  const older=fixture('older',-4*86400000);await raw(older);await task(older);
  const olderResult=await service.event(userId,projectId,'older');
  await record('older-than-24h',{eventId:'older',raw:'present'},olderResult,()=>assert.equal(olderResult.raw.recordState,'present'));
  const collisionA=fixture('collision',-3600000),collisionB=fixture('collision',-1800000);
  await raw(collisionA);await raw(collisionB);
  let ambiguity;try{await service.event(userId,projectId,'collision');}catch(error){ambiguity=error.getResponse();}
  const resolved=await service.event(userId,projectId,'collision',new Date(collisionA.occurredAt).toISOString());
  await record('ambiguity',{code:'AMBIGUOUS_EVENT',candidateCount:2,selected:new Date(collisionA.occurredAt).toISOString()},{ambiguity,resolved},()=>{assert.equal(ambiguity.code,'AMBIGUOUS_EVENT');assert.equal(ambiguity.candidates.length,2);assert.equal(resolved.event.occurredAt,new Date(collisionA.occurredAt).toISOString());});
  const newer=fixture('revision-new',-60000);newer.payload.sequence=2;newer.payload.sampleId='shared-entity';await raw(newer);await processor.process(projectId,newer);await task(newer,'completed',frozenTime,null,new Date(frozenTime.getTime()-30000));
  const noop=fixture('revision-old',-61000);noop.payload.sequence=1;noop.payload.sampleId='shared-entity';await raw(noop);await processor.process(projectId,noop);await task(noop,'completed',frozenTime,null,new Date(frozenTime.getTime()-30000));
  const noopResult=await service.event(userId,projectId,noop.eventId);
  const entity=(await database.pool.query('SELECT sample_id,sequence FROM performance_samples WHERE project_id=$1 AND sample_id=$2',[projectId,'shared-entity'])).rows;
  await record('noop-revision',{processing:'committed',entityCount:1,sequence:2,eventEffect:'unknown'},{diagnostic:noopResult,entity},()=>{assert.equal(noopResult.processing.state,'committed');assert.equal(entity.length,1);assert.equal(entity[0].sequence,2);assert.equal(noopResult.projection.eventEffect,'unknown');});
  const pending=fixture('committed-pending'),failed=fixture('committed-failed',-1);
  await raw(pending,frozenTime);await raw(failed,frozenTime);await task(pending,'pending',new Date(frozenTime.getTime()+10000),null,null,'post-commit retry',frozenTime);await task(failed,'failed',frozenTime,null,null,'terminal failure',frozenTime);
  const pendingResult=await service.event(userId,projectId,pending.eventId),failedResult=await service.event(userId,projectId,failed.eventId);
  await record('separate-stages',{processing:'committed',pending:'pending',failed:'failed'},{pending:pendingResult,failed:failedResult},()=>{assert.equal(pendingResult.processing.state,'committed');assert.equal(pendingResult.task.status,'pending');assert.equal(failedResult.processing.state,'committed');assert.equal(failedResult.task.status,'failed');});
  const missingTask=fixture('task-missing',-2);await raw(missingTask,frozenTime);
  const missingRaw=fixture('raw-missing',-3);await task(missingRaw);
  const history={taskMissing:await service.event(userId,projectId,missingTask.eventId),rawMissing:await service.event(userId,projectId,missingRaw.eventId),allMissing:await service.event(userId,projectId,'all-missing')};
  await record('history-missing',{task:'missing',raw:'missing',processing:'unknown',noIdentityProjection:'unknown'},history,()=>{assert.equal(history.taskMissing.task.recordState,'missing');assert.equal(history.rawMissing.raw.recordState,'missing');assert.equal(history.rawMissing.task.recordState,'present');assert.equal(history.rawMissing.processing.state,'unknown');assert.equal(history.allMissing.projection.visibility,'unknown');});
  const boundaryFrom=fixture('boundary-from',-10000),boundaryTo=fixture('boundary-to',10000);await raw(boundaryFrom);await raw(boundaryTo);
  const page=await service.events(userId,projectId,{from:new Date(boundaryFrom.occurredAt).toISOString(),to:new Date(boundaryTo.occurredAt).toISOString(),limit:100});
  await record('time-boundary',{containsFrom:true,containsTo:false},page,()=>{assert(page.items.some((r)=>r.eventId==='boundary-from'));assert(!page.items.some((r)=>r.eventId==='boundary-to'));});
  const summary=await service.data(userId,projectId);
  const reference=(await database.pool.query('SELECT count(*)::text AS count,max(received_at) AS latest FROM telemetry_events WHERE project_id=$1',[projectId])).rows[0];
  await record('summary-scope',{count:Number(reference.count),latest:reference.latest.toISOString(),differsFromRedis:999},summary,()=>{assert.equal(summary.retainedRawEventCount,Number(reference.count));assert.equal(summary.latestReceivedAt,reference.latest.toISOString());assert.notEqual(summary.retainedRawEventCount,999);});
  for(const [name,status,available,locked]of[
    ['ready-boundary','pending',0,null],['delayed-boundary','pending',1,null],['infinite-plan','pending','infinity',null],
    ['active-boundary','processing',0,-300000],['stale-boundary','processing',0,-300001],['missing-lock','processing',0,null],
  ])await task(fixture(name,-20),status,available==='infinity'?'infinity':new Date(frozenTime.getTime()+available),locked===null?null:new Date(frozenTime.getTime()+locked));
  const queue=await service.queue(userId,projectId);
  const expected={pendingTotal:6,readyPending:3,delayedPending:2,pendingUnclassified:1,processingTotal:3,processingActive:1,processingStale:1,processingUnclassified:1,processedLastMinute:2};
  await record('queue-boundaries',expected,queue,()=>{for(const[key,value]of Object.entries(expected))assert.equal(queue[key],value,key);assert.equal(queue.lockTimeoutSeconds,300);assert.equal(queue.ingestion.asOf,null);});
  // Historical last_error does not fabricate a failure timestamp.
  await database.pool.query('UPDATE outbox_tasks SET last_error=$2,last_failed_at=NULL WHERE project_id=$1 AND event_id=$3',[projectId,'historical failure','older']);
  const historical=await service.queue(userId,projectId);
  await record('historical-error-time',{failedAt:null},historical.recentFailures.find((r)=>r.eventId==='older'),()=>assert.equal(historical.recentFailures.find((r)=>r.eventId==='older').failedAt,null));
  await writeFile(resolve(evidence,'diagnostics-checks.json'),JSON.stringify({projectId,frozenTime:frozenTime.toISOString(),clockSource:'controlled_driver_override_of_transaction_timestamp_for_boundary_test',checks,result:'passed'},null,2));
  process.stdout.write(JSON.stringify({ok:true,checks:checks.length,evidence})+'\n');
}catch(error){await writeFile(resolve(evidence,'diagnostics-failure.json'),JSON.stringify({message:error.stack,checks},null,2));process.stderr.write(error.stack+'\n');process.exitCode=1;}
finally{await database.close();}
