Hanyang LMS Whisper Web v1.1
================================

이번 버전은 GitHub Pages에서 링크 하나로 사용하는 브라우저용 버전입니다.
Python, BAT, Vercel, 외부 STT API가 필요 없습니다.

주요 기능
---------
- 한양대학교 로고 헤더 및 브라우저 아이콘
- 강의 제목 + 주차 입력
- 저장 파일명에 강의 제목/주차/날짜 자동 반영
- Start / Pause / Resume / Stop
- LMS 오디오 레벨 미터
- 28초 단위 전사 + 3초 overlap
- 구간별 timestamp
- RAW / CLEAN 전사본 분리
- 동일 단어/구 반복 환각 감지 및 안전한 CLEAN 정리
- 반복 환각 의심 시 자동 1회 재전사
- '마지막 구간 재전사' 버튼
- ★ 중요 / ? 확인 필요 / 메모 마커
- 브라우저 localStorage 자동 복구
- CLEAN TXT / RAW TXT / SRT / AI 교정용 Markdown 다운로드
- CLEAN 전체 복사
- WebGPU 사용 가능 시 WebGPU, 아니면 WASM CPU 모드
- Whisper small 사용

기존 GitHub Pages 업데이트 방법
-------------------------------
1. 이 ZIP을 압축 해제합니다.
2. GitHub의 기존 hanyang-lms-whisper 저장소로 들어갑니다.
3. 아래 파일/폴더를 저장소 최상위에 업로드하여 기존 파일을 교체합니다.

   index.html
   app.js
   worker.js
   sw.js
   manifest.webmanifest
   .nojekyll
   assets/hanyang-logo.png
   README_먼저읽기.txt
   RELEASE_NOTES_v1.1.txt

4. Commit changes를 누릅니다.
5. GitHub Pages는 보통 잠시 후 자동으로 새 버전을 배포합니다.
6. 기존 페이지에서 Ctrl + F5로 강력 새로고침합니다.
   Service Worker 캐시 때문에 이전 화면이 남아 있으면 브라우저를 완전히 닫았다가 다시 열어도 됩니다.

사용 순서
---------
1. Chrome 또는 Whale에서 한양대 LMS 강의를 엽니다.
2. GitHub Pages의 Hanyang LMS Whisper 링크를 다른 탭에서 엽니다.
3. '강의 제목'을 입력합니다. 주차는 선택입니다.
4. Start
5. 공유 창에서 Chrome 탭 / Whale 탭 → LMS 강의 탭 선택
6. 오디오 공유 옵션이 보이면 활성화
7. 강의 재생
8. 필요 시:
   - Pause: 녹음만 잠시 정지
   - ★ 중요: 현재 시간을 중요 포인트로 표시
   - ? 확인 필요: 다시 들어볼 부분 표시
   - 메모: 현재 시간에 개인 메모 저장
9. 강의 종료 후 Stop
10. CLEAN TXT 또는 AI 교정용 파일 다운로드

파일명 예
---------
강의 제목: SF 영화와 철학적 사고 실험
주차: 3

SF 영화와 철학적 사고 실험_3주차_2026-10-04_CLEAN.txt
SF 영화와 철학적 사고 실험_3주차_2026-10-04_RAW.txt
SF 영화와 철학적 사고 실험_3주차_2026-10-04.srt
SF 영화와 철학적 사고 실험_3주차_2026-10-04_AI교정용.md

RAW와 CLEAN의 차이
------------------
RAW:
Whisper가 선택된 최종 구간 결과를 거의 그대로 보존합니다.

CLEAN:
같은 단어가 4회 이상 계속 반복되거나 같은 짧은 구가 비정상적으로 반복되는 경우를 줄입니다.
의미를 추측하여 문장을 새로 작성하지는 않습니다.

AI 교정용
---------
AI 교정용 Markdown 파일에는 교정 지침 + CLEAN + RAW가 함께 들어갑니다.
ChatGPT 등에 올려서 발음/고유명사/문맥 기반 교정을 별도 2차 처리하기 좋습니다.

개인정보
--------
음성은 별도의 STT API로 보내지 않고 브라우저의 Whisper 모델에서 처리합니다.
다만 최초 실행 시 프로그램 코드와 모델 파일을 CDN/Hugging Face에서 다운로드합니다.

주의
----
- 브라우저 보안상 Start 후 사용자가 LMS 탭을 직접 선택해야 합니다.
- 이 도구는 한양대학교 공식 서비스가 아닌 개인 학습용 비공식 도구입니다.
- SRT timestamp는 전사 처리 구간 기준이므로 전문 자막 편집 수준의 단어 단위 정밀 timestamp는 아닙니다.

권장
----
최신 Chrome + WebGPU 가능한 Windows PC를 가장 권장합니다.

Version: Web v1.1
