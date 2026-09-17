// Serve only repository files beneath a project prefix, as GitHub Pages does.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const assets=new Map([
  ['index.html','text/html'],['public/app.js','text/javascript'],
  ['public/audio.js','text/javascript'],['public/pcm-worklet.js','text/javascript']
]);
const prefix='/mymeetingminutes/';
const servedPaths=[];
const server=http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  servedPaths.push(path);
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
  // A missing backend must not disable local microphone or language controls.
  await page.locator('#serverNotice').waitFor({state:'visible'});
  assert.match(await page.locator('#serverNotice').innerText(),/녹음|전사/);
  await page.click('#recordBtn');await page.waitForFunction(()=>recording);
  await page.waitForTimeout(500);await page.click('#recordBtn');
  await page.waitForFunction(()=>!stopping && queueFailed);
  assert.equal(await page.locator('#saveAudioBtn').isEnabled(),true);
  assert.match(await page.locator('#errorMsg').innerText(),/서버/);
  assert.ok(!requests.some(p=>p.startsWith('/public/')||p.startsWith('/api/')));
  assert.deepEqual(errors,[]);
  console.log('Pages smoke passed: all languages, microphone preparation/release, WAV recording, missing-backend notice, project-relative assets/worklet/API.');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
