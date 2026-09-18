const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
import {createApp} from '../server.js';
import assert from 'node:assert/strict';
const server=createApp({env:{},fetchImpl:()=>assert.fail('no server proxy')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try {
 browser=await chromium.launch({...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:process.env.CI?{}:{channel:'chrome'}),headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
 const page=await browser.newPage();let apiCalls=0;const errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.route('https://api.openai.com/v1/**',async route=>{apiCalls++;return route.fulfill({json:{text:`보관 구간 ${apiCalls}`}});});
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.click('#recordBtn');await page.waitForFunction(()=>recording);
 await page.waitForFunction(()=>audioChunks.length===1,{},{timeout:45000});
 assert.equal(await page.evaluate(()=>recording),true);
 assert.equal(await page.evaluate(()=>capture.context.state),'running');
 assert.match(await page.locator('#transcribeStatus').innerText(),/녹음 계속 중/);
 assert.equal(apiCalls,0);
 await page.waitForTimeout(1200);await page.click('#recordBtn');await page.waitForFunction(()=>!stopping);
 assert.equal(await page.evaluate(()=>queue.length),2);
 const samples=await page.evaluate(()=>sampleCount);assert.ok(samples>30*await page.evaluate(()=>sessionRate));
 assert.equal(await page.locator('#saveAudioBtn').isEnabled(),true);
 const downloadEvent=page.waitForEvent('download');await page.click('#saveAudioBtn');assert.match((await downloadEvent).suggestedFilename(),/\.wav$/);
 await page.click('#playBtn');await page.waitForFunction(()=>!document.getElementById('player').paused);await page.click('#playBtn');
 await page.click('#archiveBtn');await page.waitForFunction(async()=>!archiving&&(await idbGetAll()).length===1);
 assert.deepEqual(await page.evaluate(async()=>{const r=(await idbGetAll())[0];return {pending:r.pendingTranscriptions.length,audio:r.audio.size,tx:r.transcript};}),{pending:2,audio:44+samples*2,tx:''});
 // The pending queue no longer locks local controls after recording stops.
 await page.getByRole('button',{name:'English'}).click();assert.equal(await page.evaluate(()=>currentLang),'en-US');
 await page.reload();assert.equal(await page.evaluate(()=>openaiClient.hasKey()),false);
 await page.evaluate(()=>openHistory());await page.getByRole('button',{name:'📂 불러와서 전사 계속'}).click();
 assert.equal(await page.evaluate(()=>queue.length),2);assert.equal(await page.evaluate(()=>currentLang),'ko-KR');
 assert.equal(await page.locator('#saveAudioBtn').isEnabled(),true);
 await page.click('#retryBtn');assert.equal(await page.locator('#settingsView').isVisible(),true);assert.equal(apiCalls,0);
 await page.fill('#apiKey','sk-test-key');await page.click('#applyKeyBtn');await page.evaluate(()=>closeSettings());
 await page.click('#retryBtn');await page.waitForFunction(()=>!sessionBusy());
 assert.equal(apiCalls,2);assert.equal(await page.evaluate(()=>fullTx()),'보관 구간 1\n보관 구간 2');
 // Replacing an archived/pending session by a local text file remains available.
 await page.evaluate(()=>{clearApiKey(false);queue.push({blob:new Blob(['pending']),language:'ko',terms:''});void processQueue();});
 await page.waitForFunction(()=>queueFailed);
 await page.setInputFiles('#fileInput',{name:'meeting.txt',mimeType:'text/plain',buffer:Buffer.from('로컬 회의 메모')});
 await page.waitForFunction(()=>!importing&&fullTx()==='로컬 회의 메모');assert.equal(await page.evaluate(()=>queue.length),0);
 assert.deepEqual(errors,[]);
 console.log('Keyless smoke passed: capture beyond 30s, WAV download/playback, archive pending chunks, reload/resume, language and local import controls.');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
