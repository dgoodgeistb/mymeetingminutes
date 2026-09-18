const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { createApp } from '../server.js';
import assert from 'node:assert/strict';
let failNext=false, transcriptions=0;
const server=createApp({env:{},fetchImpl:()=>assert.fail('the app must not use the server proxy')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try {
 browser=await chromium.launch({...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {channel:'chrome'}),headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
 const context=await browser.newContext({viewport:{width:900,height:1000}});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('dialog',d=>d.accept());
 await page.route('https://api.openai.com/v1/**',async route=>{
  assert.equal(route.request().headers().authorization,'Bearer sk-test-user-key');
  if(route.request().url().endsWith('/audio/transcriptions')) {
   if(failNext){failNext=false;return route.fulfill({status:429,headers:{'Retry-After':'1','Access-Control-Expose-Headers':'Retry-After'},json:{error:{code:'rate_limit_exceeded'}}});}
   transcriptions++;assert.ok(route.request().postDataBuffer().length>44);
   return route.fulfill({json:{text:`회의 구간 ${transcriptions}`}});
  }
  return route.fulfill({json:{status:'completed',output:[{content:[{type:'output_text',text:'결정 사항: 다음 회의 준비'}]}]}});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(()=>localStorage.setItem('mmm_anthropic_api_key','old-test-key'));
 await page.reload();assert.equal(await page.evaluate(()=>localStorage.getItem('mmm_anthropic_api_key')),null);
 await page.evaluate(()=>openSettings());await page.fill('#apiKey','sk-test-user-key');await page.click('#applyKeyBtn');await page.evaluate(()=>closeSettings());
 await page.click('#prepareBtn');await page.waitForFunction(()=>!preparing && document.getElementById('micStatus').textContent.includes('준비됨'));
 const start=Date.now();await page.click('#recordBtn');await page.waitForFunction(()=>recording);console.log('Prepared fake-device start (ms):',Date.now()-start);
 await page.waitForTimeout(1100);await page.click('#recordBtn');await page.waitForFunction(()=>!sessionBusy());
 assert.match(await page.locator('#transcriptBox').innerText(),/회의 구간 1/);
 assert.equal(await page.evaluate(()=>audioBlob.type),'audio/wav');assert.ok(await page.evaluate(()=>audioBlob.size)>44);
 assert.equal(await page.evaluate(()=>capture.stream),null);
 await page.click('#summarizeBtn');await page.waitForFunction(()=>!aiBusy);assert.match(await page.locator('#summaryBox').innerText(),/결정 사항/);
 await page.click('#refineBtn');await page.waitForFunction(()=>!aiBusy);assert.match(await page.locator('#transcriptBox').innerText(),/결정 사항/);
 await page.click('#archiveBtn');await page.waitForFunction(async()=> (await idbGetAll()).length===1);
 failNext=true;
 await page.click('#recordBtn');await page.waitForFunction(()=>recording);await page.waitForTimeout(600);await page.click('#recordBtn');await page.waitForFunction(()=>queueFailed&&!stopping);
 assert.equal(await page.locator('#saveAudioBtn').isEnabled(),true);assert.equal(await page.evaluate(()=>queue.length),1);
 await page.click('#retryBtn');await page.waitForFunction(()=>!sessionBusy());assert.match(await page.locator('#transcriptBox').innerText(),/회의 구간 2/);
 // Exercise cancellation: a late server result must never repopulate a cleared session.
 let release;const waiting=new Promise(r=>release=r);
 await page.route('https://api.openai.com/v1/audio/transcriptions',async route=>{await waiting;await route.fulfill({json:{text:'stale'}}).catch(()=>{});});
 await page.click('#recordBtn');await page.waitForFunction(()=>recording);await page.waitForTimeout(500);await page.click('#recordBtn');await page.waitForFunction(()=>queueRunning&&!stopping);
 await page.evaluate(()=>clearAll());release();await page.waitForFunction(()=>!queueRunning);
 assert.equal(await page.evaluate(()=>fullTx()),'');assert.equal(await page.evaluate(()=>audioBlob),null);
 await page.unroute('https://api.openai.com/v1/audio/transcriptions');
 // An actual 30-second worklet interval must upload before stopping, then flush its tail.
 await page.click('#recordBtn');await page.waitForFunction(()=>recording);
 await page.waitForFunction(()=>fullTx().includes('회의 구간 3'),{},{timeout:45000});
 assert.equal(await page.evaluate(()=>recording),true);
 await page.waitForTimeout(500);await page.click('#recordBtn');await page.waitForFunction(()=>!sessionBusy());
 assert.match(await page.locator('#transcriptBox').innerText(),/회의 구간 4/);
 const wav=Buffer.from(await page.evaluate(async()=>Array.from(new Uint8Array(await audioBlob.arrayBuffer()))));
 await page.setInputFiles('#fileInput',{name:'uploaded.wav',mimeType:'audio/wav',buffer:wav});
 assert.equal(await page.evaluate(()=>fullTx()),'');
 await page.click('#transcribeFileBtn');await page.waitForFunction(()=>!sessionBusy());
 assert.match(await page.locator('#transcriptBox').innerText(),/회의 구간 5/);
 // Microphone denial must not enter a recording state.
 await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('denied','NotAllowedError');};});
 await page.click('#recordBtn');await page.waitForFunction(()=>!starting);
 assert.equal(await page.evaluate(()=>recording),false);assert.match(await page.locator('#errorMsg').innerText(),/권한/);
 await page.setViewportSize({width:390,height:844});if(process.env.SCREENSHOT_PATH) await page.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 assert.deepEqual(errors,[]);console.log('Browser smoke passed: preparation, capture, final tail, direct transcription, summary, archive, retry, cancellation, continuous 30s chunk, uploaded WAV, denial, mobile width.');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
