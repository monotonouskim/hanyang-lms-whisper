import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL = "onnx-community/whisper-small";
let transcriber = null;
let currentDevice = null;
let chain = Promise.resolve();
const post = (type, data = {}) => self.postMessage({ type, ...data });

function resampleLinear(input, sourceRate, targetRate = 16000) {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = src - i0;
    output[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return output;
}
function pipelineOptions(device) {
  const base = {
    device,
    progress_callback: (p) => post("progress", {
      file: p.file || p.name || "",
      progress: typeof p.progress === "number" ? p.progress : 0,
      status: p.status || ""
    })
  };
  if (device === "webgpu") base.dtype = { encoder_model: "fp32", decoder_model_merged: "q4" };
  else base.dtype = "q8";
  return base;
}
async function init(requestedDevice) {
  if (transcriber) {
    post("ready", { model: MODEL, device: currentDevice });
    return;
  }
  let device = requestedDevice || "wasm";
  try {
    transcriber = await pipeline("automatic-speech-recognition", MODEL, pipelineOptions(device));
    currentDevice = device;
  } catch (error) {
    if (device !== "webgpu") throw error;
    post("fallback", { message: error?.message || String(error) });
    device = "wasm";
    transcriber = await pipeline("automatic-speech-recognition", MODEL, pipelineOptions(device));
    currentDevice = device;
  }
  post("ready", { model: MODEL, device: currentDevice });
}
async function transcribe(message) {
  if (!transcriber) throw new Error("small 모델이 아직 준비되지 않았습니다.");
  const pcm = resampleLinear(message.audio, message.sampleRate, 16000);
  const options = { task: "transcribe", return_timestamps: false };
  if (message.language && message.language !== "auto") options.language = message.language;
  const result = await transcriber(pcm, options);
  post("result", { id: message.id, text: (result?.text || "").trim() });
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === "init") {
    chain = chain.then(() => init(message.device)).catch((error) => {
      post("error", { message: `Whisper small 준비 실패: ${error?.message || String(error)}` });
    });
  } else if (message.type === "transcribe") {
    chain = chain.then(() => transcribe(message)).catch((error) => {
      post("error", { id: message.id, message: `small 전사 실패: ${error?.message || String(error)}` });
    });
  }
};
