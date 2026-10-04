Hanyang LMS Whisper Web
=======================

이 버전은 Vercel, Python, BAT, localhost 서버가 필요 없습니다.

핵심 구조
---------
- GitHub Pages 같은 정적 웹 호스팅에서 실행
- Chrome/Whale의 '현재 탭/다른 탭 오디오 공유' 기능 사용
- Transformers.js + Whisper small을 브라우저 안에서 실행
- 별도 STT API로 음성 업로드하지 않음
- Start / Stop / Download TXT 제공

권장 환경
---------
- Windows
- 최신 Google Chrome 또는 Whale
- WebGPU 사용 가능한 PC 권장
- RAM 여유가 있는 환경 권장

첫 실행
-------
Whisper 모델과 Transformers.js 실행 파일을 인터넷에서 내려받습니다.
Whisper small 모델은 여러 모델 파일로 구성되어 있어 다운로드 용량이 상당할 수 있습니다.
두 번째 사용부터는 브라우저 캐시가 재사용될 수 있습니다.

공개 링크 만드는 가장 쉬운 방법: GitHub Pages
---------------------------------------------

1. github.com 로그인
2. New repository 생성
   예: hanyang-lms-whisper
3. 이 ZIP 안의 HanyangLMS_Whisper_Web 폴더 안 파일들을 저장소 최상위에 업로드
   - index.html
   - app.js
   - worker.js
   - sw.js
   - manifest.webmanifest
   - .nojekyll
4. GitHub 저장소:
   Settings → Pages
5. Build and deployment:
   Source = Deploy from a branch
6. Branch:
   main / (root) 선택 → Save
7. 잠시 기다리면 아래 형태의 HTTPS 링크가 생성됨

   https://사용자이름.github.io/hanyang-lms-whisper/

이 주소를 북마크해 두면 다음부터 ZIP이나 BAT 없이 바로 접속할 수 있습니다.

사용법
------
1. Chrome/Whale 탭 1: 한양대 LMS 강의
2. 탭 2: GitHub Pages로 만든 Hanyang LMS Whisper
3. Start
4. 공유 창에서 'Chrome 탭' 또는 'Whale 탭'
5. LMS 강의 탭 선택
6. 오디오 공유가 보이면 활성화
7. 강의 재생
8. Stop
9. Download TXT

중요한 제한
-----------
브라우저 보안 정책 때문에 웹페이지가 사용자의 LMS 탭을 자동으로 몰래 캡처할 수는 없습니다.
Start를 누른 뒤 매번 사용자가 공유할 LMS 탭을 직접 선택해야 합니다.

오디오가 공유되지 않는 경우
---------------------------
- '창' 또는 '전체 화면'이 아니라 'Chrome 탭 / Whale 탭'을 선택
- LMS 탭에서 실제 소리가 나고 있는지 확인
- 최신 Chrome에서 우선 테스트
- 이 웹앱과 LMS를 같은 브라우저에서 열기

WebGPU가 없는 경우
------------------
WASM CPU 모드로 자동 전환되지만 Whisper small은 많이 느릴 수 있습니다.
가능하면 WebGPU 가능한 최신 Chromium 브라우저를 권장합니다.

개인정보
--------
이 앱의 전사 로직 자체는 별도 STT API로 오디오를 전송하지 않습니다.
다만 웹앱 코드 및 Whisper 모델 파일은 최초 실행 시 CDN/Hugging Face에서 다운로드됩니다.

버전: Web v1.0
