const VERSION = "1.2.0";
const CHUNK_SEC = 22;
const OVERLAP_SEC = 2;
const STEP_SEC = CHUNK_SEC - OVERLAP_SEC;
const MIN_FINAL_SEC = 3;

const $ = (id) => document.getElementById(id);
const ui = {
  start: $("startBtn"), stop: $("stopBtn"), unclear: $("unclearBtn"), memo: $("memoBtn"), newLecture: $("newBtn"),
  ai: $("aiBtn"), cleanTxt: $("cleanTxtBtn"), rawTxt: $("rawTxtBtn"),
  cleanTab: $("cleanTab"), rawTab: $("rawTab"), cleanBadge: $("cleanBadge"), rawBadge: $("rawBadge"),
  transcript: $("transcript"), summary: $("summaryLine"), status: $("status"), detail: $("detail"), dot: $("dot"),
  progress: $("progressBar"), meter: $("audioMeter"), audioText: $("audioText"), modelPill: $("modelPill"),
  error: $("errorBox"), timer: $("timer"), title: $("lectureTitle"), week: $("lectureWeek"), speed: $("playbackSpeed"),
  language: $("languageSelect"), diagnostics: $("diagnostics"), readyChip: $("readyChip"), advanced: $("advancedDetails"),
  memoDialog: $("memoDialog"), memoForm: $("memoForm"), memoInput: $("memoInput"), memoTarget: $("memoTarget")
};

let smallWorker = null;
let mediumWorker = null;
let smallReady = false;
let smallLoading = false;
let smallFailed = false;
let smallDevice = null;
let mediumReady = false;
let mediumLoading = false;
let mediumFailed = false;
let mediumDevice = null;
let mediumProgress = 0;
let smallProgress = 0;

let displayStream = null;
let audioContext = null;
let sourceNode = null;
let processor = null;
let muteNode = null;
let sampleRate = 48000;
let buffers = [];
let bufferedSamples = 0;
let capturedSeconds = 0;
let nextWindowStartSec = 0;
let timerHandle = null;
let capturing = false;
let stopping = false;
let finalized = false;
let activeTab = "clean";
let sessionStartedAt = null;
let chunkSeq = 0;
let smallInflight = 0;
let mediumInflight = 0;
let skippedSilence = 0;
let memoTargetStart = null;

const chunks = [];
const chunksById = new Map();
const chunksByStart = new Map();
const audioCache = new Map();
const mediumPending = new Set();

function setStatus(text, kind = "busy", detail = "") {
  ui.status.textContent = text;
  ui.detail.textContent = detail;
  ui.dot.className = `dot ${kind}`;
}
function showError(message) {
  ui.error.style.display = "block";
  ui.error.textContent = message;
}
function clearError() {
  ui.error.style.display = "none";
  ui.error.textContent = "";
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
function fmtRange(start, end) {
  return `${fmtTime(start)}–${fmtTime(end)}`;
}
function normalizeProgress(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n <= 1 ? n * 100 : n));
}
function sanitizeFilename(value) {
  return (value || "Lecture")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "Lecture";
}
function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function weekLabel() {
  const value = ui.week.value.trim();
  if (!value) return "";
  return /주차$/.test(value) ? value : `${value}주차`;
}
function baseFilename() {
  const title = sanitizeFilename(ui.title.value.trim() || "Lecture");
  const week = sanitizeFilename(weekLabel());
  return week ? `${title}_${week}_${dateStamp()}` : `${title}_${dateStamp()}`;
}
function languageLabel() {
  return ui.language.value === "ko" ? "한국어" : ui.language.value === "en" ? "영어" : "자동 감지";
}
function playbackSpeed() {
  return Number(ui.speed.value) || 1;
}
function sourceTimeApprox(captureSec) {
  return captureSec * playbackSpeed();
}
function chunkKey(start) {
  return Number(start).toFixed(3);
}
function getChunkByStart(start) {
  return chunksByStart.get(chunkKey(start));
}
function getOrCreateChunk(start, end = start + CHUNK_SEC) {
  const key = chunkKey(start);
  let chunk = chunksByStart.get(key);
  if (chunk) {
    chunk.end = Math.max(chunk.end, end);
    return chunk;
  }
  chunk = {
    id: ++chunkSeq,
    start,
    end,
    duration: Math.max(0, end - start),
    state: "pending",
    rawSmall: "",
    cleanSmall: "",
    mediumText: "",
    cleanMedium: "",
    selectedText: "",
    selectedModel: "",
    qualitySmall: null,
    qualityMedium: null,
    vad: null,
    userReview: false,
    notes: [],
    autoReview: false,
    mediumRequested: false,
    mediumStatus: "none",
    unresolved: false,
    mediumError: "",
    skipped: false,
    overlapTrimmed: false,
  };
  chunks.push(chunk);
  chunksByStart.set(key, chunk);
  chunksById.set(chunk.id, chunk);
  chunks.sort((a, b) => a.start - b.start);
  return chunk;
}
function currentChunkStart() {
  const t = Math.max(0, capturedSeconds - 0.001);
  return Math.max(0, Math.floor(t / STEP_SEC) * STEP_SEC);
}
function currentChunk() {
  const start = currentChunkStart();
  return getOrCreateChunk(start, start + CHUNK_SEC);
}
function resetSession() {
  chunks.length = 0;
  chunksById.clear();
  chunksByStart.clear();
  audioCache.clear();
  mediumPending.clear();
  buffers = [];
  bufferedSamples = 0;
  capturedSeconds = 0;
  nextWindowStartSec = 0;
  chunkSeq = 0;
  smallInflight = 0;
  mediumInflight = 0;
  skippedSilence = 0;
  finalized = false;
  sessionStartedAt = null;
  ui.readyChip.style.display = "none";
  render();
}

function appendBuffer(data) {
  buffers.push(data);
  bufferedSamples += data.length;
}
function takeSamples(count) {
  const out = new Float32Array(count);
  let written = 0;
  while (written < count && buffers.length) {
    const first = buffers[0];
    const need = count - written;
    if (first.length <= need) {
      out.set(first, written);
      written += first.length;
      buffers.shift();
      bufferedSamples -= first.length;
    } else {
      out.set(first.subarray(0, need), written);
      buffers[0] = first.slice(need);
      bufferedSamples -= need;
      written += need;
    }
  }
  return out;
}
function prependBuffer(data) {
  buffers.unshift(data);
  bufferedSamples += data.length;
}

function analyzeAudio(audio, rate) {
  const frameSize = Math.max(1, Math.round(rate * 0.02));
  const rmsFrames = [];
  let overallSq = 0;
  let peakSample = 0;
  for (let i = 0; i < audio.length; i += frameSize) {
    const end = Math.min(audio.length, i + frameSize);
    let sq = 0;
    for (let j = i; j < end; j++) {
      const v = audio[j];
      sq += v * v;
      overallSq += v * v;
      peakSample = Math.max(peakSample, Math.abs(v));
    }
    rmsFrames.push(Math.sqrt(sq / Math.max(1, end - i)));
  }
  const meanRms = Math.sqrt(overallSq / Math.max(1, audio.length));
  const sorted = [...rmsFrames].sort((a, b) => a - b);
  const noiseFloor = sorted.length ? sorted[Math.floor(sorted.length * 0.2)] : 0;
  const peakRms = rmsFrames.length ? Math.max(...rmsFrames) : 0;
  const threshold = Math.max(0.0015, noiseFloor * 2.5, peakRms * 0.08);
  const speechFrames = rmsFrames.filter((v) => v > threshold).length;
  const speechRatio = rmsFrames.length ? speechFrames / rmsFrames.length : 0;
  const nearSilence = peakSample < 0.006 || (meanRms < 0.0012 && speechRatio < 0.03);
  return { meanRms, peakRms, peakSample, noiseFloor, threshold, speechRatio, nearSilence };
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}
function tokenNorm(token) {
  return token.toLowerCase().replace(/[.,!?;:'"“”‘’()[\]{}<>·…。、！？]/g, "");
}
function consecutiveLoopInfo(words) {
  let best = { n: 0, repeats: 0, start: -1 };
  const maxN = Math.min(12, Math.floor(words.length / 3));
  for (let n = maxN; n >= 2; n--) {
    for (let i = 0; i + n * 3 <= words.length; i++) {
      const base = words.slice(i, i + n).map(tokenNorm).join(" ");
      if (!base.trim()) continue;
      let repeats = 1;
      while (i + n * (repeats + 1) <= words.length) {
        const next = words.slice(i + n * repeats, i + n * (repeats + 1)).map(tokenNorm).join(" ");
        if (next !== base) break;
        repeats++;
      }
      if (repeats >= 3 && n * repeats > best.n * best.repeats) best = { n, repeats, start: i };
    }
  }
  return best;
}
function qualityReport(text, vad, duration) {
  const t = normalizeText(text);
  const words = t ? t.split(" ") : [];
  const normalizedWords = words.map(tokenNorm).filter(Boolean);
  const chars = t.replace(/\s/g, "").length;
  const cps = chars / Math.max(1, duration || 1);
  const uniqueRatio = normalizedWords.length ? new Set(normalizedWords).size / normalizedWords.length : 1;
  let maxSameRun = 1;
  let run = 1;
  for (let i = 1; i < normalizedWords.length; i++) {
    if (normalizedWords[i] && normalizedWords[i] === normalizedWords[i - 1]) {
      run++;
      maxSameRun = Math.max(maxSameRun, run);
    } else run = 1;
  }
  const loop = consecutiveLoopInfo(words);
  const reasons = [];
  let score = 0;
  if (maxSameRun >= 4) { reasons.push(`같은 단어 ${maxSameRun}회 반복`); score += 5; }
  if (loop.repeats >= 3 && loop.n >= 2) { reasons.push(`${loop.n}단어 구문 ${loop.repeats}회 반복`); score += 7; }
  if (normalizedWords.length >= 20 && uniqueRatio < 0.28) { reasons.push("어휘 반복률 과다"); score += 3; }
  if (duration >= 5 && cps > 16) { reasons.push(`비정상적으로 긴 출력(${cps.toFixed(1)}자/초)`); score += cps > 22 ? 5 : 2; }
  if (vad?.nearSilence && chars > 15) { reasons.push("무음 대비 과도한 텍스트"); score += 6; }
  if (!vad?.nearSilence && (vad?.speechRatio ?? 0) > 0.18 && chars < 3) { reasons.push("발화 대비 전사 누락 의심"); score += 4; }
  return { suspicious: score >= 4, score, reasons, chars, cps, uniqueRatio, maxSameRun, loop };
}

function collapseObviousLoops(text) {
  const original = normalizeText(text);
  if (!original) return "";
  let words = original.split(" ");
  let changed = true;
  let passes = 0;
  while (changed && passes < 4) {
    changed = false;
    passes++;
    const out = [];
    for (let i = 0; i < words.length;) {
      let collapsed = false;
      const maxN = Math.min(12, Math.floor((words.length - i) / 3));
      for (let n = maxN; n >= 2; n--) {
        const base = words.slice(i, i + n).map(tokenNorm).join(" ");
        if (!base.trim()) continue;
        let repeats = 1;
        while (i + n * (repeats + 1) <= words.length) {
          const next = words.slice(i + n * repeats, i + n * (repeats + 1)).map(tokenNorm).join(" ");
          if (next !== base) break;
          repeats++;
        }
        if (repeats >= 3) {
          out.push(...words.slice(i, i + n));
          i += n * repeats;
          changed = true;
          collapsed = true;
          break;
        }
      }
      if (!collapsed) {
        let same = 1;
        while (i + same < words.length && tokenNorm(words[i + same]) === tokenNorm(words[i]) && tokenNorm(words[i])) same++;
        if (same >= 4) {
          out.push(words[i]);
          i += same;
          changed = true;
        } else {
          out.push(words[i]);
          i++;
        }
      }
    }
    words = out;
  }
  return words.join(" ").replace(/([.!?。！？])\1{1,}/g, "$1").replace(/\s+/g, " ").trim();
}
function safeClean(text, quality) {
  let t = normalizeText(text).replace(/([.!?。！？])\1{1,}/g, "$1");
  if (!t) return "";
  if (quality?.suspicious) t = collapseObviousLoops(t);
  return normalizeText(t);
}
function tokenSimilarity(a, b) {
  const A = new Set(normalizeText(a).split(" ").map(tokenNorm).filter(Boolean));
  const B = new Set(normalizeText(b).split(" ").map(tokenNorm).filter(Boolean));
  if (!A.size && !B.size) return 1;
  if (!A.size || !B.size) return 0;
  let intersection = 0;
  for (const token of A) if (B.has(token)) intersection++;
  return intersection / (A.size + B.size - intersection);
}
function removeBoundaryOverlap(previous, current) {
  const p = normalizeText(previous);
  const c = normalizeText(current);
  if (!p || !c) return c;
  const pWords = p.split(" ");
  const cWords = c.split(" ");
  const max = Math.min(24, pWords.length, cWords.length);
  for (let k = max; k >= 2; k--) {
    const left = pWords.slice(-k).map(tokenNorm).join(" ");
    const right = cWords.slice(0, k).map(tokenNorm).join(" ");
    const meaningful = left.replace(/\s/g, "").length >= 8;
    if (meaningful && left === right) return cWords.slice(k).join(" ").trim();
  }
  return c;
}

function chooseCandidate(chunk) {
  const small = chunk.cleanSmall;
  const medium = chunk.cleanMedium;
  const sq = chunk.qualitySmall || { suspicious: true, score: 99 };
  const mq = chunk.qualityMedium || { suspicious: true, score: 99 };
  chunk.unresolved = false;

  if (!medium) {
    chunk.selectedText = small;
    chunk.selectedModel = "small";
    if (chunk.mediumRequested) chunk.unresolved = true;
    return;
  }
  if (!small) {
    chunk.selectedText = medium;
    chunk.selectedModel = "medium";
    return;
  }

  const similarity = tokenSimilarity(small, medium);
  chunk.modelSimilarity = similarity;
  if (sq.suspicious && !mq.suspicious) {
    chunk.selectedText = medium; chunk.selectedModel = "medium"; return;
  }
  if (!sq.suspicious && mq.suspicious) {
    chunk.selectedText = small; chunk.selectedModel = "small"; return;
  }
  if (sq.suspicious && mq.suspicious) {
    chunk.unresolved = true;
    chunk.selectedText = mq.score < sq.score ? medium : small;
    chunk.selectedModel = mq.score < sq.score ? "medium" : "small";
    return;
  }
  if ((chunk.userReview && similarity < 0.50) || similarity < 0.36) {
    chunk.unresolved = true;
    chunk.selectedText = mq.score <= sq.score ? medium : small;
    chunk.selectedModel = mq.score <= sq.score ? "medium" : "small";
    return;
  }
  if (mq.score <= sq.score + 1) {
    chunk.selectedText = medium;
    chunk.selectedModel = "medium";
  } else {
    chunk.selectedText = small;
    chunk.selectedModel = "small";
  }
}

function renderChunkClean(chunk, previousText) {
  const flags = [];
  if (chunk.userReview) flags.push("❓ 확인 필요");
  if (chunk.autoReview) flags.push("자동 이상 감지");
  if (chunk.mediumStatus === "done") flags.push("medium 검증");
  if (chunk.unresolved) flags.push("⚠ 후보 충돌");
  const header = `[${fmtRange(chunk.start, chunk.end)}]${flags.length ? `  ${flags.join(" · ")}` : ""}`;
  const noteText = chunk.notes.map((n) => `📝 ${n}`).join("\n");

  if (chunk.skipped) {
    return noteText ? `${header}\n${noteText}\n[무음 구간 — 전사 생략]` : "";
  }
  if (chunk.state === "pending") {
    return `${header}\n${noteText ? `${noteText}\n` : ""}[현재 chunk 수집 중]`;
  }
  if (chunk.state === "small_inflight" || chunk.state === "queued") {
    return `${header}\n${noteText ? `${noteText}\n` : ""}[전사 처리 중]`;
  }
  if (chunk.mediumRequested && ["waiting", "loading", "inflight"].includes(chunk.mediumStatus)) {
    return `${header}\n${noteText ? `${noteText}\n` : ""}[전사 이상/확인 요청 — medium 재검증 중. small 원문은 RAW 탭에서 확인]`;
  }
  if (chunk.unresolved && chunk.mediumText) {
    const small = chunk.cleanSmall || "[빈 결과]";
    const medium = chunk.cleanMedium || "[빈 결과]";
    return `${header}\n${noteText ? `${noteText}\n` : ""}SMALL 후보: ${small}\nMEDIUM 후보: ${medium}`;
  }
  if (chunk.unresolved && chunk.mediumError) {
    const small = chunk.cleanSmall || "[빈 결과]";
    return `${header}\n${noteText ? `${noteText}\n` : ""}⚠ medium 검증 실패: ${chunk.mediumError}\nSMALL 후보: ${small}`;
  }
  let text = chunk.selectedText || chunk.cleanSmall || "";
  if (text && previousText) text = removeBoundaryOverlap(previousText, text);
  if (!text && !noteText) return "";
  return `${header}\n${noteText ? `${noteText}\n` : ""}${text || "[전사 텍스트 없음]"}`;
}
function buildCleanTimeline() {
  const blocks = [];
  let previous = "";
  for (const chunk of [...chunks].sort((a, b) => a.start - b.start)) {
    const block = renderChunkClean(chunk, previous);
    if (block) blocks.push(block);
    if (!chunk.unresolved && chunk.selectedText) previous = chunk.selectedText;
  }
  return blocks.join("\n\n");
}
function buildRawTimeline() {
  const blocks = [];
  for (const chunk of [...chunks].sort((a, b) => a.start - b.start)) {
    if (!chunk.rawSmall && !chunk.notes.length && !chunk.userReview) continue;
    const flags = [];
    if (chunk.userReview) flags.push("❓ 확인 필요");
    if (chunk.qualitySmall?.suspicious) flags.push("⚠ small 이상 감지");
    const header = `[${fmtRange(chunk.start, chunk.end)}]${flags.length ? `  ${flags.join(" · ")}` : ""}`;
    const notes = chunk.notes.map((n) => `📝 ${n}`).join("\n");
    blocks.push(`${header}\n${notes ? `${notes}\n` : ""}${chunk.rawSmall || "[small 결과 없음]"}`);
  }
  return blocks.join("\n\n");
}
function counts() {
  const processed = chunks.filter((c) => !!c.rawSmall).length;
  const reviewed = chunks.filter((c) => c.mediumStatus === "done").length;
  const unresolved = chunks.filter((c) => c.unresolved).length;
  const userReview = chunks.filter((c) => c.userReview).length;
  const notes = chunks.reduce((sum, c) => sum + c.notes.length, 0);
  return { processed, reviewed, unresolved, userReview, notes };
}
function render() {
  const c = counts();
  const text = activeTab === "clean" ? buildCleanTimeline() : buildRawTimeline();
  ui.transcript.textContent = text || "전사된 내용이 여기에 나타납니다.";
  ui.cleanBadge.textContent = String(c.processed);
  ui.rawBadge.textContent = String(c.processed);
  const queueCount = smallInflight + mediumInflight + mediumPending.size;
  ui.summary.textContent = `처리 ${c.processed}구간 · medium 검증 ${c.reviewed} · 미확정 ${c.unresolved} · 사용자 확인 ${c.userReview} · 메모 ${c.notes} · VAD 생략 ${skippedSilence}${queueCount ? ` · 처리 대기 ${queueCount}` : ""}`;
  const downloadable = finalized && c.processed > 0;
  ui.ai.disabled = !downloadable;
  ui.cleanTxt.disabled = !downloadable;
  ui.rawTxt.disabled = !downloadable;
  ui.readyChip.style.display = downloadable ? "inline-block" : "none";
  updateDiagnostics();
}

function updateModelPill() {
  const small = smallReady ? `small ${smallDevice?.toUpperCase() || "READY"}` : smallLoading ? "small 로딩" : smallFailed ? "small 오류" : "small 대기";
  const medium = mediumReady ? `medium ${mediumDevice?.toUpperCase() || "READY"}` : mediumLoading ? "medium 로딩" : mediumFailed ? "medium 사용 불가" : "medium 필요 시 로드";
  ui.modelPill.textContent = `${small} · ${medium}`;
}
function updateDiagnostics() {
  const c = counts();
  ui.diagnostics.textContent = [
    `Lecture Transcriber v${VERSION}`,
    `Secure context : ${window.isSecureContext ? "YES" : "NO"}`,
    `getDisplayMedia: ${navigator.mediaDevices?.getDisplayMedia ? "YES" : "NO"}`,
    `WebGPU          : ${navigator.gpu ? "YES" : "NO"}`,
    `small           : ${smallReady ? `READY / ${smallDevice}` : smallLoading ? `LOADING ${Math.round(smallProgress)}%` : smallFailed ? "ERROR" : "NOT LOADED"}`,
    `medium          : ${mediumReady ? `READY / ${mediumDevice}` : mediumLoading ? `LOADING ${Math.round(mediumProgress)}%` : mediumFailed ? "UNAVAILABLE" : "ON-DEMAND"}`,
    `capture         : ${capturing ? "RUNNING" : stopping ? "FINALIZING" : "STOPPED"}`,
    `sample rate     : ${Math.round(sampleRate)} Hz`,
    `chunk / overlap : ${CHUNK_SEC}s / ${OVERLAP_SEC}s`,
    `playback speed  : ${playbackSpeed()}x`,
    `language        : ${languageLabel()}`,
    `processed       : ${c.processed}`,
    `small inflight  : ${smallInflight}`,
    `medium pending  : ${mediumPending.size}`,
    `medium inflight : ${mediumInflight}`,
    `VAD skipped     : ${skippedSilence}`,
    `unresolved      : ${c.unresolved}`,
    `browser         : ${navigator.userAgent}`,
  ].join("\n");
  updateModelPill();
}
function updateMeter(rms) {
  const pct = Math.max(0, Math.min(100, rms * 520));
  ui.meter.style.width = `${pct}%`;
  if (!capturing) {
    if (!stopping) ui.audioText.textContent = "대기";
    return;
  }
  ui.audioText.textContent = pct > 3 ? "Audio OK" : "낮은 음량";
}
function startTimer() {
  stopTimer();
  timerHandle = setInterval(() => {
    ui.timer.textContent = fmtTime(capturedSeconds);
    updateDiagnostics();
  }, 250);
}
function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
  ui.timer.textContent = fmtTime(capturedSeconds);
}
function setControlState() {
  ui.start.disabled = capturing || stopping;
  ui.stop.disabled = !capturing || stopping;
  ui.unclear.disabled = !capturing || stopping;
  ui.memo.disabled = !capturing || stopping;
  ui.newLecture.disabled = capturing || stopping;
  ui.title.disabled = capturing || stopping;
  ui.week.disabled = capturing || stopping;
  ui.speed.disabled = capturing || stopping;
  ui.language.disabled = capturing || stopping;
}

function ensureSmallWorker() {
  if (smallWorker) return;
  smallWorker = new Worker("./small-worker.js?v=1.2.0", { type: "module" });
  smallWorker.onmessage = (event) => {
    const m = event.data || {};
    if (m.type === "progress") {
      smallLoading = true;
      smallProgress = normalizeProgress(m.progress);
      ui.progress.style.width = `${smallProgress}%`;
      setStatus("Whisper small 준비 중", "busy", m.file ? `${m.file} · ${Math.round(smallProgress)}%` : "첫 실행은 모델 다운로드로 시간이 걸릴 수 있습니다.");
      updateDiagnostics();
      return;
    }
    if (m.type === "fallback") {
      setStatus("WebGPU → WASM 전환", "busy", "small 모델의 WebGPU 초기화가 실패해 CPU/WASM으로 다시 준비합니다.");
      return;
    }
    if (m.type === "ready") {
      smallReady = true; smallLoading = false; smallFailed = false; smallDevice = m.device;
      ui.progress.style.width = "100%";
      updateDiagnostics();
      return;
    }
    if (m.type === "result") {
      handleSmallResult(m);
      return;
    }
    if (m.type === "error") {
      if (m.id != null) handleSmallError(m);
      else {
        smallFailed = true; smallLoading = false;
        showError(m.message || "Whisper small 모델 준비에 실패했습니다.");
        setStatus("Whisper small 오류", "error", "고급 설정 · 진단을 확인하세요.");
      }
      updateDiagnostics();
    }
  };
  smallWorker.onerror = (event) => {
    smallFailed = true;
    showError(`small worker 오류: ${event.message || "알 수 없는 오류"}`);
    setStatus("Whisper small 오류", "error");
  };
}
function waitUntil(test, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const handle = setInterval(() => {
      if (test()) { clearInterval(handle); resolve(); }
      else if (Date.now() - started > timeoutMs) { clearInterval(handle); reject(new Error("모델 준비 시간 초과")); }
    }, 250);
  });
}
async function initSmall() {
  ensureSmallWorker();
  if (smallReady) return;
  if (!smallLoading) {
    smallLoading = true; smallFailed = false; smallProgress = 1;
    ui.progress.style.width = "1%";
    smallWorker.postMessage({ type: "init", device: navigator.gpu ? "webgpu" : "wasm" });
  }
  await waitUntil(() => smallReady || smallFailed, 8 * 60 * 1000);
  if (!smallReady) throw new Error("Whisper small 모델을 준비하지 못했습니다.");
}

function ensureMediumWorker() {
  if (mediumWorker) return;
  mediumWorker = new Worker("./medium-worker.js?v=1.2.0", { type: "module" });
  mediumWorker.onmessage = (event) => {
    const m = event.data || {};
    if (m.type === "progress") {
      mediumLoading = true;
      mediumProgress = normalizeProgress(m.progress);
      ui.progress.style.width = `${mediumProgress}%`;
      if (capturing) setStatus("전사 중 · medium 준비", "busy", `이상/확인 구간 재검증 모델 로딩 ${Math.round(mediumProgress)}%`);
      else if (stopping) setStatus("마무리 중 · medium 준비", "busy", `재검증 모델 로딩 ${Math.round(mediumProgress)}%`);
      updateDiagnostics();
      return;
    }
    if (m.type === "ready") {
      mediumReady = true; mediumLoading = false; mediumFailed = false; mediumDevice = m.device;
      ui.progress.style.width = "100%";
      dispatchPendingMedium();
      updateDiagnostics();
      renderCaptureStatus();
      return;
    }
    if (m.type === "result") {
      handleMediumResult(m);
      return;
    }
    if (m.type === "error") {
      if (m.id != null) handleMediumError(m.id, m.message || "medium 전사 실패");
      else failMediumGlobally(m.message || "Whisper medium 모델을 준비하지 못했습니다.");
      return;
    }
  };
  mediumWorker.onerror = (event) => failMediumGlobally(event.message || "medium worker 오류");
}
function requestMedium(chunk) {
  if (!chunk || chunk.mediumRequested && ["waiting", "loading", "inflight", "done"].includes(chunk.mediumStatus)) return;
  chunk.mediumRequested = true;
  if (mediumFailed) {
    chunk.mediumStatus = "error";
    handleMediumError(chunk.id, "medium 모델을 현재 브라우저에서 사용할 수 없습니다.", false);
    return;
  }
  chunk.mediumStatus = mediumReady ? "waiting" : "loading";
  mediumPending.add(chunk.id);
  ensureMediumWorker();
  if (!mediumReady && !mediumLoading && !mediumFailed) {
    mediumLoading = true; mediumProgress = 1;
    mediumWorker.postMessage({ type: "init", device: navigator.gpu ? "webgpu" : "wasm" });
  }
  if (mediumReady) dispatchPendingMedium();
  render();
}
function dispatchPendingMedium() {
  if (!mediumReady || !mediumWorker) return;
  for (const id of [...mediumPending]) {
    const chunk = chunksById.get(id);
    const audio = audioCache.get(id);
    if (!chunk) { mediumPending.delete(id); continue; }
    if (!audio) {
      mediumPending.delete(id);
      handleMediumError(id, "재검증용 오디오가 메모리에 남아 있지 않습니다.");
      continue;
    }
    mediumPending.delete(id);
    chunk.mediumStatus = "inflight";
    mediumInflight++;
    const copy = audio.slice();
    mediumWorker.postMessage({ type: "transcribe", id, audio: copy, sampleRate, language: ui.language.value }, [copy.buffer]);
  }
  render();
}
function failMediumGlobally(message) {
  mediumFailed = true; mediumLoading = false; mediumReady = false;
  for (const id of [...mediumPending]) {
    mediumPending.delete(id);
    handleMediumError(id, message, false);
  }
  for (const chunk of chunks) {
    if (chunk.mediumStatus === "inflight") {
      chunk.mediumStatus = "error";
      chunk.mediumError = message;
      chunk.unresolved = true;
      chunk.state = "done";
    }
  }
  mediumInflight = 0;
  showError(`medium 검증 모델을 사용할 수 없습니다. small 원문은 보존되었습니다.\n${message}`);
  renderCaptureStatus();
  render();
  maybeFinalize();
}

function queueSmall(audio, start, end) {
  if (!smallReady || !audio?.length) return;
  const chunk = getOrCreateChunk(start, end);
  chunk.end = end;
  chunk.duration = Math.max(0.1, end - start);
  chunk.vad = analyzeAudio(audio, sampleRate);
  const force = chunk.userReview || chunk.notes.length > 0;
  if (chunk.vad.nearSilence && !force) {
    chunk.skipped = true;
    chunk.state = "done";
    skippedSilence++;
    render();
    maybeFinalize();
    return;
  }
  chunk.state = "small_inflight";
  audioCache.set(chunk.id, audio);
  smallInflight++;
  const copy = audio.slice();
  smallWorker.postMessage({ type: "transcribe", id: chunk.id, audio: copy, sampleRate, language: ui.language.value }, [copy.buffer]);
  render();
}
function handleSmallResult(m) {
  smallInflight = Math.max(0, smallInflight - 1);
  const chunk = chunksById.get(m.id);
  if (!chunk) { maybeFinalize(); return; }
  if (!chunk.rawSmall) chunk.rawSmall = normalizeText(m.text || "");
  chunk.qualitySmall = qualityReport(chunk.rawSmall, chunk.vad, chunk.duration);
  chunk.cleanSmall = safeClean(chunk.rawSmall, chunk.qualitySmall);
  chunk.autoReview = !!chunk.qualitySmall.suspicious;
  if (chunk.userReview || chunk.autoReview) {
    chunk.state = "verify_pending";
    requestMedium(chunk);
  } else {
    chunk.selectedText = chunk.cleanSmall;
    chunk.selectedModel = "small";
    chunk.state = "done";
    audioCache.delete(chunk.id);
  }
  renderCaptureStatus();
  render();
  maybeFinalize();
}
function handleSmallError(m) {
  smallInflight = Math.max(0, smallInflight - 1);
  const chunk = chunksById.get(m.id);
  if (chunk) {
    chunk.state = "done";
    chunk.rawSmall = chunk.rawSmall || "";
    chunk.selectedText = "";
    chunk.unresolved = true;
    audioCache.delete(chunk.id);
  }
  showError(m.message || "small 전사 중 오류가 발생했습니다.");
  render();
  maybeFinalize();
}
function handleMediumResult(m) {
  mediumInflight = Math.max(0, mediumInflight - 1);
  const chunk = chunksById.get(m.id);
  if (!chunk) { maybeFinalize(); return; }
  chunk.mediumText = normalizeText(m.text || "");
  chunk.qualityMedium = qualityReport(chunk.mediumText, chunk.vad, chunk.duration);
  chunk.cleanMedium = safeClean(chunk.mediumText, chunk.qualityMedium);
  chunk.mediumStatus = "done";
  chooseCandidate(chunk);
  chunk.state = "done";
  audioCache.delete(chunk.id);
  renderCaptureStatus();
  render();
  maybeFinalize();
}
function handleMediumError(id, message, decrement = true) {
  if (decrement) mediumInflight = Math.max(0, mediumInflight - 1);
  const chunk = chunksById.get(id);
  if (chunk) {
    chunk.mediumStatus = "error";
    chunk.mediumError = message;
    chunk.unresolved = true;
    chunk.selectedText = chunk.cleanSmall || chunk.rawSmall;
    chunk.selectedModel = "small";
    chunk.state = "done";
    audioCache.delete(id);
  }
  render();
  maybeFinalize();
}

function flushReadyWindows() {
  const windowSamples = Math.floor(sampleRate * CHUNK_SEC);
  const overlapSamples = Math.floor(sampleRate * OVERLAP_SEC);
  while (bufferedSamples >= windowSamples) {
    const audio = takeSamples(windowSamples);
    const start = nextWindowStartSec;
    const end = start + CHUNK_SEC;
    const overlap = audio.slice(Math.max(0, audio.length - overlapSamples));
    prependBuffer(overlap);
    nextWindowStartSec += STEP_SEC;
    queueSmall(audio, start, end);
  }
}

async function startCapture() {
  clearError();
  if (!window.isSecureContext) {
    showError("HTTPS 보안 연결에서 열어야 탭 오디오 공유가 가능합니다. GitHub Pages의 https:// 주소에서 실행해 주세요.");
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    showError("이 브라우저는 탭 오디오 공유를 지원하지 않습니다. 최신 Chrome 또는 Whale을 사용하세요.");
    return;
  }
  if (chunks.some((c) => c.rawSmall || c.notes.length || c.userReview)) {
    const ok = confirm("현재 화면의 전사 기록을 지우고 새 강의를 시작할까요?");
    if (!ok) return;
    resetSession();
  }
  setControlState();
  ui.start.disabled = true;
  setStatus("Whisper small 준비 중", "busy", "첫 실행이면 모델 파일을 내려받습니다.");
  try {
    await initSmall();
    setStatus("공유할 LMS 탭을 선택하세요", "busy", "Chrome/Whale의 '탭' 공유에서 실제 강의 탭을 선택하고 오디오 공유를 켜세요.");
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      systemAudio: "include"
    });
    const audioTracks = displayStream.getAudioTracks();
    if (!audioTracks.length) {
      displayStream.getTracks().forEach((t) => t.stop());
      displayStream = null;
      throw new Error("오디오 트랙이 전달되지 않았습니다. 공유 창에서 LMS '탭'을 선택하고 오디오 공유 옵션을 켜 주세요.");
    }

    resetSession();
    sessionStartedAt = new Date().toISOString();
    audioContext = new AudioContext();
    await audioContext.resume();
    sampleRate = audioContext.sampleRate;
    sourceNode = audioContext.createMediaStreamSource(new MediaStream(audioTracks));
    processor = audioContext.createScriptProcessor(4096, Math.max(1, sourceNode.channelCount || 2), 1);
    muteNode = audioContext.createGain();
    muteNode.gain.value = 0;

    processor.onaudioprocess = (event) => {
      if (!capturing) return;
      const input = event.inputBuffer;
      const frames = input.length;
      const channels = input.numberOfChannels;
      const mono = new Float32Array(frames);
      let sumSq = 0;
      for (let ch = 0; ch < channels; ch++) {
        const data = input.getChannelData(ch);
        for (let i = 0; i < frames; i++) mono[i] += data[i] / channels;
      }
      for (let i = 0; i < frames; i++) sumSq += mono[i] * mono[i];
      const rms = Math.sqrt(sumSq / Math.max(1, frames));
      updateMeter(rms);
      appendBuffer(mono);
      capturedSeconds += mono.length / sampleRate;
      flushReadyWindows();
    };

    sourceNode.connect(processor);
    processor.connect(muteNode);
    muteNode.connect(audioContext.destination);
    const ended = () => { if (capturing) stopCapture(); };
    audioTracks[0].addEventListener("ended", ended, { once: true });
    displayStream.getVideoTracks()[0]?.addEventListener("ended", ended, { once: true });

    capturing = true;
    stopping = false;
    finalized = false;
    setControlState();
    startTimer();
    renderCaptureStatus();
    ui.audioText.textContent = "감지 중";
    render();
  } catch (error) {
    cleanupCapture();
    capturing = false;
    stopping = false;
    setControlState();
    setStatus("시작하지 못했습니다", "error", "오류 내용을 확인하세요.");
    showError(error?.message || String(error));
  }
}

function renderCaptureStatus() {
  if (stopping) {
    const pending = smallInflight + mediumInflight + mediumPending.size;
    setStatus("강의 마무리 중", "busy", pending ? `남은 전사·검증 ${pending}건을 완료하는 중입니다.` : "AI 패키지를 정리하고 있습니다.");
    return;
  }
  if (capturing) {
    if (mediumLoading) setStatus("전사 중 · medium 준비", "busy", "small 전사는 계속 진행됩니다. 이상/확인 구간만 medium으로 재검증합니다.");
    else setStatus("녹음·전사 중", "ready", `${CHUNK_SEC}초 chunk / ${OVERLAP_SEC}초 overlap · ${playbackSpeed()}× 재생 기준`);
    return;
  }
  if (finalized) setStatus("강의 처리 완료", "ready", "AI 교정용 패키지 · CLEAN TXT · RAW TXT를 저장할 수 있습니다.");
}

async function stopCapture() {
  if (!capturing || stopping) return;
  capturing = false;
  stopping = true;
  setControlState();
  stopTimer();
  setStatus("마지막 오디오 처리 중", "busy", "남은 partial chunk까지 전사한 뒤 medium 검증을 마무리합니다.");

  const remaining = bufferedSamples;
  const duration = remaining / Math.max(1, sampleRate);
  const pendingChunk = getChunkByStart(nextWindowStartSec);
  const force = !!pendingChunk && (pendingChunk.userReview || pendingChunk.notes.length > 0);
  if (remaining > 0 && (duration >= MIN_FINAL_SEC || force)) {
    const audio = takeSamples(remaining);
    const start = nextWindowStartSec;
    const end = start + audio.length / sampleRate;
    queueSmall(audio, start, end);
  } else {
    buffers = [];
    bufferedSamples = 0;
  }

  cleanupCapture();
  updateMeter(0);
  ui.audioText.textContent = "정지";
  maybeFinalize();
}
function cleanupCapture() {
  try { processor?.disconnect(); } catch {}
  try { sourceNode?.disconnect(); } catch {}
  try { muteNode?.disconnect(); } catch {}
  try { displayStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (audioContext && audioContext.state !== "closed") audioContext.close(); } catch {}
  processor = null;
  sourceNode = null;
  muteNode = null;
  displayStream = null;
  audioContext = null;
}
function maybeFinalize() {
  if (!stopping) return;
  const hasPendingMediumLoad = mediumLoading && [...chunks].some((c) => c.mediumRequested && ["loading", "waiting"].includes(c.mediumStatus));
  if (smallInflight > 0 || mediumInflight > 0 || mediumPending.size > 0 || hasPendingMediumLoad) {
    renderCaptureStatus();
    return;
  }
  stopping = false;
  finalized = true;
  setControlState();
  renderCaptureStatus();
  render();
}

function flagCurrentForReview() {
  if (!capturing) return;
  const chunk = currentChunk();
  chunk.userReview = true;
  if (chunk.rawSmall) requestMedium(chunk);
  ui.summary.textContent = `[${fmtRange(chunk.start, chunk.end)}] 구간을 확인 필요로 표시했습니다.`;
  render();
}
function openMemoDialog() {
  if (!capturing) return;
  const chunk = currentChunk();
  memoTargetStart = chunk.start;
  ui.memoTarget.textContent = `[${fmtRange(chunk.start, chunk.end)}] chunk에 연결됩니다.`;
  ui.memoInput.value = "";
  ui.memoDialog.showModal();
  setTimeout(() => ui.memoInput.focus(), 0);
}
function saveMemo(event) {
  const submitterValue = event.submitter?.value;
  if (submitterValue === "cancel") return;
  event.preventDefault();
  const note = ui.memoInput.value.trim();
  if (!note || memoTargetStart == null) {
    ui.memoDialog.close();
    return;
  }
  const chunk = getOrCreateChunk(memoTargetStart, memoTargetStart + CHUNK_SEC);
  chunk.notes.push(note);
  ui.memoDialog.close();
  ui.summary.textContent = `[${fmtRange(chunk.start, chunk.end)}] chunk에 메모를 저장했습니다.`;
  render();
}

function metadataHeader() {
  const title = ui.title.value.trim() || "제목 없음";
  const week = weekLabel();
  return [
    `강의 제목: ${title}`,
    week ? `주차: ${week}` : null,
    `전사 날짜: ${dateStamp()}`,
    `재생 배속: ${playbackSpeed()}×`,
    `강의 언어: ${languageLabel()}`,
    `타임스탬프 기준: Start 이후 실제 캡처 경과시간`,
    `원본 영상 위치 환산: 타임스탬프 × ${playbackSpeed()} (대략값)`,
    `전사 도구: Lecture Transcriber v${VERSION}`,
  ].filter(Boolean).join("\n");
}
function cleanDocument() {
  return `${metadataHeader()}\n\n${"─".repeat(36)}\n\n${buildCleanTimeline()}\n`;
}
function rawDocument() {
  return `${metadataHeader()}\n\n※ RAW는 Whisper small의 최초 1차 결과를 그대로 보존합니다. overlap 중복과 인식 오류가 포함될 수 있습니다.\n\n${"─".repeat(36)}\n\n${buildRawTimeline()}\n`;
}
function reviewSection() {
  const targets = chunks.filter((c) => c.userReview || c.autoReview || c.unresolved || c.mediumError);
  if (!targets.length) return "검토 우선 구간 없음";
  return targets.map((c) => {
    const labels = [];
    if (c.userReview) labels.push("사용자 확인 필요");
    if (c.autoReview) labels.push("자동 이상 감지");
    if (c.unresolved) labels.push("후보 미확정");
    const lines = [
      `### [${fmtRange(c.start, c.end)}] ${labels.join(" · ") || "검토"}`,
      c.notes.length ? c.notes.map((n) => `- 메모: ${n}`).join("\n") : null,
      `- SMALL: ${c.rawSmall || "[결과 없음]"}`,
      c.mediumText ? `- MEDIUM: ${c.mediumText}` : null,
      c.mediumError ? `- MEDIUM 오류: ${c.mediumError}` : null,
      c.qualitySmall?.reasons?.length ? `- SMALL 품질 플래그: ${c.qualitySmall.reasons.join(", ")}` : null,
      c.qualityMedium?.reasons?.length ? `- MEDIUM 품질 플래그: ${c.qualityMedium.reasons.join(", ")}` : null,
    ].filter(Boolean);
    return lines.join("\n");
  }).join("\n\n");
}
function makeAIExport() {
  const c = counts();
  return `# Lecture Transcriber — AI 교정용 패키지

## 강의 정보
${metadataHeader().split("\n").map((line) => `- ${line}`).join("\n")}

## 전사 품질 요약
- small 전사 완료: ${c.processed}구간
- medium 재검증 완료: ${c.reviewed}구간
- 사용자가 확인 필요로 표시: ${c.userReview}구간
- 최종 후보 미확정: ${c.unresolved}구간
- 사용자 메모: ${c.notes}개
- VAD로 무음 생략: ${skippedSilence}구간

## AI 교정 지침
아래 자료는 강의 음성을 자동 전사한 결과입니다. **요약하지 말고 먼저 전체 전사문을 교정**하세요.
1. CLEAN TRANSCRIPT를 기본 원문으로 사용하세요.
2. 음성인식 오류로 판단되는 부분만 강의 전체 문맥에 따라 최소한으로 교정하세요. 교수의 표현, 주장, 문장 순서를 임의로 바꾸지 마세요.
3. 새로운 사실이나 설명을 만들어 넣지 마세요. 원문만으로 판단할 수 없으면 '[불명확: 원문]' 형태로 남기세요.
4. '❓ 확인 필요', '⚠ 후보 충돌', '자동 이상 감지' 구간을 우선 검토하세요.
5. SMALL/MEDIUM 후보가 함께 있으면 강의 전체 문맥과 주변 발화를 이용해 더 자연스러운 후보를 선택하되, 확신할 수 없으면 두 후보를 보존하세요.
6. 고유명사·인명·작품명·전문용어는 전체 강의 문맥을 이용해 철자와 형태를 교정하세요. 근거 없이 새로운 고유명사를 추측하지 마세요.
7. '📝' 표시는 사용자가 직접 남긴 메모입니다. 교수 발화로 취급하거나 수정하지 마세요.
8. 타임스탬프는 LMS 원본 시간이 아니라 Start 이후 실제 캡처 경과시간입니다. 재생 배속은 ${playbackSpeed()}×이므로 원본 영상 위치는 대략 타임스탬프 × ${playbackSpeed()}입니다.
9. 최종 출력에서도 타임스탬프와 사용자 메모를 유지하세요.

## CLEAN TRANSCRIPT
${buildCleanTimeline() || "[전사 없음]"}

## 우선 검토 구간 — 모델 후보/품질 플래그
${reviewSection()}

## RAW FIRST-PASS TRANSCRIPT — Whisper small 최초 결과
${buildRawTimeline() || "[RAW 없음]"}
`;
}
function downloadBlob(content, filename, type = "text/plain;charset=utf-8") {
  const blob = new Blob(["\uFEFF", content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

async function cleanupLegacyCaches() {
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister()));
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("hanyang-lms-whisper")).map((k) => caches.delete(k)));
    }
  } catch {}
}

ui.start.addEventListener("click", startCapture);
ui.stop.addEventListener("click", stopCapture);
ui.unclear.addEventListener("click", flagCurrentForReview);
ui.memo.addEventListener("click", openMemoDialog);
ui.memoForm.addEventListener("submit", saveMemo);
ui.newLecture.addEventListener("click", () => {
  if (chunks.some((c) => c.rawSmall || c.notes.length || c.userReview)) {
    if (!confirm("현재 전사 기록을 모두 지우고 새 강의 화면으로 초기화할까요?")) return;
  }
  resetSession();
  setStatus("준비됨", "ready", smallReady ? "Whisper small 준비 완료 · Start 후 LMS 탭을 선택하세요." : "Start를 누르면 Whisper small을 준비합니다.");
});
ui.cleanTab.addEventListener("click", () => {
  activeTab = "clean";
  ui.cleanTab.classList.add("active");
  ui.rawTab.classList.remove("active");
  render();
});
ui.rawTab.addEventListener("click", () => {
  activeTab = "raw";
  ui.rawTab.classList.add("active");
  ui.cleanTab.classList.remove("active");
  render();
});
ui.ai.addEventListener("click", () => downloadBlob(makeAIExport(), `${baseFilename()}_AI교정용.md`, "text/markdown;charset=utf-8"));
ui.cleanTxt.addEventListener("click", () => downloadBlob(cleanDocument(), `${baseFilename()}_CLEAN.txt`));
ui.rawTxt.addEventListener("click", () => downloadBlob(rawDocument(), `${baseFilename()}_RAW.txt`));
ui.advanced.addEventListener("toggle", updateDiagnostics);
window.addEventListener("beforeunload", cleanupCapture);

cleanupLegacyCaches();
resetSession();
setControlState();
updateDiagnostics();
setStatus("준비됨", "ready", navigator.gpu ? "WebGPU 사용 가능 · Start 시 Whisper small을 준비합니다." : "WebGPU 없음 · small은 WASM/CPU 모드로 실행됩니다.");
