Lecture Transcriber v1.2 — GitHub Pages 배포 안내
=================================================

1. 이 폴더의 파일을 GitHub 저장소 루트에 그대로 업로드/덮어쓰기합니다.
   - index.html
   - app.js
   - small-worker.js
   - medium-worker.js
   - sw.js
   - manifest.webmanifest
   - hanyang-logo.png
   - .nojekyll

2. 예전 v1.1의 worker.js는 더 이상 사용하지 않습니다. 저장소에서 삭제해도 됩니다.

3. 중요: v1.1에는 Service Worker 캐시가 있었습니다.
   v1.2의 sw.js는 '업데이트용 캐시 제거 파일'이며, v1.2 자체는 Service Worker를 사용하지 않습니다.
   업로드 후 사이트를 1~2회 새로고침하면 오래된 캐시가 제거됩니다.
   그래도 예전 화면이 보이면 Ctrl+Shift+R(강력 새로고침)을 한 번 실행하세요.

4. GitHub > Settings > Pages에서 Branch가 main / (root)로 설정되어 있으면 됩니다.

5. 사용법
   ① 강의 제목/주차/재생 배속 입력
   ② Start
   ③ 공유 창에서 실제 LMS 강의 '탭' 선택 + 오디오 공유 켜기
   ④ 전사 중 필요하면 '❓ 확인 필요' 또는 '📝 메모'
   ⑤ 강의가 끝나면 Stop
   ⑥ 모든 small/medium 처리가 끝나면 AI 교정용 / CLEAN TXT / RAW TXT 저장

6. 처리 방식
   - 22초 chunk + 2초 overlap
   - VAD로 무음 구간 억제
   - 모든 발화는 Whisper small로 1차 전사
   - 반복 환각/비정상 출력 또는 사용자가 ❓ 표시한 chunk만 Whisper medium 재검증
   - RAW는 최초 small 결과를 보존
   - CLEAN은 기계적인 반복/overlap 정리만 수행하며 의미를 임의로 고치지 않음
   - 의미 수준의 교정은 AI 교정용 Markdown을 ChatGPT 등에 넣어서 수행

7. 주의
   - medium 모델은 필요할 때만 다운로드되며 모델 파일이 매우 큽니다. 첫 medium 검증은 오래 걸릴 수 있습니다.
   - WebGPU가 없으면 WASM/CPU 모드라 처리 시간이 길어질 수 있습니다.
   - 오디오는 별도 STT API로 보내지 않지만, 최초 모델/라이브러리 다운로드에는 인터넷 연결이 필요합니다.
   - 강의 녹음/전사 허용 범위는 해당 수업 규정을 확인하세요.
