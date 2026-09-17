let recording=false, starting=false, stopping=false, preparing=false, aiBusy=false, importing=false;
let currentLang='ko-KR', committedTx='', sessionFinal='', hasInterim=false, animId=null;
let audioBlob=null, audioChunks=[], elapsedTimer=null, recStartTs=0, wakeLock=null;
let queue=[], queueRunning=false, queueFailed=false, generation=0, requestController=null;
let sessionRate=48000, sessionLang='ko', sessionTerms='', idleTimer=null, sampleCount=0;
const $ = id => document.getElementById(id);
const fullTx = () => (committedTx + sessionFinal).trim();
const sessionBusy = () => recording || starting || stopping || preparing || aiBusy || importing || queue.length>0 || queueRunning;
const openaiClient = new MeetingOpenAI();
const capture = new MeetingCapture(onAudioChunk, message => {
  showErr(message);
  if (recording) void stopRec();
  else if (!starting && !preparing) void releasePreparedMic();
});
async function prepareMic() {
  if (preparing || recording || starting || stopping) return;
  preparing=true; $('prepareBtn').disabled=true;
  $('micStatus').textContent='마이크 준비 중…';
  try { await prepareCapture(); }
  catch (error) { showErr(error.name==='NotAllowedError'?'마이크 권한을 허용해 주세요.':error.message); $('micStatus').textContent='준비 실패'; }
  finally { preparing=false; $('prepareBtn').disabled=false; }
}
async function prepareCapture() {
  await capture.prepare($('micDevice').value);
  const selected=$('micDevice').value;
  try {
    const devices=await navigator.mediaDevices.enumerateDevices();
    $('micDevice').replaceChildren(new Option('기본 마이크',''));
    devices.filter(d=>d.kind==='audioinput').forEach((d,i)=>$('micDevice').add(new Option(d.label || `마이크 ${i+1}`,d.deviceId)));
    $('micDevice').value=selected;
  } catch {}
  $('micStatus').textContent='마이크 준비됨 · 아직 녹음하지 않음';
  clearTimeout(idleTimer); idleTimer=setTimeout(()=>{if(!recording&&!starting) void releasePreparedMic();},120000);
}
async function releasePreparedMic() {
  if(recording || starting || stopping || preparing) return;
  preparing=true;
  try {clearTimeout(idleTimer); await capture.release(); $('micStatus').textContent='마이크 꺼짐';}
  finally {preparing=false;}
}
async function changeMic() { if(sessionBusy()) return; await releasePreparedMic(); }
async function toggleRecord() { if(starting||stopping||preparing) return; recording ? await stopRec() : await startRec(); }
async function startRec() {
  if(sessionBusy()) {showToast('진행 중인 작업과 전사를 먼저 마쳐 주세요');return;}
  if ((audioBlob || fullTx()) && !confirm('새 회의를 시작하면 현재 화면의 내용이 바뀝니다. 필요한 내용은 저장하셨나요?')) return;
  starting=true; $('recordBtn').disabled=true; $('statusText').textContent='녹음 준비 중…';
  try {
    await prepareCapture(); clearTimeout(idleTimer);
    $('transcribeFileBtn').hidden=true;
    generation++; committedTx=''; sessionFinal=''; audioBlob=null; audioChunks=[]; sampleCount=0;
    sessionLang=currentLang.split('-')[0]; sessionTerms=[currentLang==='zh-TW'?'請使用繁體中文。':currentLang==='zh-CN'?'请使用简体中文。':'', $('terms').value.trim()].filter(Boolean).join(' '); sessionRate=capture.context.sampleRate;
    $('summaryCard').style.display='none'; $('summaryBox').textContent='';
    await capture.start();
    recording=true; setRecordingUI(); renderTx(''); startEQ(); startElapsed(); void acquireWakeLock();
    $('micStatus').textContent='마이크 사용 중';
    $('micDevice').disabled=true; $('terms').disabled=true;
    document.querySelectorAll('.lang-btn').forEach(b=>b.disabled=true);
  } catch(error) {
    await capture.release(); setStoppedUI(); $('micStatus').textContent='마이크 꺼짐';
    showErr(error.name==='NotAllowedError'?'마이크 권한을 허용해 주세요.':error.message);
  } finally {starting=false; $('recordBtn').disabled=false; updateQueueUI();}
}
async function stopRec() {
  if(!recording || stopping) return;
  stopping=true; recording=false; $('recordBtn').disabled=true;
  try {await capture.stop();} catch(error) {showErr(error.message+' 마지막 구간이 누락됐을 수 있습니다.');}
  finally {
    stopEQ(); stopElapsed(); releaseWakeLock(); await capture.release();
    audioBlob=audioChunks.length ? wavBlob(audioChunks,sessionRate) : null;
    setAudioForPlayback(audioBlob); setStoppedUI();
    $('micStatus').textContent='마이크 꺼짐'; $('micDevice').disabled=false; $('terms').disabled=false;
    document.querySelectorAll('.lang-btn').forEach(b=>b.disabled=false);
    stopping=false; $('recordBtn').disabled=false; updateQueueUI(); renderTx('');
  }
}
function onAudioChunk({pcm,sampleRate}) {
  sessionRate=sampleRate;
  const raw=new Blob([pcm]); audioChunks.push(raw); sampleCount+=pcm.byteLength/2;
  queue.push({blob:wavBlob([raw],sampleRate),language:sessionLang,terms:sessionTerms});
  updateQueueUI(); void processQueue();
  // Bound in-memory session size; the user can save and start another session.
  if(sampleCount>=sampleRate*3600 && recording) {showErr('1시간 녹음이 완료됐습니다. 저장 후 새 회의를 시작해 주세요.');void stopRec();}
}
async function processQueue() {
  if(queueRunning || queueFailed || !queue.length) return;
  queueRunning=true; const token=generation;
  try {
    while(queue.length && token===generation) {
      const job=queue[0]; requestController=new AbortController();
      const timer=setTimeout(()=>requestController?.abort(),120000);
      try {
        const text=await openaiClient.transcribe({blob:job.blob,name:job.name||'meeting.wav',language:job.language,
          prompt:[job.terms,fullTx().slice(-800)].filter(Boolean).join('\n')},requestController.signal);
        if(token!==generation) return;
        if(text.trim()) committedTx += text.trim()+'\n';
        queue.shift(); renderTx('');
      } catch(error) {
        if(token!==generation) return;
        queueFailed=true; showErr('전사가 멈췄습니다. 녹음은 보존됩니다. '+(error.name==='AbortError'?'요청 시간 초과':error.message)); break;
      } finally {clearTimeout(timer);}
      updateQueueUI();
    }
  } finally {queueRunning=false; requestController=null; updateQueueUI();}
}
function transcribeImported() {
  if(sessionBusy() || !audioBlob) return;
  if(audioBlob.size>24*1024*1024) {showErr('파일 전사는 24MB 이하만 지원합니다. 더 작은 오디오 파일을 불러와 주세요.');return;}
  const name=audioBlob.name || 'meeting.wav';
  if(!/\.(wav|webm|mp3|mp4|m4a|ogg|flac|mpeg|mpga)$/i.test(name)) {showErr('WAV, WebM, MP3, MP4, M4A, OGG, FLAC 파일을 사용해 주세요.');return;}
  queue.push({blob:audioBlob,name,language:currentLang.split('-')[0],terms:$('terms').value.trim()});
  $('transcribeFileBtn').hidden=true; updateQueueUI();void processQueue();
}
function retryTranscription() {queueFailed=false; $('errorMsg').style.display='none';void processQueue();}
function updateQueueUI() {
  $('transcribeStatus').textContent=queue.length ? `${queueFailed?'재시도 필요':'전사 처리 중'} · 남은 구간 ${queue.length}개` : recording?'다음 30초 구간을 녹음 중…':fullTx()?'전사 완료':'';
  $('retryBtn').hidden=!queueFailed;
  updateArchiveBtn();
}
function setLang(lang,btn) {
  if(sessionBusy()) {showToast('진행 중인 작업을 먼저 마쳐 주세요');return;}
  currentLang=lang; document.querySelectorAll('.lang-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');
}
async function acquireWakeLock(){try{if('wakeLock' in navigator){const lock=await navigator.wakeLock.request('screen');if(recording)wakeLock=lock;else await lock.release();}}catch{}}
function releaseWakeLock(){wakeLock?.release().catch(()=>{});wakeLock=null;}
function startElapsed(){recStartTs=performance.now();stopElapsed();elapsedTimer=setInterval(()=>{$('statusText').textContent='녹음 중… '+fmtDur(Math.floor((performance.now()-recStartTs)/1000));},1000);}
function stopElapsed(){clearInterval(elapsedTimer);elapsedTimer=null;}
function fmtDur(s){return `${pad(Math.floor(s/60))}:${pad(s%60)}`;}
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&recording) void acquireWakeLock();
  if(document.visibilityState==='hidden'&&recording) showErr('화면 잠금이나 백그라운드 전환은 녹음을 중단시킬 수 있습니다. 화면을 켜 두세요.');
});
window.addEventListener('beforeunload',e=>{if(sessionBusy()){e.preventDefault();e.returnValue='';}});
window.addEventListener('pagehide',()=>{clearApiKey(false);void capture.release();});
function updateKeyStatus() {
  const hasKey=openaiClient.hasKey();
  $('apiKeyStatus').textContent=hasKey?'키 입력됨 · 이 탭에서만 사용 · 실제 API 요청 시 유효성을 확인합니다.':'키를 입력해 주세요.';
  $('apiNotice').textContent=hasKey?'':'환경설정에서 OpenAI API 키를 입력하면 전사와 AI 요약을 사용할 수 있습니다. 키 없이도 녹음·저장은 가능합니다.';
  $('apiNotice').hidden=hasKey;
}
function applyApiKey() {
  try {
    if(queueRunning || aiBusy) {showToast('진행 중인 API 요청이 끝난 뒤 키를 변경해 주세요');return;}
    openaiClient.setKey($('apiKey').value);
    $('apiKey').value=''; $('apiKey').type='password';
    $('toggleKeyBtn').textContent='보기'; $('toggleKeyBtn').setAttribute('aria-pressed','false');
    updateKeyStatus(); showToast('이 탭에서 키를 사용합니다. 미완료 전사는 재시도해 주세요.');
  } catch(error) {showToast(error.message);}
}
function clearApiKey(notify=true) {
  openaiClient.clearKey(); $('apiKey').value=''; $('apiKey').type='password';
  $('toggleKeyBtn').textContent='보기'; $('toggleKeyBtn').setAttribute('aria-pressed','false');
  updateKeyStatus(); if(notify)showToast('키를 삭제했습니다. 새 요청에는 키를 다시 입력해 주세요.');
}
function toggleApiVis() {
  const input=$('apiKey'), visible=input.type==='password';
  input.type=visible?'text':'password'; $('toggleKeyBtn').textContent=visible?'숨기기':'보기';
  $('toggleKeyBtn').setAttribute('aria-pressed',String(visible));
}
updateKeyStatus();
function saveAudio() {
  if (audioBlob) { _downloadAudio(); return; }
  if (recording)  { showToast('녹음 종료 후 저장할 수 있어요'); return; }
  showToast('녹음을 먼저 진행해 주세요');
}

// ─────────────────────────────────────────
// 파일 불러오기 (.txt / 오디오) + 재생
// ─────────────────────────────────────────
let playerUrl = null;

function handleFileLoad(e){
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (sessionBusy()) { showToast('진행 중인 작업을 먼저 마쳐 주세요'); return; }

  const isAudio = file.type.startsWith('audio/') || /\.(webm|ogg|mp4|m4a|mp3|wav|aac|flac)$/i.test(file.name);
  const isText  = file.type.startsWith('text/')  || /\.txt$/i.test(file.name);

  if (isAudio) {
    committedTx=''; sessionFinal=''; renderTx('');
    $('summaryCard').style.display='none'; $('summaryBox').textContent='';
    audioBlob   = file;
    audioChunks = [];
    setAudioForPlayback(file);
    document.getElementById('saveAudioBtn').disabled = false;
    document.getElementById('statusText').textContent = '녹음 불러옴';
    updateArchiveBtn();
    $('transcribeFileBtn').hidden=false;
    showToast('녹음 파일을 불러왔어요. 파일 전사 버튼으로 전사할 수 있습니다.');
  } else if (isText) {
    importing=true;
    const reader = new FileReader();
    reader.onload  = () => {
      audioBlob=null; audioChunks=[]; setAudioForPlayback(null); $('saveAudioBtn').disabled=true;
      $('summaryCard').style.display='none'; $('summaryBox').textContent=''; $('transcribeFileBtn').hidden=true;
      let content = String(reader.result || '');
      // 이 앱에서 저장한 .txt의 헤더(제목/날짜/구분선) 자동 제거
      content = content.replace(/^회의 전사 내용\s*\r?\n날짜:[^\r\n]*\r?\n─+\r?\n\r?\n?/, '');
      committedTx  = content.trim() ? content.trim() + ' ' : '';
      sessionFinal = '';
      hasInterim   = false;
      renderTx('');
      document.getElementById('statusText').textContent = '전사 불러옴';
      showToast('전사 파일을 불러왔어요');
    };
    reader.onerror = () => showToast('파일을 읽을 수 없어요');
    reader.onloadend = () => {importing=false;};
    reader.readAsText(file);
  } else {
    showToast('지원하지 않는 파일 형식이에요 (.txt 또는 오디오 파일)');
  }
}

function setAudioForPlayback(blob){
  const player  = document.getElementById('player');
  const playBtn = document.getElementById('playBtn');
  try { player.pause(); } catch {}
  if (playerUrl) { try { URL.revokeObjectURL(playerUrl); } catch {} playerUrl = null; }
  if (blob) {
    playerUrl  = URL.createObjectURL(blob);
    player.src = playerUrl;
    playBtn.disabled = false;
  } else {
    player.removeAttribute('src');
    try { player.load(); } catch {}
    playBtn.disabled = true;
  }
  playBtn.textContent = '▶️ 재생';
}

function togglePlay(){
  const player  = document.getElementById('player');
  const playBtn = document.getElementById('playBtn');
  if (!player.getAttribute('src')) { showToast('재생할 녹음이 없어요'); return; }
  player.onended = () => { playBtn.textContent = '▶️ 재생'; };
  if (player.paused) {
    player.play().then(() => { playBtn.textContent = '⏸️ 일시정지'; })
                 .catch(() => showToast('재생할 수 없어요'));
  } else {
    player.pause();
    playBtn.textContent = '▶️ 재생';
  }
}

function audioExtension(mime='') {
  if(mime.includes('wav'))return 'wav';
  if(mime.includes('mpeg')||mime.includes('mp3'))return 'mp3';
  if(mime.includes('flac'))return 'flac';
  if(mime.includes('aac'))return 'aac';
  if(mime.includes('ogg'))return 'ogg';
  if(mime.includes('mp4')||mime.includes('m4a'))return 'm4a';
  return 'webm';
}
function _downloadAudio() {
  if (!audioBlob) return;
  const now   = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const ext = audioExtension(audioBlob.type);
  _download(audioBlob, `회의녹음_${stamp}.${ext}`);
  showToast('녹음 파일이 저장됐어요');
}

function setRecordingUI() {
  document.getElementById('recordBtn').classList.add('recording');
  document.getElementById('statusBadge').classList.add('recording');
  document.getElementById('statusText').textContent = '녹음 중...';
  document.getElementById('errorMsg').style.display = 'none';
  document.getElementById('micIcon').innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2"/>';
  document.getElementById('saveAudioBtn').disabled = true;
  setAudioForPlayback(null);
}

function setStoppedUI() {
  document.getElementById('recordBtn').classList.remove('recording');
  document.getElementById('statusBadge').classList.remove('recording');
  document.getElementById('statusText').textContent = fullTx() ? '녹음 완료' : '녹음 시작';
  document.getElementById('micIcon').innerHTML =
    '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>' +
    '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>' +
    '<line x1="12" y1="19" x2="12" y2="23"/>' +
    '<line x1="8" y1="23" x2="16" y2="23"/>';
  document.getElementById('saveAudioBtn').disabled = !audioBlob;
}

// ─────────────────────────────────────────
// 이퀄라이저 — roundRect 폴리필 포함
// ─────────────────────────────────────────
function drawBar(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill();
  } else {
    r = Math.min(r, h/2, w/2);
    ctx.beginPath();
    ctx.moveTo(x+r, y); ctx.lineTo(x+w-r, y);
    ctx.arcTo(x+w,y, x+w,y+r, r); ctx.lineTo(x+w,y+h-r);
    ctx.arcTo(x+w,y+h, x+w-r,y+h, r); ctx.lineTo(x+r,y+h);
    ctx.arcTo(x,y+h, x,y+h-r, r); ctx.lineTo(x,y+r);
    ctx.arcTo(x,y, x+r,y, r); ctx.closePath(); ctx.fill();
  }
}

function startEQ() {
  const canvas = document.getElementById('eqCanvas'), ctx = canvas.getContext('2d');
  canvas.style.display = 'block';
  const bins = new Uint8Array(capture.analyser.frequencyBinCount);
  function draw() {
    animId = requestAnimationFrame(draw);
    capture.analyser.getByteFrequencyData(bins);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#2563eb';
    for (let i=0;i<28;i++) {
      const h = Math.max(1, bins[i*3] / 255 * canvas.height);
      drawBar(ctx, i*8, canvas.height-h, 6, h, 2);
    }
  }
  draw();
}

function stopEQ() {
  cancelAnimationFrame(animId);
  const c = document.getElementById('eqCanvas');
  c.style.display = 'none';
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
  hasInterim = false;
}

// ─────────────────────────────────────────
// 전사 렌더링 — HTML 이스케이프 + 언어별 카운트
// ─────────────────────────────────────────
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function countLabel(text){
  if (/^zh/.test(currentLang)) return text.replace(/\s+/g,'').length + '자';
  return text.split(/\s+/).filter(Boolean).length + '단어';
}

function renderTx(interim) {
  const box = document.getElementById('transcriptBox');
  const full = fullTx();
  const combined = esc(full) + (interim ? ` <span class="interim">${esc(interim)}</span>` : '');
  if (combined.trim()) {
    box.classList.remove('empty');
    box.innerHTML = combined;
    box.scrollTop = box.scrollHeight;
    document.getElementById('wc').textContent = full ? countLabel(full) : '';
    document.getElementById('summarizeBtn').disabled = !full;
    document.getElementById('saveTxtBtn').disabled = !full;
    document.getElementById('refineBtn').disabled = !full;
  } else {
    box.classList.add('empty');
    box.textContent = '녹음된 음성이 약 30초마다 전사됩니다. 종료 시 마지막 구간도 처리합니다.';
    document.getElementById('wc').textContent = '';
    document.getElementById('summarizeBtn').disabled = true;
    document.getElementById('saveTxtBtn').disabled = true;
    document.getElementById('refineBtn').disabled = true;
  }
  updateArchiveBtn();
}

// ─────────────────────────────────────────
// 텍스트 저장
// ─────────────────────────────────────────
function saveText() {
  const text = fullTx(); if (!text) return;
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const content = `회의 전사 내용\n날짜: ${now.toLocaleString('ko-KR')}\n${'─'.repeat(40)}\n\n${text}`;
  _download(new Blob([content],{type:'text/plain;charset=utf-8'}), `회의록_${stamp}.txt`);
  showToast('텍스트 파일이 저장됐어요');
}

// ─────────────────────────────────────────
// 브라우저에서 OpenAI API 직접 호출
// ─────────────────────────────────────────
async function callAI(action, text) {
  return openaiClient.ai(action,text);
}

// ─────────────────────────────────────────
// AI 요약
// ─────────────────────────────────────────
async function summarize() {
  const text = fullTx(); if (!text) return;
  if (sessionBusy()) { showToast('녹음과 전사가 끝난 뒤 실행해 주세요'); return; }
  aiBusy = true;
  const card = document.getElementById('summaryCard');
  const box  = document.getElementById('summaryBox');
  card.style.display = 'block';
  box.innerHTML = '<div class="loading-wrap"><div class="spinner"></div> 요약 생성 중...</div>';
  document.getElementById('summarizeBtn').disabled = true;
  card.scrollIntoView({behavior:'smooth',block:'nearest'});
  try {
    const result = await callAI('summarize', text);
    box.textContent = result ?? '응답을 파싱할 수 없어요. OpenAI API 키를 확인해 주세요.';
  } catch(error) {
    box.textContent = '요약 실패: '+error.message;
  }
  aiBusy = false; renderTx('');
}

// ─────────────────────────────────────────
// ✨ AI 교정 — 오인식·띄어쓰기·문장부호 후처리 (인식률 실질 개선)
// ─────────────────────────────────────────
async function refineTranscript(){
  if (recording) { showToast('녹음 종료 후 교정할 수 있어요'); return; }
  const text = fullTx(); if (!text) return;
  if (sessionBusy()) { showToast('녹음과 전사가 끝난 뒤 실행해 주세요'); return; }

  aiBusy = true;
  const btn = document.getElementById('refineBtn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '✨ 교정 중...';
  showToast('AI가 전사 내용을 교정하고 있어요');

  try {
    const result = await callAI('refine', text);
    if (result) {
      committedTx  = result.trim() + ' ';
      sessionFinal = '';
      renderTx('');
      showToast('✨ AI 교정이 완료됐어요');
    } else {
      showToast('교정에 실패했어요. OpenAI API 키를 확인해 주세요');
    }
  } catch(error) {
    showErr('교정 실패: '+error.message);
  }
  aiBusy = false;
  btn.textContent = original;
  btn.disabled = !fullTx();
}

// ─────────────────────────────────────────
// 초기화
// ─────────────────────────────────────────
function clearAll() {
  if (recording || starting || stopping || preparing || importing || aiBusy) { showToast('진행 중인 작업을 먼저 종료해 주세요'); return; }
  if (queue.length && !confirm('미완료 전사를 버리고 초기화할까요? 먼저 녹음을 저장할 수 있습니다.')) return;
  $('transcribeFileBtn').hidden=true;
  generation++;
  requestController?.abort(); queue=[]; queueFailed=false;
  committedTx=''; sessionFinal=''; audioBlob=null; audioChunks=[];
  releasePreparedMic();
  renderTx(''); setStoppedUI(); setAudioForPlayback(null); updateQueueUI();
  document.getElementById('summaryCard').style.display='none';
  document.getElementById('summaryBox').textContent='';
  document.getElementById('errorMsg').style.display='none';
}

function _download(blob, name){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),3000);
}
function pad(n){return String(n).padStart(2,'0');}
function copySummary(){
  navigator.clipboard.writeText(document.getElementById('summaryBox').textContent)
    .then(()=>showToast('클립보드에 복사됐어요'));
}
function showToast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2200);
}
function showErr(msg){
  const el=document.getElementById('errorMsg');
  el.textContent=msg; el.style.display='block';
}
try { localStorage.removeItem('mmm_anthropic_api_key'); } catch {}

function openSettings(){
  document.getElementById('mainView').style.display='none';
  document.getElementById('historyView').style.display='none';
  document.getElementById('settingsView').style.display='block';
  window.scrollTo(0,0);
}
function closeSettings(){
  document.getElementById('settingsView').style.display='none';
  document.getElementById('mainView').style.display='block';
  window.scrollTo(0,0);
}
const DB_NAME = 'meetingRecorder';
const STORE   = 'sessions';
let histUrls  = [];

function idbOpen(){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath:'id', autoIncrement:true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
function idbTx(mode, fn){
  return idbOpen().then(db => new Promise((resolve,reject)=>{
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  }));
}
function idbAdd(record){
  return idbTx('readwrite', store => new Promise((res,rej)=>{
    const r = store.add(record); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
  }));
}
function idbGetAll(){
  return idbTx('readonly', store => new Promise((res,rej)=>{
    const r = store.getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>rej(r.error);
  }));
}
function idbDelete(id){
  return idbTx('readwrite', store => new Promise((res,rej)=>{
    const r = store.delete(id); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error);
  }));
}

function updateArchiveBtn(){
  const btn = document.getElementById('archiveBtn');
  if (btn) btn.disabled = !(fullTx() || audioBlob);
}

async function archiveSession(){
  if (sessionBusy()) { showToast('녹음과 전사가 끝난 뒤 저장해 주세요'); return; }
  const text = fullTx();
  if (!text && !audioBlob) { showToast('저장할 내용이 없어요'); return; }
  const record = {
    createdAt: Date.now(),
    lang     : currentLang,
    transcript: text,
    words    : text ? text.split(/\s+/).filter(Boolean).length : 0,
    audio    : audioBlob || null,
    mime     : audioBlob ? (audioBlob.type || 'audio/webm') : null
  };
  try {
    await idbAdd(record);
    showToast('보관함에 저장됐어요');
  } catch {
    showToast('보관함 저장에 실패했어요');
  }
}

// ─────────────────────────────────────────
// 보관함 뷰
// ─────────────────────────────────────────
function openHistory(){
  document.getElementById('mainView').style.display='none';
  document.getElementById('settingsView').style.display='none';
  document.getElementById('historyView').style.display='block';
  window.scrollTo(0,0);
  renderHistory();
}
function closeHistory(){
  releaseHistUrls();
  document.getElementById('historyView').style.display='none';
  document.getElementById('mainView').style.display='block';
  window.scrollTo(0,0);
}
function releaseHistUrls(){
  histUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch {} });
  histUrls = [];
}

function fmtDate(ms){
  try { return new Date(ms).toLocaleString('ko-KR'); } catch { return ''; }
}
function langLabel(code){
  return ({'ko-KR':'🇰🇷 한국어','en-US':'🇺🇸 English','zh-CN':'🇨🇳 简体中文','zh-TW':'🇹🇼 繁體中文'})[code] || code || '';
}

async function renderHistory(){
  releaseHistUrls();
  const listEl = document.getElementById('historyList');
  const countEl = document.getElementById('histCount');
  let items = [];
  try { items = await idbGetAll(); } catch { items = []; }
  items.sort((a,b) => b.createdAt - a.createdAt);

  countEl.textContent = items.length ? items.length + '건' : '';
  listEl.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = '아직 저장된 내역이 없어요. 녹음 후 "보관함에 저장"을 눌러보세요.';
    listEl.appendChild(empty);
    return;
  }

  items.forEach(rec => listEl.appendChild(buildHistItem(rec)));
}

function buildHistItem(rec){
  const item = document.createElement('div');
  item.className = 'hist-item';

  const head = document.createElement('div');
  head.className = 'hist-head';
  const left = document.createElement('div');
  const date = document.createElement('div');
  date.className = 'hist-date';
  date.textContent = fmtDate(rec.createdAt);
  const meta = document.createElement('div');
  meta.className = 'hist-meta';
  meta.appendChild(makeTag(langLabel(rec.lang)));
  if (rec.transcript) meta.appendChild(makeTag('📝 ' + rec.words + '단어'));
  if (rec.audio)      meta.appendChild(makeTag('🎵 녹음'));
  left.appendChild(date); left.appendChild(meta);
  head.appendChild(left);
  item.appendChild(head);

  if (rec.transcript) {
    const prev = document.createElement('div');
    prev.className = 'hist-preview';
    prev.textContent = rec.transcript.length > 140 ? rec.transcript.slice(0,140) + '…' : rec.transcript;
    item.appendChild(prev);
  }

  if (rec.audio) {
    const url = URL.createObjectURL(rec.audio);
    histUrls.push(url);
    const audio = document.createElement('audio');
    audio.className = 'hist-audio';
    audio.controls = true;
    audio.src = url;
    item.appendChild(audio);
  }

  const actions = document.createElement('div');
  actions.className = 'hist-actions';

  if (rec.transcript) {
    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn btn-primary';
    loadBtn.textContent = '📄 전사 불러오기';
    loadBtn.onclick = () => loadHistorySession(rec);
    actions.appendChild(loadBtn);
  }
  if (rec.audio) {
    const dlBtn = document.createElement('button');
    dlBtn.className = 'btn btn-ghost';
    dlBtn.textContent = '⬇️ 녹음 다운로드';
    dlBtn.onclick = () => downloadHistAudio(rec);
    actions.appendChild(dlBtn);
  }
  const delBtn = document.createElement('button');
  delBtn.className = 'btn btn-danger-ghost';
  delBtn.textContent = '🗑 삭제';
  delBtn.onclick = () => deleteHistorySession(rec.id);
  actions.appendChild(delBtn);

  item.appendChild(actions);
  return item;
}

function makeTag(text){
  const t = document.createElement('span');
  t.className = 'hist-tag';
  t.textContent = text;
  return t;
}

function loadHistorySession(rec){
  if (sessionBusy()) { showToast('진행 중인 작업을 먼저 마쳐 주세요'); return; }
  $('transcribeFileBtn').hidden=true;
  committedTx  = rec.transcript ? rec.transcript.trim() + ' ' : '';
  sessionFinal = '';
  hasInterim   = false;
  audioBlob = rec.audio || null;
  audioChunks = [];
  renderTx('');
  document.getElementById('saveAudioBtn').disabled = !audioBlob;
  setAudioForPlayback(audioBlob);
  document.getElementById('statusText').textContent = fullTx() ? '불러옴' : '녹음 시작';
  document.getElementById('summaryCard').style.display = 'none';
  document.getElementById('summaryBox').textContent = '';
  closeHistory();
  showToast('보관함에서 불러왔어요');
}

function downloadHistAudio(rec){
  if (!rec.audio) return;
  const stamp = (() => { const d=new Date(rec.createdAt);
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`; })();
  const mime = rec.mime || rec.audio.type || '';
  const ext = audioExtension(mime);
  _download(rec.audio, `회의녹음_${stamp}.${ext}`);
  showToast('녹음 파일이 저장됐어요');
}

async function deleteHistorySession(id){
  if (!confirm('이 내역을 삭제할까요? 되돌릴 수 없어요.')) return;
  try { await idbDelete(id); showToast('삭제됐어요'); }
  catch { showToast('삭제에 실패했어요'); }
  renderHistory();
}
