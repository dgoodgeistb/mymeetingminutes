// Serve only repository files beneath a project prefix, as GitHub Pages does.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const assets=new Map([
  ['public/openai-client.js','text/javascript'],
  ['index.html','text/html'],['public/app.js','text/javascript'],
  ['public/audio.js','text/javascript'],['public/pcm-worklet.js','text/javascript']
]);
const prefix='/mymeetingminutes/';
const servedPaths=[];
const server=http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  servedPaths.push(path);
  assert.ok(!req.headers.authorization, 'user key must never reach the app host');
  const file=path.startsWith(prefix)?path.slice(prefix.length)||'index.html':'';
  if(!assets.has(file)){res.writeHead(404,{'Content-Type':'text/html'});return res.end('<h1>Not found</h1>');}
  res.writeHead(200,{'Content-Type':assets.get(file)});
  res.end(await readFile(new URL('../'+file,import.meta.url)));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try{
  browser=await chromium.launch({...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:process.env.CI?{}:{channel:'chrome'}),headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
  const page=await browser.newPage();
  const requests=[],errors=[];
  page.on('request',r=>requests.push(new URL(r.url()).pathname));
  page.on('pageerror',e=>errors.push(e.message));
  let apiCalls=0;
  await page.route('https://api.openai.com/v1/**',async route=>{
    const request=route.request();apiCalls++;
    assert.equal(request.headers().authorization,'Bearer sk-test-user-key');
    if(request.url().endsWith('/audio/transcriptions')) {
      assert.match(request.postDataBuffer().toString(),/gpt-4o-transcribe/);
      await route.fulfill({json:{text:'직접 전사 결과'}});
    } else {
      const data=request.postDataJSON();assert.equal(data.store,false);
      assert.equal(data.model,'gpt-4o-mini');
      await route.fulfill({json:{status:'completed',output:[{content:[{type:'output_text',text:'직접 AI 결과'}]}]}});
    }
  });
  await page.goto(`http://127.0.0.1:${server.address().port}${prefix}`);
  assert.equal(await page.evaluate(()=>typeof setLang),'function','language controller should load under the project prefix');
  for(const [label,lang] of [['English','en-US'],['简体中文','zh-CN'],['繁體中文','zh-TW'],['한국어','ko-KR']]){
    await page.getByRole('button',{name:label,exact:false}).click();
    assert.equal(await page.evaluate(()=>currentLang),lang);
    assert.match(await page.locator('.lang-btn.active').innerText(),new RegExp(label));
  }
  await page.click('#prepareBtn');
  await page.waitForFunction(()=>!preparing && document.getElementById('micStatus').textContent.includes('준비됨'));
  assert.ok(servedPaths.includes(prefix+'public/pcm-worklet.js'));
  await page.click('#releaseBtn');await page.waitForFunction(()=>!preparing && !capture.stream);
  // Without a key, recording remains available and the queue can be retried after key entry.
  await page.locator('#apiNotice').waitFor({state:'visible'});
  assert.match(await page.locator('#apiNotice').innerText(),/API 키/);
  await page.click('#recordBtn');await page.waitForFunction(()=>recording);
  await page.waitForTimeout(500);await page.click('#recordBtn');
  await page.waitForFunction(()=>!stopping && queueFailed);
  assert.equal(await page.locator('#saveAudioBtn').isEnabled(),true);
  assert.match(await page.locator('#transcribeStatus').innerText(),/키 입력/);assert.equal(apiCalls,0);
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>openSettings());
  await page.fill('#apiKey','sk-test-user-key');await page.click('#toggleKeyBtn');
  assert.equal(await page.locator('#apiKey').getAttribute('type'),'text');
  await page.click('#applyKeyBtn');assert.equal(await page.inputValue('#apiKey'),'');
  assert.equal(await page.locator('#apiKey').getAttribute('type'),'password');
  assert.doesNotMatch(await page.content(),/sk-test-user-key/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  if(process.env.SETTINGS_SCREENSHOT)await page.screenshot({path:process.env.SETTINGS_SCREENSHOT,fullPage:true});
  assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}).includes('sk-test-user-key')),false);
  await page.evaluate(()=>closeSettings());await page.click('#retryBtn');await page.waitForFunction(()=>!sessionBusy());
  assert.equal(await page.evaluate(()=>fullTx()),'직접 전사 결과');
  await page.click('#summarizeBtn');await page.waitForFunction(()=>!aiBusy);
  assert.match(await page.locator('#summaryBox').innerText(),/직접 AI 결과/);
  await page.click('#refineBtn');await page.waitForFunction(()=>!aiBusy);
  assert.equal(await page.evaluate(()=>fullTx()),'직접 AI 결과');assert.equal(apiCalls,3);
  await page.click('#archiveBtn');await page.waitForFunction(async()=> (await idbGetAll()).length===1);
  assert.equal(await page.evaluate(async()=>JSON.stringify(await idbGetAll()).includes('sk-test-user-key')),false);
  await page.evaluate(()=>openSettings());await page.click('#clearKeyBtn');
  assert.equal(await page.evaluate(()=>openaiClient.hasKey()),false);
  await page.fill('#apiKey','sk-test-user-key');await page.click('#applyKeyBtn');
  await page.reload();assert.equal(await page.evaluate(()=>openaiClient.hasKey()),false);
  assert.equal(await page.inputValue('#apiKey'),'');
  assert.ok(!servedPaths.some(p=>p.includes('/api/')||p.startsWith('/public/')));
  assert.deepEqual(errors,[]);
  console.log('Pages smoke passed: all languages, microphone preparation/release, WAV recording, direct transcription/AI, no host requests, key entry/delete/reload and no key persistence.');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
