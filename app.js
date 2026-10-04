const $ = (id) => document.getElementById(id);

const CHUNK_SEC = 28;
const OVERLAP_SEC = 3;
const STORAGE_KEY = "hanyang_lms_whisper_v11_session";
const PREF_KEY = "hanyang_lms_whisper_v11_prefs";

const ui = {
  start: $("startBtn"), pause: $("pauseBtn"), stop: $("stopBtn"), retry: $("retryBtn"),
  bookmark: $("bookmarkBtn"), unclear: $("unclearBtn"), memo: $("memoBtn"),
  clear: $("clearBtn"), diag: $("diagBtn"),
  txt: $("txtBtn"), rawTxt: $("rawTxtBtn"), srt: $("srtBtn"), ai: $("aiBtn"), copy: $("copyBtn"),
  cleanTab: $("cleanTab"), rawTab: $("rawTab"), cleanBadge: $("cleanBadge"), rawBadge: $("rawBadge"),
  transcript: $("transcript"), status: $("status"), detail: $("detail"), dot: $("dot"),
  progress: $("progressBar"), meter: $("audioMeter"), audioText: $("audioText"),
  meta: $("meta"), error: $("errorBox"), timer: $("timer"),
  title: $("lectureTitle"), week: $("lectureWeek"), restore: $("restoreBanner")
};

let worker = null;
let workerReady = false;
let modelLoading = false;
let modelFailed = false;

let displayStream = null;
let audioContext = null;
let processor = null;
let sourceNode = null;
let muteNode = null;

let capturing = false;
let paused = false;
let stopping = false;
let sampleRate = 48000;
let buffers = [];
let bufferedSamples = 0;
let nextWindowStartSec = 0;
let capturedSeconds = 0;
let timerHandle = null;
let inflight = 0;
let activeTab = "clean";
let sessionStartedAt = null;
let segmentSeq = 0;

let segments = [];
let markers = [];
let lastAudio = null;
let lastAudioMeta = null;

function setStatus(text, kind="busy", detail="") {
  ui.status.textContent = text;
  ui.detail.textContent = detail;
  ui.dot.className = "dot " + kind;
}
function showError(msg){ ui.error.style.display="block"; ui.error.textContent=msg; }
function clearError(){ ui.error.style.display="none"; ui.error.textContent=""; }

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = String(Math.floor(sec/3600)).padStart(2,"0");
  const m = String(Math.floor((sec%3600)/60)).padStart(2,"0");
  const s = String(sec%60).padStart(2,"0");
  return `${h}:${m}:${s}`;
}
function sanitizeFilename(s) {
  return (s || "Hanyang_LMS_Whisper")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "Hanyang_LMS_Whisper";
}
function dateStamp() {
  const d = new Date();
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), day=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function baseFilename() {
  const title = sanitizeFilename(ui.title.value);
  const week = String(ui.week.value || "").trim();
  return week ? `${title}_${sanitizeFilename(week)}주차_${dateStamp()}` : `${title}_${dateStamp()}`;
}
function headerText() {
  const title = ui.title.value.trim() || "제목 없음";
  const week = ui.week.value.trim();
  return [
    `강의 제목: ${title}`,
    week ? `주차: ${week}주차` : null,
    `전사 날짜: ${dateStamp()}`,
    `전사 도구: Hanyang LMS Whisper Web v1.1`,
  ].filter(Boolean).join("\n");
}

function persistPrefs() {
  localStorage.setItem(PREF_KEY, JSON.stringify({title:ui.title.value, week:ui.week.value}));
}
function saveSession() {
  persistPrefs();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: "1.1",
      title: ui.title.value,
      week: ui.week.value,
      sessionStartedAt,
      segments: segments.map(({audio, ...s}) => s),
      markers
    }));
  } catch {}
}
function restoreSession() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    ui.title.value = prefs.title || "";
    ui.week.value = prefs.week || "";

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && (saved.segments?.length || saved.markers?.length)) {
      ui.title.value = saved.title || ui.title.value;
      ui.week.value = saved.week || ui.week.value;
      sessionStartedAt = saved.sessionStartedAt || null;
      segments = saved.segments || [];
      markers = saved.markers || [];
      ui.restore.style.display = "block";
      updateAll();
    }
  } catch {}
}
function clearSession() {
  if (capturing || stopping) return;
  if ((segments.length || markers.length) && !confirm("현재 전사 기록을 모두 지울까요?")) return;
  segments = []; markers = []; lastAudio = null; lastAudioMeta = null;
  localStorage.removeItem(STORAGE_KEY);
  ui.restore.style.display = "none";
  updateAll();
}

function repetitionInfo(text) {
  const cleaned = (text || "").trim().replace(/\s+/g," ");
  if (!cleaned) return {suspicious:false, score:0};

  const words = cleaned.split(" ");
  let maxSame = 1, run = 1;
  for (let i=1;i<words.length;i++) {
    if (words[i] === words[i-1]) { run++; maxSame=Math.max(maxSame,run); }
    else run=1;
  }

  let phraseHits = 0;
  for (let n=2;n<=5;n++) {
    for (let i=0;i+n*3<=words.length;i++) {
      const a=words.slice(i,i+n).join(" ");
      const b=words.slice(i+n,i+n*2).join(" ");
      const c=words.slice(i+n*2,i+n*3).join(" ");
      if (a===b && b===c) phraseHits++;
    }
  }

  const uniqueRatio = new Set(words).size / Math.max(1,words.length);
  const suspicious = maxSame >= 4 || phraseHits > 0 || (words.length >= 20 && uniqueRatio < 0.22);
  return {suspicious, score: maxSame + phraseHits*3 + (uniqueRatio<0.22?3:0)};
}

function cleanText(text) {
  let t = (text || "").replace(/\s+/g," ").trim();
  if (!t) return "";

  // Collapse exact single-token loops (4+) while leaving normal emphatic repetition alone.
  t = t.replace(/(^|\s)([^\s]+)(?:\s+\2){3,}/gu, "$1$2");

  // Collapse exact 2-5 word phrase loops occurring 3+ times.
  for (let n=5;n>=2;n--) {
    const pattern = new RegExp(`(^|\\s)((?:[^\\s]+\\s+){${n-1}}[^\\s]+)(?:\\s+\\2){2,}`, "gu");
    t = t.replace(pattern, "$1$2");
  }

  // Remove duplicated punctuation / spaces only. No semantic rewriting.
  t = t.replace(/([.!?。！？])\1{1,}/g, "$1").replace(/\s+/g," ").trim();
  return t;
}

function markerLabel(m) {
  if (m.type==="bookmark") return "★ 중요";
  if (m.type==="unclear") return "? 확인 필요";
  return `메모: ${m.note || ""}`;
}

function buildTimeline(cleanMode=true) {
  const entries = [];
  for (const s of segments) {
    const text = cleanMode ? (s.clean || cleanText(s.raw)) : (s.raw || "");
    if (text.trim()) entries.push({time:s.start, type:"segment", text, s});
  }
  for (const m of markers) entries.push({time:m.time, type:"marker", m});
  entries.sort((a,b)=>a.time-b.time || (a.type==="marker"?-1:1));

  return entries.map(e => {
    if (e.type==="marker") return `[${fmtTime(e.time)}] ${markerLabel(e.m)}`;
    const flags = [];
    if (e.s.autoRetried) flags.push("자동 재전사");
    if (e.s.suspicious) flags.push("⚠ 반복 의심");
    const suffix = flags.length ? `  [${flags.join(" · ")}]` : "";
    return `[${fmtTime(e.time)}]${suffix}\n${e.text}`;
  }).join("\n\n");
}

function rawCount(){ return segments.filter(s=>s.raw?.trim()).length; }
function suspiciousCount(){ return segments.filter(s=>s.suspicious).length; }

function render() {
  const text = buildTimeline(activeTab==="clean");
  ui.transcript.textContent = text || "전사된 내용이 여기에 나타납니다.";
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
  ui.cleanBadge.textContent = String(rawCount());
  ui.rawBadge.textContent = String(rawCount());

  const has = rawCount() > 0 || markers.length > 0;
  for (const b of [ui.txt,ui.rawTxt,ui.srt,ui.ai,ui.copy]) b.disabled = !has;
  ui.retry.disabled = !lastAudio || inflight > 0 || !workerReady;
  ui.meta.textContent =
    `처리 완료 ${rawCount()}구간 · 확인 필요 ${suspiciousCount()}구간 · 마커 ${markers.length}개` +
    (inflight ? ` · 전사 대기 ${inflight}개` : "");
}
function updateAll(){ render(); saveSession(); }

function addMarker(type) {
  if (!capturing && !paused) return;
  let note = "";
  if (type==="memo") {
    note = prompt("이 시점에 남길 메모를 입력하세요.")?.trim() || "";
    if (!note) return;
  }
  markers.push({time:capturedSeconds, type, note});
  updateAll();
}

function appendBuffer(data) { buffers.push(data); bufferedSamples += data.length; }
function takeSamples(count) {
  const out=new Float32Array(count); let written=0;
  while(written<count && buffers.length){
    const first=buffers[0], need=count-written;
    if(first.length<=need){out.set(first,written);written+=first.length;buffers.shift();bufferedSamples-=first.length;}
    else{out.set(first.subarray(0,need),written);buffers[0]=first.slice(need);bufferedSamples-=need;written+=need;}
  }
  return out;
}
function prependBuffer(data){buffers.unshift(data);bufferedSamples+=data.length;}

function flushReadyWindows() {
  const windowSamples=Math.floor(sampleRate*CHUNK_SEC);
  const overlapSamples=Math.floor(sampleRate*OVERLAP_SEC);

  while(bufferedSamples>=windowSamples){
    const audio=takeSamples(windowSamples);
    const start=nextWindowStartSec;
    const end=start+CHUNK_SEC;
    const overlap=audio.slice(audio.length-overlapSamples);
    prependBuffer(overlap);
    nextWindowStartSec += CHUNK_SEC-OVERLAP_SEC;
    queueTranscription(audio,start,end,false,null,0);
  }
}

function ensureWorker() {
  if (worker) return;
  worker = new Worker("./worker.js", {type:"module"});
  worker.onmessage = (event) => {
    const m=event.data||{};
    if(m.type==="progress"){
      modelLoading=true;
      const pct=Number.isFinite(m.progress)?Math.max(0,Math.min(100,m.progress)):0;
      ui.progress.style.width=pct+"%";
      setStatus("Whisper 모델 준비 중","busy",m.file?`${m.file} ${Math.round(pct)}%`:"첫 실행은 시간이 걸릴 수 있습니다.");
      return;
    }
    if(m.type==="ready"){
      workerReady=true; modelLoading=false; modelFailed=false; ui.progress.style.width="100%";
      setStatus("Whisper 준비 완료","ready",`${m.model} · ${m.device.toUpperCase()} · ${m.dtypeLabel}`);
      render();
      return;
    }
    if(m.type==="result"){ handleResult(m); return; }
    if(m.type==="error"){
      inflight=Math.max(0,inflight-1);
      modelFailed=true;
      showError(m.message||"Whisper 처리 중 오류가 발생했습니다.");
      setStatus("Whisper 오류","error","진단 버튼으로 상태를 확인하세요.");
      if(stopping && inflight===0) finishStop();
      render();
    }
  };
  worker.onerror=(e)=>{modelFailed=true;showError(`Whisper Worker 오류\n${e.message||"알 수 없는 오류"}`);setStatus("Whisper Worker 오류","error");};
}

function waitUntil(test,timeoutMs){
  return new Promise((resolve,reject)=>{
    const started=Date.now();
    const t=setInterval(()=>{
      if(test()){clearInterval(t);resolve();}
      else if(Date.now()-started>timeoutMs){clearInterval(t);reject(new Error("시간 초과"));}
    },250);
  });
}
async function initModelIfNeeded(){
  ensureWorker();
  if(workerReady)return;
  if(modelLoading){
    await waitUntil(()=>workerReady||modelFailed,300000);
    if(!workerReady)throw new Error("Whisper 모델 준비에 실패했습니다.");
    return;
  }
  modelLoading=true;modelFailed=false;ui.progress.style.width="2%";
  worker.postMessage({type:"init",device:navigator.gpu?"webgpu":"wasm",model:"onnx-community/whisper-small"});
  await waitUntil(()=>workerReady||modelFailed,300000);
  if(!workerReady)throw new Error("Whisper 모델 준비에 실패했습니다.");
}

function queueTranscription(audio,start,end,isRetry=false,targetId=null,retryStrength=0){
  if(!workerReady||!audio?.length)return;
  const id = targetId ?? (++segmentSeq);
  const sendAudio = audio.slice();
  lastAudio = audio.slice();
  lastAudioMeta = {id,start,end};

  inflight++;
  worker.postMessage({
    type:"transcribe", id, audio:sendAudio, sampleRate, start, end,
    retry:isRetry, retryStrength
  }, [sendAudio.buffer]);
  render();
}

function handleResult(m){
  inflight=Math.max(0,inflight-1);
  const raw=(m.text||"").trim();
  const info=repetitionInfo(raw);

  let seg=segments.find(s=>s.id===m.id);
  if(!seg){
    seg={id:m.id,start:m.start,end:m.end,raw:"",clean:"",suspicious:false,autoRetried:false,retryCount:0,firstRaw:""};
    segments.push(seg);
  }

  if(!m.retry){
    seg.firstRaw=raw;
    seg.raw=raw;
    seg.clean=cleanText(raw);
    seg.suspicious=info.suspicious;
    seg.retryCount=0;

    if(info.suspicious && seg.retryCount<1 && lastAudioMeta?.id===m.id && lastAudio){
      seg.retryCount=1;
      setStatus("반복 환각 감지 — 자동 재전사","busy",`[${fmtTime(seg.start)}] 구간을 더 강한 반복 억제로 다시 처리합니다.`);
      queueTranscription(lastAudio,seg.start,seg.end,true,seg.id,1);
    }
  } else {
    const oldInfo=repetitionInfo(seg.raw);
    const newInfo=repetitionInfo(raw);
    seg.autoRetried=true;
    seg.retryCount=(seg.retryCount||0)+1;

    // Keep the less repetitive output. If equal, prefer the retry when non-empty.
    if(raw && newInfo.score <= oldInfo.score){
      seg.raw=raw;
      seg.clean=cleanText(raw);
      seg.suspicious=newInfo.suspicious;
    } else {
      seg.suspicious=oldInfo.suspicious;
    }
  }

  segments.sort((a,b)=>a.start-b.start);
  updateAll();

  if(capturing && !paused){
    setStatus("녹음·전사 중","ready",`오디오 ${Math.round(sampleRate/1000)} kHz · ${CHUNK_SEC}초 구간 / ${OVERLAP_SEC}초 겹침`);
  }
  if(stopping && inflight===0) finishStop();
}

async function startCapture(){
  clearError();
  if(!window.isSecureContext){
    showError("HTTPS 보안 연결에서 열어야 탭 오디오 공유가 가능합니다. GitHub Pages의 https:// 주소에서 실행해 주세요.");
    return;
  }
  if(!navigator.mediaDevices?.getDisplayMedia){
    showError("이 브라우저는 탭 오디오 공유를 지원하지 않습니다. 최신 Chrome 또는 Whale을 사용하세요.");
    return;
  }

  ui.start.disabled=true;
  setStatus("Whisper 준비 중","busy","첫 실행이라면 모델을 내려받습니다.");

  try{
    await initModelIfNeeded();
    setStatus("공유할 LMS 탭을 선택하세요","busy","Chrome 탭 / Whale 탭에서 실제 LMS 강의 탭을 선택하세요.");

    displayStream=await navigator.mediaDevices.getDisplayMedia({
      video:true,audio:true,preferCurrentTab:false,selfBrowserSurface:"exclude",
      surfaceSwitching:"include",systemAudio:"include"
    });

    const audioTracks=displayStream.getAudioTracks();
    if(!audioTracks.length){
      displayStream.getTracks().forEach(t=>t.stop()); displayStream=null;
      throw new Error("오디오 트랙이 전달되지 않았습니다.\n\n공유 창에서 'Chrome 탭' 또는 'Whale 탭'을 선택하고 실제 LMS 강의 탭을 고르세요. 오디오 공유 옵션이 보이면 켜주세요.");
    }

    audioContext=new AudioContext();
    await audioContext.resume();
    sampleRate=audioContext.sampleRate;
    const audioOnly=new MediaStream(audioTracks);
    sourceNode=audioContext.createMediaStreamSource(audioOnly);
    processor=audioContext.createScriptProcessor(4096,2,1);
    muteNode=audioContext.createGain(); muteNode.gain.value=0;

    processor.onaudioprocess=(event)=>{
      const input=event.inputBuffer, frames=input.length, channels=input.numberOfChannels;
      const mono=new Float32Array(frames);
      let sumSq=0;
      for(let ch=0;ch<channels;ch++){
        const d=input.getChannelData(ch);
        for(let i=0;i<frames;i++) mono[i]+=d[i]/channels;
      }
      for(let i=0;i<frames;i++) sumSq+=mono[i]*mono[i];
      const rms=Math.sqrt(sumSq/Math.max(1,frames));
      updateMeter(rms);

      if(!capturing || paused)return;
      appendBuffer(mono);
      capturedSeconds += mono.length/sampleRate;
      flushReadyWindows();
    };

    sourceNode.connect(processor); processor.connect(muteNode); muteNode.connect(audioContext.destination);

    const ended=()=>{if(capturing)stopCapture();};
    audioTracks[0].addEventListener("ended",ended,{once:true});
    displayStream.getVideoTracks()[0]?.addEventListener("ended",ended,{once:true});

    // New recording session: preserve title/week but clear prior transcript.
    segments=[];markers=[];buffers=[];bufferedSamples=0;nextWindowStartSec=0;capturedSeconds=0;
    segmentSeq=0;inflight=0;lastAudio=null;lastAudioMeta=null;
    sessionStartedAt=new Date().toISOString();
    ui.restore.style.display="none";

    capturing=true;paused=false;stopping=false;
    ui.pause.textContent="Pause";
    setControlState();
    startTimer();

    setStatus("녹음·전사 중","ready",`오디오 ${Math.round(sampleRate/1000)} kHz · ${CHUNK_SEC}초 구간 / ${OVERLAP_SEC}초 겹침`);
    ui.audioText.textContent="감지 중";
    updateAll();
  }catch(err){
    cleanupCapture();capturing=false;paused=false;stopping=false;setControlState();
    setStatus("시작하지 못했습니다","error");
    showError(err.message||String(err));
  }
}

function togglePause(){
  if(!capturing || stopping)return;
  paused=!paused;
  ui.pause.textContent=paused?"Resume":"Pause";
  if(paused){
    setStatus("일시정지","busy","오디오 공유는 유지되지만 전사용 녹음은 멈춥니다.");
    ui.audioText.textContent="일시정지";
  }else{
    setStatus("녹음·전사 중","ready",`오디오 ${Math.round(sampleRate/1000)} kHz · ${CHUNK_SEC}초 구간 / ${OVERLAP_SEC}초 겹침`);
  }
  setControlState();
}

async function stopCapture(){
  if(!capturing || stopping)return;
  capturing=false;paused=false;stopping=true;
  setControlState();
  setStatus("마지막 오디오 처리 중","busy","남은 구간의 전사를 완료합니다.");

  const remaining=bufferedSamples;
  if(remaining>=sampleRate){
    const audio=takeSamples(remaining);
    const start=nextWindowStartSec;
    const end=start+audio.length/sampleRate;
    queueTranscription(audio,start,end,false,null,0);
  }else{buffers=[];bufferedSamples=0;}

  cleanupCapture();
  stopTimer();
  if(inflight===0)finishStop();
}

function cleanupCapture(){
  try{processor?.disconnect();}catch{}
  try{sourceNode?.disconnect();}catch{}
  try{muteNode?.disconnect();}catch{}
  try{displayStream?.getTracks().forEach(t=>t.stop());}catch{}
  try{if(audioContext && audioContext.state!=="closed")audioContext.close();}catch{}
  processor=null;sourceNode=null;muteNode=null;displayStream=null;audioContext=null;
  updateMeter(0);
}
function finishStop(){
  stopping=false;
  setControlState();
  setStatus("정지됨","ready","TXT / SRT / AI 교정용 파일로 저장할 수 있습니다.");
  ui.audioText.textContent="정지";
  updateAll();
}
function setControlState(){
  ui.start.disabled = capturing || stopping;
  ui.pause.disabled = !capturing || stopping;
  ui.stop.disabled = !capturing || stopping;
  ui.bookmark.disabled = !capturing;
  ui.unclear.disabled = !capturing;
  ui.memo.disabled = !capturing;
  ui.retry.disabled = !lastAudio || inflight>0 || !workerReady;
}
function updateMeter(rms){
  const pct=Math.min(100,Math.max(0,rms*520));
  ui.meter.style.width=pct+"%";
  if(!capturing){ if(!stopping)ui.audioText.textContent="대기"; return; }
  if(paused)return;
  ui.audioText.textContent = pct>3 ? "Audio OK" : "낮은 음량";
}
function startTimer(){
  stopTimer();
  timerHandle=setInterval(()=>{ui.timer.textContent=fmtTime(capturedSeconds);},250);
}
function stopTimer(){if(timerHandle){clearInterval(timerHandle);timerHandle=null;}ui.timer.textContent=fmtTime(capturedSeconds);}

function retryLast(){
  if(!lastAudio || !lastAudioMeta || inflight>0)return;
  clearError();
  setStatus("마지막 구간 재전사","busy",`[${fmtTime(lastAudioMeta.start)}] 구간을 더 강한 반복 억제로 다시 처리합니다.`);
  queueTranscription(lastAudio,lastAudioMeta.start,lastAudioMeta.end,true,lastAudioMeta.id,2);
}

function downloadBlob(content,filename,type="text/plain;charset=utf-8"){
  const blob=new Blob(["\uFEFF",content],{type});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=filename;
  document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000);
}
function cleanDocument(){return `${headerText()}\n\n${"─".repeat(36)}\n\n${buildTimeline(true)}\n`;}
function rawDocument(){return `${headerText()}\n\n${"─".repeat(36)}\n\n${buildTimeline(false)}\n`;}

function srtTime(sec){
  const ms=Math.max(0,Math.round(sec*1000));
  const h=String(Math.floor(ms/3600000)).padStart(2,"0");
  const m=String(Math.floor((ms%3600000)/60000)).padStart(2,"0");
  const s=String(Math.floor((ms%60000)/1000)).padStart(2,"0");
  const x=String(ms%1000).padStart(3,"0");
  return `${h}:${m}:${s},${x}`;
}
function makeSRT(){
  let idx=1, out=[];
  for(const s of segments.filter(x=>x.clean?.trim())){
    out.push(String(idx++),`${srtTime(s.start)} --> ${srtTime(Math.max(s.start+1,s.end))}`,s.clean.trim(),"");
  }
  return out.join("\n");
}
function makeAIExport(){
  const title=ui.title.value.trim()||"제목 없음";
  const week=ui.week.value.trim();
  return `# Hanyang LMS Whisper — AI 교정용 전사본

## 강의 정보
- 강의 제목: ${title}
${week?`- 주차: ${week}주차\n`:""}- 날짜: ${dateStamp()}

## 교정 지침
아래 텍스트는 대학 강의를 Whisper로 자동 전사한 결과입니다.
내용을 요약하거나 새로운 정보를 추가하지 말고, 음성인식 오류로 판단되는 부분만 문맥에 따라 최소한으로 교정하세요.
교수의 문장 구조와 의미를 가능한 한 유지하세요.
고유명사·영화 제목·인명·전문용어는 강의 전체 문맥을 활용해 교정하세요.
확신할 수 없는 부분은 임의로 창작하지 말고 [불명확: 원문] 형태로 남기세요.
반복 환각과 명백한 중복만 제거하세요.
'★ 중요', '? 확인 필요', '메모' 표시는 그대로 유지하세요.

## CLEAN TRANSCRIPT
${buildTimeline(true)}

## RAW TRANSCRIPT
${buildTimeline(false)}
`;
}
async function copyClean(){
  try{await navigator.clipboard.writeText(cleanDocument());ui.meta.textContent="CLEAN 전사문을 클립보드에 복사했습니다.";}
  catch(e){showError("클립보드 복사 실패: "+e.message);}
}
function diagnostics(){
  const lines=[
    "Hanyang LMS Whisper Web v1.1 진단","",
    `HTTPS secure context: ${window.isSecureContext?"YES":"NO"}`,
    `getDisplayMedia: ${navigator.mediaDevices?.getDisplayMedia?"YES":"NO"}`,
    `WebGPU: ${navigator.gpu?"YES":"NO"}`,
    `Whisper worker: ${workerReady?"READY":(modelLoading?"LOADING":"NOT READY")}`,
    `Model: onnx-community/whisper-small`,
    `현재 구간: ${rawCount()}`,
    `반복 의심 구간: ${suspiciousCount()}`,
    `Browser: ${navigator.userAgent}`
  ];
  alert(lines.join("\n"));
}

ui.start.addEventListener("click",startCapture);
ui.pause.addEventListener("click",togglePause);
ui.stop.addEventListener("click",stopCapture);
ui.retry.addEventListener("click",retryLast);
ui.bookmark.addEventListener("click",()=>addMarker("bookmark"));
ui.unclear.addEventListener("click",()=>addMarker("unclear"));
ui.memo.addEventListener("click",()=>addMarker("memo"));
ui.clear.addEventListener("click",clearSession);
ui.diag.addEventListener("click",diagnostics);
ui.title.addEventListener("input",persistPrefs);
ui.week.addEventListener("input",persistPrefs);

ui.cleanTab.addEventListener("click",()=>{activeTab="clean";ui.cleanTab.classList.add("active");ui.rawTab.classList.remove("active");render();});
ui.rawTab.addEventListener("click",()=>{activeTab="raw";ui.rawTab.classList.add("active");ui.cleanTab.classList.remove("active");render();});

ui.txt.addEventListener("click",()=>downloadBlob(cleanDocument(),`${baseFilename()}_CLEAN.txt`));
ui.rawTxt.addEventListener("click",()=>downloadBlob(rawDocument(),`${baseFilename()}_RAW.txt`));
ui.srt.addEventListener("click",()=>downloadBlob(makeSRT(),`${baseFilename()}.srt`,"application/x-subrip;charset=utf-8"));
ui.ai.addEventListener("click",()=>downloadBlob(makeAIExport(),`${baseFilename()}_AI교정용.md`,"text/markdown;charset=utf-8"));
ui.copy.addEventListener("click",copyClean);

window.addEventListener("beforeunload",()=>{saveSession();cleanupCapture();});
if("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{});

restoreSession();
setControlState();
render();
setStatus("준비됨","ready",navigator.gpu?"WebGPU 사용 가능 · Start 시 Whisper small을 준비합니다.":"WebGPU 없음 · WASM CPU 모드로 실행됩니다.");
