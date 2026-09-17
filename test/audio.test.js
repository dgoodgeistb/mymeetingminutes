import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const worklet=await readFile(new URL('../public/pcm-worklet.js',import.meta.url),'utf8');
const audio=await readFile(new URL('../public/audio.js',import.meta.url),'utf8');
test('continuous PCM is cut into independently playable 30s WAVs, with exact final tail and no sample gap',async()=>{
 const messages=[];let Processor;
 const sandbox={sampleRate:48000,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>messages.push(m)};}},registerProcessor:(name,p)=>Processor=p};
 vm.runInNewContext(worklet,sandbox);const p=new Processor();
 p.port.onmessage({data:'start'});
 const input=new Float32Array(128).fill(0.5);
 for(let i=0;i<11251;i++)p.process([[input]]);
 p.port.onmessage({data:'stop'});p.process([[input]]);
 const chunks=messages.filter(m=>m.type==='chunk');assert.equal(chunks.length,2);
 assert.equal(chunks[0].pcm.byteLength,48000*30*2);assert.equal(chunks[1].pcm.byteLength,128*2);
 assert.equal(new DataView(chunks[0].pcm).getInt16(0,true),16384);
 const context=vm.createContext({Blob});vm.runInContext(audio,context);
 for(const chunk of chunks){const blob=context.wavBlob([chunk.pcm],48000),bytes=new DataView(await blob.arrayBuffer());assert.equal(bytes.getUint32(40,true),chunk.pcm.byteLength);assert.equal(bytes.getUint32(24,true),48000);assert.equal(bytes.byteLength,44+chunk.pcm.byteLength);}
 const full=context.wavBlob(chunks.map(c=>new Blob([c.pcm])),48000);assert.equal(full.size,44+11251*128*2);
 assert.equal(messages.at(-1).type,'stopped');
});
test('stereo channels mix to mono and samples clamp without wrapping',()=>{
 const messages=[];let Processor;
 vm.runInNewContext(worklet,{sampleRate:48000,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>messages.push(m)};}},registerProcessor:(n,p)=>Processor=p});
 const p=new Processor();p.port.onmessage({data:'start'});p.process([[new Float32Array([2,-2,1]),new Float32Array([2,-2,-1])]]);p.port.onmessage({data:'stop'});
 const view=new DataView(messages.find(m=>m.type==='chunk').pcm);
 assert.deepEqual([0,2,4].map(i=>view.getInt16(i,true)),[32767,-32768,0]);
});
