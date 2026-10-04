import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";

env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;
let currentModel = null;
let currentDevice = null;
let taskChain = Promise.resolve();

function post(type, data = {}) {
  self.postMessage({ type, ...data });
}

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

async function init(model, device) {
  if (transcriber && currentModel === model && currentDevice === device) {
    post("ready", {
      model: currentModel,
      device: currentDevice,
      dtypeLabel: currentDevice === "webgpu" ? "encoder fp32 / decoder q4" : "q8"
    });
    return;
  }

  currentModel = model;
  currentDevice = device;

  const options = {
    device,
    progress_callback: (p) => {
      let progress = 0;
      if (typeof p.progress === "number") progress = p.progress;
      post("progress", {
        status: p.status || "",
        file: p.file || p.name || "",
        progress
      });
    }
  };

  // WebGPU는 encoder fp32 + decoder q4 조합을 사용하여
  // 호환성과 메모리 사용량의 균형을 맞춘다.
  if (device === "webgpu") {
    options.dtype = {
      encoder_model: "fp32",
      decoder_model_merged: "q4"
    };
  } else {
    options.dtype = "q8";
  }

  transcriber = await pipeline(
    "automatic-speech-recognition",
    model,
    options
  );

  post("ready", {
    model,
    device,
    dtypeLabel: device === "webgpu" ? "encoder fp32 / decoder q4" : "q8"
  });
}

async function transcribe(id, audio, sampleRate) {
  if (!transcriber) throw new Error("Whisper 모델이 아직 준비되지 않았습니다.");

  const pcm16k = resampleLinear(audio, sampleRate, 16000);

  const result = await transcriber(pcm16k, {
    language: "ko",
    task: "transcribe",
    return_timestamps: false,
  });

  post("result", {
    id,
    text: (result?.text || "").trim()
  });
}

self.onmessage = (event) => {
  const m = event.data || {};

  if (m.type === "init") {
    taskChain = taskChain
      .then(() => init(m.model, m.device))
      .catch((err) => {
        post("error", {
          message:
            `Whisper 모델 준비 실패: ${err?.message || String(err)}\n\n` +
            "인터넷 연결과 브라우저 WebGPU 지원 여부를 확인하세요."
        });
      });
    return;
  }

  if (m.type === "transcribe") {
    taskChain = taskChain
      .then(() => transcribe(m.id, m.audio, m.sampleRate))
      .catch((err) => {
        post("error", {
          id: m.id,
          message: `전사 실패: ${err?.message || String(err)}`
        });
      });
  }
};
