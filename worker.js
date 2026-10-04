import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;
let currentModel = null;
let currentDevice = null;
let taskChain = Promise.resolve();

const post = (type, data={}) => self.postMessage({type, ...data});

function resampleLinear(input, sourceRate, targetRate=16000){
  if(sourceRate===targetRate)return input;
  const ratio=sourceRate/targetRate;
  const length=Math.max(1,Math.round(input.length/ratio));
  const output=new Float32Array(length);
  for(let i=0;i<length;i++){
    const src=i*ratio, i0=Math.floor(src), i1=Math.min(i0+1,input.length-1), frac=src-i0;
    output[i]=input[i0]*(1-frac)+input[i1]*frac;
  }
  return output;
}

async function init(model,device){
  if(transcriber && currentModel===model && currentDevice===device){
    post("ready",{model,device,dtypeLabel:device==="webgpu"?"WebGPU":"q8/WASM"});
    return;
  }
  currentModel=model;currentDevice=device;
  const options={
    device,
    progress_callback:(p)=>post("progress",{
      status:p.status||"",file:p.file||p.name||"",progress:typeof p.progress==="number"?p.progress:0
    })
  };
  if(device==="wasm") options.dtype="q8";

  transcriber=await pipeline("automatic-speech-recognition",model,options);
  post("ready",{model,device,dtypeLabel:device==="webgpu"?"WebGPU":"q8/WASM"});
}

async function transcribe(m){
  if(!transcriber)throw new Error("Whisper 모델이 아직 준비되지 않았습니다.");
  const pcm=resampleLinear(m.audio,m.sampleRate,16000);

  const opts={
    language:"ko",
    task:"transcribe",
    return_timestamps:false,
    repetition_penalty: m.retryStrength>=2 ? 1.22 : (m.retry ? 1.16 : 1.08),
    no_repeat_ngram_size: m.retryStrength>=2 ? 2 : 3
  };

  const result=await transcriber(pcm,opts);
  post("result",{
    id:m.id,start:m.start,end:m.end,retry:!!m.retry,retryStrength:m.retryStrength||0,
    text:(result?.text||"").trim()
  });
}

self.onmessage=(event)=>{
  const m=event.data||{};
  if(m.type==="init"){
    taskChain=taskChain.then(()=>init(m.model,m.device)).catch(err=>{
      post("error",{message:`Whisper 모델 준비 실패: ${err?.message||String(err)}\n인터넷 연결과 브라우저 WebGPU 지원 여부를 확인하세요.`});
    });
  }else if(m.type==="transcribe"){
    taskChain=taskChain.then(()=>transcribe(m)).catch(err=>{
      post("error",{id:m.id,message:`전사 실패: ${err?.message||String(err)}`});
    });
  }
};
