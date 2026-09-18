import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/openai-client.js',import.meta.url),'utf8');
function client(fetchImpl) {
 const context=vm.createContext({fetch:fetchImpl,Blob,FormData,AbortController,DOMException,setTimeout,clearTimeout});
 return vm.runInContext(source+'\nnew MeetingOpenAI()',context);
}
const audio={blob:new Blob(['RIFF'],{type:'audio/wav'}),language:'ko',prompt:'참석자 이름'};
test('requires user key and sends it only as a header to the fixed OpenAI endpoint',async()=>{
 let calls=0;
 const api=client(async(url,options)=>{
  calls++;assert.equal(url,'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(options.headers.Authorization,'Bearer sk-test-user-key');
  assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  assert.equal(options.body.get('model'),'gpt-4o-transcribe');assert.equal(options.body.get('language'),'ko');assert.equal(options.body.get('prompt'),'참석자 이름');
  assert.equal(options.body.get('file').name,'meeting.wav');return Response.json({text:'회의 내용'});
 });
 await assert.rejects(api.transcribe(audio),/키를 입력/);assert.equal(calls,0);
 api.setKey('sk-test-user-key');assert.equal(await api.transcribe(audio),'회의 내용');assert.equal(calls,1);
 api.clearKey();assert.equal(api.hasKey(),false);await assert.rejects(api.transcribe(audio),/키를 입력/);assert.equal(calls,1);
});
test('Responses call includes no-store and incomplete/refusal responses do not replace transcript',async()=>{
 let status='completed';let output=[{content:[{type:'output_text',text:'정리 결과'}]}];
 const api=client(async(url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');const data=JSON.parse(options.body);
  assert.equal(data.store,false);assert.equal(data.model,'gpt-4o-mini');assert.equal(data.input,'회의 내용');
  return Response.json({status,output});
 });
 api.setKey('sk-test-user-key');assert.equal(await api.ai('summarize','회의 내용'),'정리 결과');
 status='incomplete';await assert.rejects(api.ai('refine','회의 내용'),/완료되지/);
 status='completed';output=[{content:[{type:'refusal',refusal:'unavailable'}]}];await assert.rejects(api.ai('refine','회의 내용'),/텍스트가 없습니다/);
});
test('provider failures never reflect API key fragments and distinguish 401/429',async()=>{
 let status=401;const api=client(async()=>Response.json({error:{message:'key sk-test-user-key is invalid'}},{status}));
 api.setKey('sk-test-user-key');await assert.rejects(api.transcribe(audio),e=>e.message.includes('키가 올바르지')&&!e.message.includes('sk-test'));
 status=429;await assert.rejects(api.transcribe(audio),/사용량 또는 요청 한도/);
});
test('clearing key aborts in-flight requests and blocks late results even if fetch ignores abort',async()=>{
 let finish,requestSignal;const waiting=new Promise(r=>finish=r);
 const api=client(async(url,options)=>{requestSignal=options.signal;await waiting;return Response.json({text:'late result'});});
 api.setKey('sk-test-user-key');const pending=api.transcribe(audio);
 api.clearKey();assert.equal(requestSignal.aborted,true);finish();await assert.rejects(pending,e=>e.name==='AbortError');
});
test('session cancellation propagates without deleting the reusable key',async()=>{
 let finish,requestSignal;const waiting=new Promise(r=>finish=r);
 const api=client(async(url,options)=>{requestSignal=options.signal;await waiting;return Response.json({text:'late'});});
 api.setKey('sk-test-user-key');const controller=new AbortController();const pending=api.transcribe(audio,controller.signal);
 controller.abort();assert.equal(requestSignal.aborted,true);finish();await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(api.hasKey(),true);
});
test('a new page instance starts without a key and invalid input never sends a request',async()=>{
 const fetchImpl=()=>assert.fail('no network request expected');
 const first=client(fetchImpl);first.setKey('sk-test-user-key');const second=client(fetchImpl);assert.equal(second.hasKey(),false);
 assert.throws(()=>second.setKey('wrong key'),/API 키/);
 await assert.rejects(first.ai('summarize',''),/1~100,000/);
 await assert.rejects(first.transcribe({...audio,blob:new Blob([])}),/0바이트/);
});
test('quota exhaustion differs from temporary rate limits without exposing provider messages',async()=>{
 let code='insufficient_quota';
 const api=client(async()=>Response.json({error:{code,message:'private sk-test-user-key'}},{status:429,headers:{'Retry-After':'3'}}));
 api.setKey('sk-test-user-key');
 await assert.rejects(api.transcribe(audio),e=>e.code==='insufficient_quota'&&e.retryAfterMs===null&&/재시도만 해서는/.test(e.message)&&!e.message.includes('sk-test'));
 code='rate_limit_exceeded';await assert.rejects(api.transcribe(audio),e=>e.code==='rate_limit_exceeded'&&e.retryAfterMs===3000&&e.status===429);
});
test('rate-limit parsing tolerates hidden headers and malformed error bodies',async()=>{
 let response=new Response('not json',{status:429});
 const api=client(async()=>response);api.setKey('sk-test-user-key');
 await assert.rejects(api.transcribe(audio),e=>e.code==='unknown_429'&&e.retryAfterMs===null);
 response=Response.json({error:{type:'insufficient_quota'}},{status:429});
 await assert.rejects(api.transcribe(audio),e=>e.code==='insufficient_quota');
 response=Response.json({error:{code:'rate_limit_exceeded'}},{status:429,headers:{'Retry-After':new Date(Date.now()+60000).toUTCString()}});
 await assert.rejects(api.transcribe(audio),e=>e.retryAfterMs>50000&&e.retryAfterMs<=60000);
});
test('billing limits and slow-down codes are classified without guessing from raw messages',async()=>{
 let code='credit_balance_exhausted';
 const api=client(async()=>Response.json({error:{code}},{status:429}));api.setKey('sk-test-user-key');
 for(code of ['credit_balance_exhausted','organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded']) {
  await assert.rejects(api.transcribe(audio),e=>e.code==='insufficient_quota'&&e.retryAfterMs===null);
 }
 code='slow_down';await assert.rejects(api.transcribe(audio),e=>e.code==='rate_limit_exceeded');
});
