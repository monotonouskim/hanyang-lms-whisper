const $ = (id) => document.getElementById(id);

const startBtn = $("start");
const stopBtn = $("stop");
const downloadBtn = $("download");
const clearBtn = $("clear");
const diagBtn = $("diag");
const textBox = $("text");
const statusEl = $("status");
const detailEl = $("detail");
const metaEl = $("meta");
const dotEl = $("dot");
const errorEl = $("error");
const barEl = $("bar");

const WINDOW_SEC = 35;
const OVERLAP_SEC = 5;

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
let stopping = false;
let sampleRate = 48000;

let buffers = [];
let bufferedSamples = 0;
let chunkId = 0;
let inflight = 0;
let transcript = "";
let sessionStarted = null;

function setStatus(text, kind="busy", detail="") {
  statusEl.textContent = text;
  detailEl.textContent = detail || "";
  dotEl.className = "dot " + kind;
}

function showError(msg) {
  errorEl.style.display = "block";
  errorEl.textContent = msg;
}

function clearError() {
  errorEl.style.display = "none";
  errorEl.textContent = "";
}

function normalizeToken(s) {
  return s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

function mergeTranscript(base, next) {
  base = (base || "").trim();
  next = (next || "").trim();
  if (!base) return next;
  if (!next) return base;

  const a = base.split(/\s+/);
  const b = next.split(/\s+/);
  const max = Math.min(40, a.length, b.length);
  let overlap = 0;

  for (let n = max; n >= 3; n--) {
    const aa = a.slice(-n).map(normalizeToken);
    const bb = b.slice(0, n).map(normalizeToken);
    if (aa.join("|") === bb.join("|")) {
      overlap = n;
      break;
    }
  }
  if (overlap) next = b.slice(overlap).join(" ");
  return next ? base + "\n" + next : base;
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

function flushReadyWindows() {
  const windowSamples = Math.floor(sampleRate * WINDOW_SEC);
  const overlapSamples = Math.floor(sampleRate * OVERLAP_SEC);

  while (bufferedSamples >= windowSamples) {
    const audio = takeSamples(windowSamples);
    const overlap = audio.slice(audio.length - overlapSamples);
    prependBuffer(overlap);
    sendForTranscription(audio, false);
  }
}

function sendForTranscription(audio, finalChunk) {
  if (!worker || !workerReady || audio.length < sampleRate) return;
  const id = ++chunkId;
  inflight++;
  metaEl.textContent = `녹음·전사 중 · 처리 대기 ${inflight}개`;
  worker.postMessage({
    type: "transcribe",
    id,
    audio,
    sampleRate,
    finalChunk,
  }, [audio.buffer]);
}

function ensureWorker() {
  if (worker) return;

  worker = new Worker("./worker.js", { type: "module" });

  worker.onmessage = (event) => {
    const m = event.data || {};

    if (m.type === "progress") {
      modelLoading = true;
      const pct = Number.isFinite(m.progress) ? Math.max(0, Math.min(100, m.progress)) : 0;
      barEl.style.width = pct + "%";
      setStatus(
        "Whisper 모델 준비 중...",
        "busy",
        m.file ? `${m.file} ${pct ? Math.round(pct) + "%" : ""}` : "첫 실행은 시간이 걸릴 수 있습니다."
      );
      return;
    }

    if (m.type === "ready") {
      workerReady = true;
      modelLoading = false;
      modelFailed = false;
      barEl.style.width = "100%";
      setStatus(
        "Whisper 준비 완료",
        "ready",
        `${m.model} · ${m.device.toUpperCase()} · ${m.dtypeLabel}`
      );
      return;
    }

    if (m.type === "result") {
      inflight = Math.max(0, inflight - 1);
      transcript = mergeTranscript(transcript, m.text || "");
      textBox.value = transcript;
      textBox.scrollTop = textBox.scrollHeight;
      downloadBtn.disabled = !transcript.trim();

      if (capturing) {
        metaEl.textContent = inflight
          ? `녹음·전사 중 · 처리 대기 ${inflight}개`
          : "녹음·전사 중 · 모든 조각 처리 완료";
      } else if (stopping && inflight === 0) {
        finishStop();
      }
      return;
    }

    if (m.type === "error") {
      inflight = Math.max(0, inflight - 1);
      modelFailed = true;
      showError(m.message || "Whisper 처리 중 오류가 발생했습니다.");
      setStatus("Whisper 오류", "error", "진단 버튼으로 브라우저 상태를 확인하세요.");
      if (stopping && inflight === 0) finishStop();
    }
  };

  worker.onerror = (e) => {
    modelFailed = true;
    showError(`Whisper Worker 오류\n${e.message || "알 수 없는 오류"}`);
    setStatus("Whisper Worker 오류", "error");
  };
}

async function initModelIfNeeded() {
  ensureWorker();
  if (workerReady) return;
  if (modelLoading) {
    await waitUntil(() => workerReady || modelFailed, 180000);
    if (!workerReady) throw new Error("Whisper 모델 준비에 실패했습니다.");
    return;
  }

  modelLoading = true;
  modelFailed = false;
  barEl.style.width = "2%";

  const hasWebGPU = !!navigator.gpu;
  worker.postMessage({
    type: "init",
    device: hasWebGPU ? "webgpu" : "wasm",
    model: "onnx-community/whisper-small"
  });

  await waitUntil(() => workerReady || modelFailed, 300000);
  if (!workerReady) throw new Error("Whisper 모델 준비에 실패했습니다.");
}

function waitUntil(test, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (test()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("시간 초과"));
      }
    }, 250);
  });
}

async function startCapture() {
  clearError();

  if (!window.isSecureContext) {
    showError(
      "이 페이지는 HTTPS 보안 연결에서 열어야 탭 오디오 공유가 가능합니다.\n" +
      "GitHub Pages 주소(https://...)에서 실행해 주세요."
    );
    return;
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    showError("이 브라우저는 탭 오디오 공유를 지원하지 않습니다. 최신 Chrome 또는 Whale을 사용하세요.");
    return;
  }

  startBtn.disabled = true;
  setStatus("Whisper 준비 중...", "busy", "처음 실행이라면 모델을 내려받습니다.");

  try {
    await initModelIfNeeded();

    setStatus("공유할 LMS 탭을 선택하세요.", "busy", "반드시 Chrome/Whale '탭'을 선택하세요.");

    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      systemAudio: "include",
    });

    const audioTracks = displayStream.getAudioTracks();
    if (!audioTracks.length) {
      displayStream.getTracks().forEach(t => t.stop());
      displayStream = null;
      throw new Error(
        "오디오 트랙이 전달되지 않았습니다.\n\n" +
        "공유 창에서 'Chrome 탭' 또는 'Whale 탭'을 선택한 뒤 실제 LMS 강의 탭을 고르세요. " +
        "'탭 오디오 공유'가 보이면 켜주세요. '창'이나 '전체 화면' 공유는 피해주세요."
      );
    }

    audioContext = new AudioContext();
    await audioContext.resume();
    sampleRate = audioContext.sampleRate;

    const audioOnly = new MediaStream(audioTracks);
    sourceNode = audioContext.createMediaStreamSource(audioOnly);

    // ScriptProcessor is widely supported in Chromium and is used here only
    // for lightweight PCM capture. Whisper inference itself runs in a Worker.
    processor = audioContext.createScriptProcessor(4096, 2, 1);
    muteNode = audioContext.createGain();
    muteNode.gain.value = 0;

    processor.onaudioprocess = (event) => {
      if (!capturing) return;
      const input = event.inputBuffer;
      const frames = input.length;
      const channels = input.numberOfChannels;
      const mono = new Float32Array(frames);

      for (let ch = 0; ch < channels; ch++) {
        const data = input.getChannelData(ch);
        for (let i = 0; i < frames; i++) mono[i] += data[i] / channels;
      }

      appendBuffer(mono);
      flushReadyWindows();
    };

    sourceNode.connect(processor);
    processor.connect(muteNode);
    muteNode.connect(audioContext.destination);

    const ended = () => {
      if (capturing) stopCapture();
    };
    audioTracks[0].addEventListener("ended", ended, { once: true });
    const videoTrack = displayStream.getVideoTracks()[0];
    if (videoTrack) videoTrack.addEventListener("ended", ended, { once: true });

    buffers = [];
    bufferedSamples = 0;
    chunkId = 0;
    inflight = 0;
    transcript = "";
    textBox.value = "";
    downloadBtn.disabled = true;
    sessionStarted = new Date();

    capturing = true;
    stopping = false;
    stopBtn.disabled = false;
    setStatus(
      "녹음·전사 중",
      "ready",
      `오디오 ${Math.round(sampleRate/1000)} kHz · 35초 창 / 5초 겹침`
    );
    metaEl.textContent = "강의를 재생하세요. 첫 전사는 약 35초 뒤 표시됩니다.";

  } catch (err) {
    cleanupCapture();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus("시작하지 못했습니다.", "error");
    showError(err.message || String(err));
  }
}

async function stopCapture() {
  if (!capturing || stopping) return;
  capturing = false;
  stopping = true;
  stopBtn.disabled = true;
  startBtn.disabled = true;
  setStatus("마지막 오디오 처리 중...", "busy", "남은 부분을 Whisper로 전사합니다.");

  const remaining = bufferedSamples;
  if (remaining >= sampleRate) {
    const finalAudio = takeSamples(remaining);
    sendForTranscription(finalAudio, true);
  } else {
    buffers = [];
    bufferedSamples = 0;
  }

  cleanupCapture();

  if (inflight === 0) finishStop();
}

function cleanupCapture() {
  try { if (processor) processor.disconnect(); } catch {}
  try { if (sourceNode) sourceNode.disconnect(); } catch {}
  try { if (muteNode) muteNode.disconnect(); } catch {}
  try {
    if (displayStream) displayStream.getTracks().forEach(t => t.stop());
  } catch {}
  try {
    if (audioContext && audioContext.state !== "closed") audioContext.close();
  } catch {}

  processor = null;
  sourceNode = null;
  muteNode = null;
  displayStream = null;
  audioContext = null;
}

function finishStop() {
  stopping = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  downloadBtn.disabled = !transcript.trim();
  setStatus("정지됨", "ready", "TXT 파일로 저장할 수 있습니다.");
  metaEl.textContent = transcript.trim()
    ? "Download TXT를 눌러 전체 전사문을 저장하세요."
    : "전사된 텍스트가 없습니다.";
}

function downloadTXT() {
  if (!transcript.trim()) return;
  const stamp = (sessionStarted || new Date())
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "_");

  const blob = new Blob(["\uFEFF", transcript.trim(), "\n"], {
    type: "text/plain;charset=utf-8"
  });

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `Hanyang_LMS_Whisper_${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

function clearTranscript() {
  if (capturing || stopping) return;
  transcript = "";
  textBox.value = "";
  downloadBtn.disabled = true;
  metaEl.textContent = "전사 내용이 지워졌습니다.";
}

function diagnostics() {
  const lines = [
    "Hanyang LMS Whisper 진단",
    "",
    `HTTPS secure context: ${window.isSecureContext ? "YES" : "NO"}`,
    `getDisplayMedia: ${navigator.mediaDevices?.getDisplayMedia ? "YES" : "NO"}`,
    `WebGPU: ${navigator.gpu ? "YES" : "NO"}`,
    `Whisper worker: ${workerReady ? "READY" : (modelLoading ? "LOADING" : "NOT READY")}`,
    `Model: onnx-community/whisper-small`,
    `Browser: ${navigator.userAgent}`,
    "",
    "권장 환경: 최신 Chrome 또는 Whale / Windows"
  ];
  alert(lines.join("\n"));
}

startBtn.addEventListener("click", startCapture);
stopBtn.addEventListener("click", stopCapture);
downloadBtn.addEventListener("click", downloadTXT);
clearBtn.addEventListener("click", clearTranscript);
diagBtn.addEventListener("click", diagnostics);

window.addEventListener("beforeunload", cleanupCapture);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

setStatus(
  "준비됨",
  "ready",
  navigator.gpu
    ? "WebGPU 사용 가능 · Start 시 Whisper small을 준비합니다."
    : "WebGPU 없음 · WASM CPU 모드로 실행됩니다(더 느릴 수 있음)."
);
