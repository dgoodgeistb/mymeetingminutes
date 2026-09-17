import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.js';
async function app(t,options={}) {
  const server=createApp(options);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));return `http://127.0.0.1:${server.address().port}`;
}
const env={OPENAI_API_KEY:'test-server-only-key'};
const form=()=>{const f=new FormData();f.append('file',new Blob(['RIFF'],{type:'audio/wav'}),'meeting.wav');f.append('language','ko');f.append('prompt','제품 이름');return f;};
test('static whitelist hides secrets and repository files; health never exposes key',async t=>{
 const base=await app(t,{env});
 for(const path of ['/.env','/server.js','/.git/config','/package.json'])assert.equal((await fetch(base+path)).status,404);
 assert.match(await(await fetch(base+'/')).text(),/마이크 준비/);
 assert.deepEqual(await(await fetch(base+'/api/health')).json(),{configured:true});
});
test('multipart audio, language and context are forwarded using server key',async t=>{
 let called=0;
 const base=await app(t,{env,fetchImpl:async(url,opts)=>{
  called++;assert.match(url,/audio\/transcriptions$/);assert.equal(opts.headers.Authorization,'Bearer test-server-only-key');
  assert.equal(opts.body.get('language'),'ko');assert.equal(opts.body.get('prompt'),'제품 이름');assert.equal(opts.body.get('model'),'gpt-4o-transcribe');
  assert.equal(opts.body.get('file').name,'meeting.wav');return Response.json({text:'회의 시작'});
 }});
 const res=await fetch(base+'/api/transcribe',{method:'POST',body:form()});assert.equal(res.status,200);assert.deepEqual(await res.json(),{text:'회의 시작'});assert.equal(called,1);
});
test('AI uses Responses API and rejects incomplete results rather than replacing text',async t=>{
 let incomplete=false;
 const base=await app(t,{env,fetchImpl:async(url,opts)=>{
  assert.match(url,/\/responses$/);const input=JSON.parse(opts.body);assert.equal(input.store,false);assert.equal(input.input,'회의 내용');
  return Response.json({status:incomplete?'incomplete':'completed',output:[{content:[{type:'output_text',text:'요약'}]}]});
 }});
 const request=()=>fetch(base+'/api/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'summarize',text:'회의 내용'})});
 assert.deepEqual(await(await request()).json(),{text:'요약'});incomplete=true;assert.equal((await request()).status,502);
});
test('validates requests before calling provider and rejects cross-origin spending',async t=>{
 const base=await app(t,{env,fetchImpl:()=>assert.fail('provider should not be called')});
 for(const value of [null,{}, {action:'unknown',text:'x'},{action:'summarize',text:''}])assert.equal((await fetch(base+'/api/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})).status,400);
 assert.equal((await fetch(base+'/api/ai',{method:'POST',headers:{Origin:'https://attacker.example'}})).status,403);
 const f=form();f.set('language','bad');assert.equal((await fetch(base+'/api/transcribe',{method:'POST',body:f})).status,400);
 const missing=new FormData();missing.set('language','ko');assert.equal((await fetch(base+'/api/transcribe',{method:'POST',body:missing})).status,400);
 const tooLarge=form();tooLarge.set('file',new Blob([new Uint8Array(24*1024*1024+1)]),'big.wav');assert.equal((await fetch(base+'/api/transcribe',{method:'POST',body:tooLarge})).status,413);
});
test('missing API key and authentication are explicit',async t=>{
 const base=await app(t,{env:{APP_PASSWORD:'private'}});
 assert.equal((await fetch(base+'/')).status,401);
 assert.equal((await fetch(base+'/api/ai',{method:'POST',headers:{Authorization:'Basic '+Buffer.from('meeting:private').toString('base64')}})).status,503);
});
test('provider errors do not leak key or upstream details',async t=>{
 const base=await app(t,{env,fetchImpl:async()=>Response.json({error:'secret response'},{status:401})});
 const res=await fetch(base+'/api/transcribe',{method:'POST',body:form()});assert.equal(res.status,502);assert.doesNotMatch(await res.text(),/test-server-only-key|secret response/);
});
