const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
import {createApp} from '../server.js';
import assert from 'node:assert/strict';
const server=createApp({env:{},fetchImpl:()=>assert.fail('no server proxy')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try {
 browser=await chromium.launch({...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:process.env.CI?{}:{channel:'chrome'}),headless:true});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let mode='service',calls=0,resolveRequest,latestRequest;
 await page.route('https://api.openai.com/v1/audio/transcriptions',async route=>{
  calls++;latestRequest=route.request().postDataBuffer().toString();
  if(mode==='service')return route.fulfill({status:503,json:{error:{message:'service unavailable'}}});
  if(mode==='hold') {await new Promise(r=>resolveRequest=r);return route.fulfill({json:{text:'첫 구간'}}).catch(()=>{});}
  if(mode==='rate')return route.fulfill({status:429,headers:{'Retry-After':'2','Access-Control-Expose-Headers':'Retry-After'},json:{error:{code:'rate_limit_exceeded'}}});
  if(mode==='quota')return route.fulfill({status:429,json:{error:{code:'insufficient_quota',message:'private sk-test-key'}}});
  if(mode==='auth')return route.fulfill({status:401,json:{error:{message:'private sk-test-key'}}});
  return route.fulfill({json:{text:'다음 구간'}});
 });
 page.on('dialog',d=>d.accept());
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(()=>openSettings());await page.fill('#apiKey','sk-test-key');await page.click('#applyKeyBtn');await page.evaluate(()=>closeSettings());
 await page.setInputFiles('#fileInput',{name:'test.wav',mimeType:'audio/wav',buffer:Buffer.from('RIFF-test-audio')});
 await page.click('#transcribeFileBtn');await page.waitForFunction(()=>queueFailed&&!queueRunning);
 assert.equal(calls,1);assert.equal(await page.evaluate(()=>queue.length),1);
 const firstBody=latestRequest;
 mode='hold';await page.click('#retryBtn');await page.waitForFunction(()=>queueRunning);
 assert.equal(await page.locator('#retryBtn').isDisabled(),true);
 assert.match(await page.locator('#transcribeStatus').innerText(),/요청 중 · 시도 2/);
 // A duplicate callback while a request is active must not send or clear failure state.
 await page.evaluate(()=>retryTranscription());assert.equal(calls,2);
 assert.ok(firstBody.includes('RIFF-test-audio')&&latestRequest.includes('RIFF-test-audio'));
 resolveRequest();await page.waitForFunction(()=>!sessionBusy());
 assert.equal(await page.evaluate(()=>fullTx()),'첫 구간');
 // Queue multiple ordered jobs and preserve the successful transcript when throttled.
 mode='rate';await page.evaluate(()=>{
  queue.push({blob:new Blob(['second']),language:'ko',terms:''},{blob:new Blob(['third']),language:'ko',terms:''});void processQueue();
 });await page.waitForFunction(()=>queueFailed&&!queueRunning);
 assert.equal(await page.locator('#retryBtn').isDisabled(),true);
 const throttledCalls=calls;await page.evaluate(()=>retryTranscription());assert.equal(calls,throttledCalls);
 assert.equal(await page.evaluate(()=>queue.length),2);assert.equal(await page.evaluate(()=>fullTx()),'첫 구간');
 mode='ok';await page.waitForFunction(()=>!document.getElementById('retryBtn').disabled);
 await page.click('#retryBtn');await page.waitForFunction(()=>!sessionBusy());
 assert.equal(calls,throttledCalls+2);assert.equal(await page.evaluate(()=>fullTx()),'첫 구간\n다음 구간\n다음 구간');
 // Quota errors require account action; do not generate automatic paid retries.
 mode='quota';await page.evaluate(()=>{queue.push({blob:new Blob(['quota']),language:'ko',terms:''});void processQueue();});
 await page.waitForFunction(()=>queueFailed&&!queueRunning);
 assert.match(await page.locator('#retryBtn').innerText(),/결제·한도 확인/);
 assert.equal(await page.locator('#quotaHelp').isVisible(),true);
 assert.match(await page.locator('#errorMsg').innerText(),/재시도만 해서는/);
 assert.doesNotMatch(await page.locator('#errorMsg').innerText(),/sk-test/);
 const quotaCalls=calls;await page.waitForTimeout(500);assert.equal(calls,quotaCalls);
 await page.click('#retryBtn');await page.waitForFunction(()=>queueFailed&&!queueRunning);
 assert.equal(calls,quotaCalls+1);assert.equal(await page.evaluate(()=>queue.length),1);
 // Simulate account resolution, then retry the retained job once.
 mode='ok';await page.click('#retryBtn');await page.waitForFunction(()=>!sessionBusy());
 assert.equal(await page.evaluate(()=>queue.length),0);assert.equal(await page.locator('#quotaHelp').isVisible(),false);
 // Missing key routes to settings without issuing an API request.
 await page.evaluate(()=>{clearApiKey(false);queue.push({blob:new Blob(['keyless']),language:'ko',terms:''});void processQueue();});
 await page.waitForFunction(()=>queueFailed&&!queueRunning);const keylessCalls=calls;
 await page.click('#retryBtn');assert.equal(await page.locator('#settingsView').isVisible(),true);assert.equal(calls,keylessCalls);
 await page.fill('#apiKey','sk-test-key');await page.click('#applyKeyBtn');await page.evaluate(()=>closeSettings());
 await page.click('#retryBtn');await page.waitForFunction(()=>!sessionBusy());
 assert.equal(calls,keylessCalls+1);
 // Reset during an in-flight retry must not resurrect cleared audio/text.
 mode='hold';await page.evaluate(()=>{queue.push({blob:new Blob(['cancel']),language:'ko',terms:''});void processQueue();});
 await page.waitForFunction(()=>queueRunning);await page.waitForTimeout(100);
 await page.evaluate(()=>clearAll());resolveRequest();await page.waitForFunction(()=>!queueRunning);
 assert.equal(await page.evaluate(()=>fullTx()),'');assert.equal(await page.evaluate(()=>queue.length),0);
 assert.deepEqual(errors,[]);
 console.log('Retry smoke passed: visible progress, duplicate click guard, preserved audio/order, cooldown, quota/account recovery, missing key, cancellation.');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
