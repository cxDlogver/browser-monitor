import { assert, resolve, pid, pid2, send, diag, queue } from './acceptance-kit.mjs';
export function dataCases(register,env){
  register('AC-06-01',async c=>{
    const normal=await c.target('default',['events','list']);c.check('default 50',normal.body.data.items.length,50);c.check('default 24h',Date.parse(normal.body.data.range.to)-Date.parse(normal.body.data.range.from),86400000);c.check('limit sent',c.f.trace.at(-1).query.limit,'50');
    c.check('max 100',(await c.target('max',['events','list','--limit','100'])).body.data.items.length,100);await env.diagnosticEvidence(c,'time-boundary');
    const from=c.f.state.rows.at(-1).occurredAt,to=c.f.state.rows[0].occurredAt;const boundary=await c.target('boundary',['events','list','--from',from,'--to',to,'--limit','100']);c.check('to excluded',boundary.body.data.items.some(r=>r.occurredAt===to),false);assert(boundary.body.data.items.every(r=>r.occurredAt>=from&&r.occurredAt<to));
    c.f.state.rows=[{...c.f.state.rows[0],eventId:'from',occurredAt:from,receivedAt:'2030-01-01T00:00:00.000Z'},{...c.f.state.rows[1],eventId:'to',occurredAt:to}];c.check('receivedAt does not change range',(await c.target('from-only',['events','list','--from',from,'--to',to])).body.data.items.map(r=>r.eventId),['from']);
  });
  register('AC-06-02',async c=>{
    const sample=c.f.state.rows[10];for(const[key,flag]of[['type','type'],['name','name'],['eventId','event-id'],['environment','environment'],['version','version'],['routeName','route-name'],['sessionId','session-id'],['viewId','view-id']]){
      const result=await c.target('filter-'+flag,['events','list','--'+flag,sample[key],'--limit','100']);assert(result.body.data.items.length>0);assert(result.body.data.items.every(row=>row[key]===sample[key]));c.check('filter '+flag+' applied',c.f.trace.at(-1).query[key],sample[key]);}
    const combo=['events','list','--include-payload',...Object.entries({type:sample.type,name:sample.name,'event-id':sample.eventId,environment:sample.environment,version:sample.version,'route-name':sample.routeName,'session-id':sample.sessionId,'view-id':sample.viewId}).flatMap(([k,v])=>['--'+k,v])];
    const all=await c.target('combined',combo);c.check('combined exact identity',all.body.data.items.map(r=>r.eventId),[sample.eventId]);await c.json('reference/filter-fixture.json',sample);await env.reuseBusiness(c,['list','comparison','candidates']);
  });
  register('AC-06-03',async c=>{
    const baseline=[...c.f.state.rows].sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||b.eventId.localeCompare(a.eventId));await c.json('reference/static-dataset.json',baseline);let cursor,seen=[];
    for(let page=1;page<=4;page++){const r=await c.target('page-'+page,['events','list',...(cursor?['--cursor',cursor]:[])]);seen.push(...r.body.data.items.map(x=>x.eventId));cursor=r.body.data.nextCursor;if(page<4)c.check('page '+page+' has more',r.body.data.hasMore,true);else c.check('last page',r.body.data.hasMore,false);}
    c.check('151 complete ordered identities',seen,baseline.map(x=>x.eventId));c.check('151 distinct',new Set(seen).size,151);const windows=c.f.trace.map(x=>[x.query.from,x.query.to]);c.check('fixed range pages',windows.every(v=>JSON.stringify(v)===JSON.stringify(windows[0])),true);
    const first=await c.target('changing-page-1',['events','list']);c.f.state.rows.push({...baseline[0],eventId:'late',occurredAt:baseline[60].occurredAt});c.f.state.rows=c.f.state.rows.filter(row=>row.eventId!==baseline[65].eventId);
    const changed=await c.target('changing-page-2',['events','list','--cursor',first.body.data.nextCursor]);c.check('range stays fixed after changes',changed.body.data.range,first.body.data.range);assert(changed.body.data.limitations.some(s=>s.includes('No cross-page')));c.check('changes do not claim snapshot',true,true);
    for(let page=1;page<=4;page++)await c.reuse('real-database-page-'+page,resolve(env.evidence,'events-page-'+page+'.json'));
  });
  register('AC-06-04',async c=>{
    const first=await c.target('first',['events','list']);const cursor=first.body.data.nextCursor;const before=c.f.trace.length;
    for(const[name,args]of[['malformed',['--cursor','invalid']],['filter',['--cursor',cursor,'--name','changed']],['project',['--cursor',cursor]],['time-format',['--from','2026-10-13T00:00:00']],['reversed',['--from','2026-10-13T00:00:00Z','--to','2026-10-12T00:00:00Z']],['span',['--from','2025-01-01T00:00:00Z','--to','2026-10-13T00:00:00Z']],['limit',['--limit','101']],['zero',['--limit','0']],['invalid-calendar',['--from','2026-02-30T00:00:00Z']]])await c.target('invalid-'+name,['events','list',...args],2,{projectId:name==='project'?pid2:pid});
    c.check('invalid input no resource request',c.f.trace.length,before);await c.json('checks/limits.json',{maxQueryDays:180,maxPageSize:100,invalidLimit:101,cursorVersion:1});
  });
  register('AC-06-05',async c=>{
    const sample=c.f.state.rows[0];const base=['events','list','--event-id',sample.eventId];c.check('summary has no payload',(await c.target('summary',base)).body.data.items[0].event,undefined);c.check('payload opt-in',(await c.target('payload',[...base,'--include-payload'])).body.data.items[0].event,sample.event);
    c.check('empty is success',(await c.target('empty',['events','list','--name','absent'])).body.data.items,[]);for(const[name,status]of[['denied',403],['server-fault',503]]){c.f.state.handler=(_,res)=>{send(res,{},status);return true;};const fault=await c.target(name,['events','list'],status===403?4:5);c.check(name+' no fake data',fault.body.data,null);}
    await env.reuseBusiness(c,['list']);await c.reuse('member-can-read',resolve(env.evidence,'member-read.json'));await c.reuse('member-write-denied',resolve(env.evidence,'member-write-denied.json'));
  });
  register('AC-07-01',async c=>{
    await env.diagnosticEvidence(c,'summary-scope');await c.reuse('actual-summary-reference',resolve(env.evidence,'database-reference-summary.json'));
    c.f.state.rows.push({...c.f.state.rows[0],eventId:'older-retained',occurredAt:'2026-10-01T00:00:00.000Z'});const summary=await c.target('summary',['data','summary']);c.check('all retained including old',summary.body.data.retainedRawEventCount,152);c.check('latest received',summary.body.data.latestReceivedAt,c.f.state.rows.map(x=>x.receivedAt).sort().at(-1));
    await c.target('filtered-list',['events','list','--name','absent']);c.check('summary ignores list filter',(await c.target('summary-after',['data','summary'])).body.data.retainedRawEventCount,152);assert(summary.body.meta.asOf);c.check('source database',summary.body.meta.source,'database');
  });
  register('AC-07-02',async c=>{
    await env.diagnosticEvidence(c,'zero-summary');const firstRow=c.f.state.rows[0];c.f.state.rows=[];const zero=await c.target('zero',['data','summary']);c.check('valid zero/null',[zero.body.data.retainedRawEventCount,zero.body.data.latestReceivedAt],[0,null]);
    c.f.state.rows=[firstRow];const refreshed=await c.target('refreshed',['data','summary']);c.check('new count',refreshed.body.data.retainedRawEventCount,1);assert(refreshed.body.data.asOf>zero.body.data.asOf);c.check('fresh asOf',true,true);
    c.check('unknown retention not guessed',refreshed.body.data.retentionPolicy.rawEvents,{state:'unknown',dropAfter:null});c.f.state.handler=(_,res)=>{send(res,{},503);return true;};c.check('fault no old count',(await c.target('failed',['data','summary'],5)).body.data,null);
  });
  register('AC-08-01',async c=>{
    const evidence=await env.diagnosticEvidence(c,'ambiguity');await env.diagnosticEvidence(c,'older-than-24h');const projectId=evidence.observed.resolved.projectId;
    const ambiguous=await env.realRun(c,'ambiguous',['events','diagnose','--event-id','collision','--project',projectId],2);c.check('actual candidates',ambiguous.body.error.details.candidates.length,2);
    const exact=await env.realRun(c,'exact',['events','diagnose','--event-id','collision','--occurred-at',evidence.expected.selected,'--project',projectId]);c.check('actual exact identity',exact.body.data.event.occurredAt,evidence.expected.selected);await env.realRun(c,'old',['events','diagnose','--event-id','older','--project',projectId]);
  });
  register('AC-08-02',async c=>{
    const evidence=await env.diagnosticEvidence(c,'separate-stages');for(const status of ['pending','failed']){const value=await env.realRun(c,status,['events','diagnose','--event-id','committed-'+status,'--project',evidence.observed[status].projectId]);c.check(status+' processing/task remain independent',[value.body.data.processing.state,value.body.data.task.status],['committed',status]);assert(value.body.data.task.lastError);}
  });
  register('AC-08-03',async c=>{
    const e=await env.diagnosticEvidence(c,'noop-revision');const d=await env.realRun(c,'noop',['events','diagnose','--event-id','revision-old','--project',e.observed.diagnostic.projectId]);c.check('actual committed no-op',d.body.data.processing.state,'committed');c.check('event effect remains unknown',d.body.data.projection.eventEffect,'unknown');c.check('one entity higher revision',e.observed.entity,[{sample_id:'shared-entity',sequence:2}]);
  });
  register('AC-08-04',async c=>{
    const e=await env.diagnosticEvidence(c,'history-missing');for(const[name,id]of[['taskMissing','task-missing'],['rawMissing','raw-missing'],['allMissing','all-missing']]){const d=await env.realRun(c,name,['events','diagnose','--event-id',id,'--project',e.observed[name].projectId]);c.check(name+' retained facts',[d.body.data.raw.recordState,d.body.data.task.recordState,d.body.data.processing.state],[e.observed[name].raw.recordState,e.observed[name].task.recordState,e.observed[name].processing.state]);if(name==='allMissing')c.check('unknown projection',d.body.data.projection.visibility,'unknown');}
  });
  register('AC-09-01',async c=>{
    await env.diagnosticEvidence(c,'queue-boundaries');const r=await c.target('queue',['queue','status']);c.check('pending sum',r.body.data.readyPending+r.body.data.delayedPending+r.body.data.pendingUnclassified,r.body.data.pendingTotal);c.check('processing sum',r.body.data.processingActive+r.body.data.processingStale+r.body.data.processingUnclassified,r.body.data.processingTotal);c.check('policy seconds',r.body.data.lockTimeoutSeconds,300);assert(r.body.data.limitations.some(s=>s.includes('live worker')));
  });
  register('AC-09-02',async c=>{
    const real=await c.reuse('queue-database-reference',resolve(env.evidence,'queue-reference.json'));c.check('actual failed21/dead1',[real.observed.failed,real.observed.deadLetters],[21,1]);c.check('actual bounded failures',[real.observed.recentFailures.length,real.observed.recentFailuresHasMore],[20,true]);
    await env.diagnosticEvidence(c,'historical-error-time');await env.diagnosticEvidence(c,'queue-boundaries');const r=await c.target('queue',['queue','status']);c.check('separate overlap counts',[r.body.data.failed,r.body.data.deadLetters,r.body.data.processedLastMinute],[21,1,2]);c.check('failure bounded',[r.body.data.recentFailures.length,r.body.data.recentFailuresLimit,r.body.data.recentFailuresHasMore],[20,20,true]);
  });
  register('AC-09-03',async c=>{
    const r=await c.target('queue',['queue','status']);c.check('Redis separate source/asOf',[r.body.data.ingestion.source,r.body.data.ingestion.asOf],['redis',null]);c.check('other task independent',r.body.data.otherTasks.labAudits.pending,2);await env.diagnosticEvidence(c,'queue-boundaries');await env.reuseBusiness(c,['queue']);
    c.f.state.handler=(_,res)=>{send(res,{},503);return true;};c.check('queue failure no zero',(await c.target('failed',['queue','status'],5)).body.data,null);
  });
  register('AC-10-01',async c=>{
    let n=0;c.f.state.handler=(_,res,url)=>{if(!url.pathname.includes('/diagnostics/events/'))return false;n++;send(res,diag(n===1?'notObserved':'committed',n===3?'completed':'pending'));return true;};
    const waited=await c.target('normal',['events','wait','--event-id','event','--interval','1','--timeout','5']);c.check('only final snapshot completes',waited.body.data.polls,3);c.check('same snapshot evidence',[waited.body.data.lastObservation.processing.state,waited.body.data.lastObservation.task.status],['committed','completed']);
    const e=await env.diagnosticEvidence(c,'noop-revision');const noop=await env.realRun(c,'actual-noop',['events','wait','--event-id','revision-old','--project',e.observed.diagnostic.projectId]);c.check('actual no-op completes',noop.body.data.reason,'completed');await env.reuseBusiness(c,['wait']);
  });
  register('AC-10-02',async c=>{
    for(const[name,status,code]of[['failed','failed','PROCESSING_FAILED'],['missing',null,'HISTORY_INCOMPLETE']]){c.f.state.handler=(_,res)=>{send(res,diag('committed',status));return true;};const r=await c.target(name,['events','wait','--event-id','event'],7);c.check(name+' correct terminal',r.body.error.code,code);c.check(name+' evidence retained',r.body.data.lastObservation.processing.state,'committed');}
    c.f.state.handler=(_,res)=>{send(res,{code:'AMBIGUOUS_EVENT',candidates:['2026-10-13T00:00:00Z','2026-10-12T00:00:00Z']},400);return true;};await c.target('ambiguous',['events','wait','--event-id','event'],2);const before=c.f.trace.length;for(const[name,arg]of[['timeout','--timeout'],['interval','--interval']])await c.target('invalid-'+name,['events','wait','--event-id','event',arg,'0'],2);c.check('invalid not polled',c.f.trace.length,before);c.check('wait only GET',c.f.trace.every(t=>t.method==='GET'),true);
  });
  register('AC-10-03',async c=>{
    const defaultWait=await c.target('default-budget',['events','wait','--event-id','event'],6);c.check('default60 bounds',defaultWait.elapsedMs>=60000&&defaultWait.elapsedMs<63000,true);c.check('default intervals2',c.f.trace.length>=29&&c.f.trace.length<=30,true);const gaps=c.f.trace.slice(1).map((t,i)=>t.monotonicMs-c.f.trace[i].monotonicMs);assert(gaps.every(ms=>ms>=1950&&ms<3000));await c.json('checks/default-wait-timeline.json',{steps:c.f.trace,elapsedMs:defaultWait.elapsedMs,gaps});
    c.f.trace.length=0;let n=0;c.f.state.handler=async(_,res)=>{n++;if(n===1){send(res,diag());return true;}await new Promise(done=>setTimeout(done,4500));send(res,diag());return true;};
    const short=await c.target('short-budget',['events','wait','--event-id','event','--timeout','5','--interval','2','--request-timeout','10'],6);c.check('remaining request budget',short.elapsedMs>=5000&&short.elapsedMs<7000,true);c.check('no requests after deadline',c.f.trace.length,2);c.check('last observation time unchanged',short.body.data.lastObservationAsOf,short.body.data.lastObservation.asOf);c.check('last request failure recorded',short.body.data.lastQueryFailure.code,'REQUEST_TIMEOUT');
  });
  register('AC-10-04',async c=>{
    let n=0;let asOf;c.f.state.handler=(_,res)=>{n++;if(n===1){const value=diag();asOf=value.asOf;send(res,value);}else send(res,{},403);return true;};const r=await c.target('failed-after-valid',['events','wait','--event-id','event','--interval','1'],4);c.check('read failure distinct',r.body.data.reason,'query_failed');c.check('keep original asOf',r.body.data.lastObservationAsOf,asOf);c.check('failed request no new fake snapshot',r.body.data.lastObservation.asOf,asOf);assert(r.endedAt>asOf);c.check('last failure explicit',r.body.data.lastQueryFailure.code,'PROJECT_UNAVAILABLE');
  });
}
