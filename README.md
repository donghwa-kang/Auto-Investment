# Auto-Investment

automated investment program — 결정론적 위험·비용·장부 코어를 기반으로 개발 중인 **로컬 오프라인 모의매매 실험실**입니다. TypeScript, React, Node.js 내장 SQLite를 사용합니다.

현재 공개 버전은 연구·개발용입니다. 합성 데이터 시험을 실제 시장 백테스트나 수익성 검증으로 해석하면 안 됩니다. 실계좌 주문 어댑터는 없으며 AI에 주문·장부 수정 권한을 주지 않습니다. 투자 수익이나 손실 한도 준수를 보장하지 않습니다.

## 현재 기능과 한계

- 합성 종목·벤치마크의 B/P 신호 평가, 다종목 모의 실행, KRW/USD 가상 자금 및 위험 한도 검사.
- 부분 체결·취소·청산, 예약금·수수료·운영비, append-only 사건과 SQLite 원자적 기록·멱등성·writer fencing 검사.
- 비용 코어 시험 V3 및 명시 선택 V4: 같은 장부의 이력 비용 → 체결 → 운영비 → 마감 → 보고 → 읽기 전용 학습 입력 검증.
- 오프라인 자료 품질·신호 재생·학습 연구 CLI와 Codex 분석 요청/승인/결과 검증 **모형**. 실제 GPT/Codex 모델 연결이나 추가 토큰 사용이 아닙니다.
- 별도 실험적 외부 시세 조회 코드가 있으나 기본 앱은 연결하지 않습니다. 키·권한·자료 이용 조건·요금을 확인하지 않고 조회 명령을 실행하지 마세요.

S11-B 앱 연결은 **부분 완료**입니다. 최초 CW-03의 `FENCED_WRITER` 실패 원인은 미확정이며 잔여 진단 인수가 남아 있습니다. 전체 시장 실자료 검증, 수익성, 실계좌·유료 AI 연결, 실제 OS 격리·장기 운영은 완료되지 않았습니다. [현재 공개 상태와 검증 범위](docs/PROJECT_STATUS.md)를 먼저 확인하세요.

## 실행 환경

- 매니페스트 요구: Node.js `>=24.20.0 <25`, npm `>=11 <12`.
- 기존 개발 검증 환경: Windows, Node.js 24.20.0. 이 버전 범위 전체·다른 OS를 검증한 것은 아닙니다.
- 브라우저 자동 시험은 설치된 Microsoft Edge를 사용합니다.
- 분석 모형 자식 프로세스는 Windows + Node.js 24.20.0만 허용합니다. 다른 환경에서는 해당 기능이 비활성화될 수 있습니다.
- 기본 웹 앱에는 API 키·실제 증권 계좌·별도 DB 서버가 필요 없습니다. 네이티브 격리 연구 도구는 별도 빌드 조건이 있으며 기본 실행의 필수 구성요소가 아닙니다.

## 빠른 시작

새로 설치하는 경우 PowerShell에서 다음 순서로 실행합니다. 이미 프로젝트 폴더가 있으면 복제·이동 단계를 생략하세요.

```powershell
git clone https://github.com/donghwa-kang/Auto-Investment.git
cd Auto-Investment
node --version
npm --version
npm ci --ignore-scripts
npm run build
npm run portfolio:web
```

의존성 설치에는 npm 레지스트리 접속이 필요합니다. 기본 합성 앱 실행에는 금융·AI 서비스 연결이 필요하지 않습니다.

1. `http://127.0.0.1:4184/?view=portfolio`로 접속합니다. 서버를 실행한 PC에서만 사용하고 LAN·인터넷에 노출하지 마세요.
2. 서버가 안내하는 `data/portfolio-web/local-pairing.txt`의 일회용 코드를 입력합니다. 유효 기간은 5분/1회입니다. API 키가 아니며 파일·코드·화면 캡처를 공개하면 안 됩니다.
3. 모의 실험을 만들 때 합성 자료·TEST_ONLY 가정을 확인합니다. 생성만으로 거래가 자동 시작되지는 않습니다.
4. 비용 연결을 확인하려면 **비용 코어 시험 → 시험 경로 → V4 · 운영비·마감·입력 검증**을 명시 선택합니다. [V4 사용법·보류·복구 한계](docs/COST_APP_INTEGRATION.md)를 따르세요.

정상 확인: `/api/health`는 `mode: "OFFLINE_ONLY"`, `live: false`를 반환하고 인증 전 `/api/portfolio`는 401이어야 합니다. `RUNNING`은 합성 재생 상태이지 실제 돈으로 거래 중이라는 뜻이 아닙니다. 재생 종료와 청산 완료도 구분해야 합니다.

기존 단일 종목 화면은 별도 터미널의 `npm start`로 실행하며 주소는 `http://127.0.0.1:4173`, 코드 파일은 `data/local-pairing.txt`입니다. 두 앱은 같은 계좌·자금을 공유하지 않습니다. 저장·정지·청산의 차이는 [웹 사용 안내](docs/PORTFOLIO_WEB.md)를 확인하세요. 기존 DB를 삭제하거나 실행 중인 서버를 임의로 강제 종료하지 마세요.

### 설정

[.env.example](.env.example)은 변수 설명만 제공하며 앱이 `.env`를 자동으로 읽지 않습니다. 선택 설정은 실행할 PowerShell 프로세스에 지정합니다.

```powershell
$env:PORTFOLIO_WEB_PORT = '4184'
$env:PORTFOLIO_WEB_ROOT = 'data/portfolio-web'
npm run portfolio:web
```

기본값은 위 값과 같습니다. `LIVE_ENABLED=true` 또는 `TRADING_MODE=LIVE`는 시작 시 거절됩니다. API 비밀값을 프런트엔드·소스·문서·Git에 넣지 마세요.

## 검사

프로젝트 루트에서 실행합니다. 테스트는 기능·범위별 증거이며 모든 검사의 성공도 투자 성과를 증명하지 않습니다.

```powershell
npm run verify:originals
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

`npm run verify`는 원본·타입·린트·형식·단위 시험·빌드·브라우저 시험을 실행하고 로컬 `work/phase1-verification/`에 결과를 저장합니다. 시험 수가 많아 시간이 걸리며, Windows 네이티브 시험은 별도 도구 조건을 확인해야 합니다. **이번 공개 시점에 전체 `npm test`/`verify`가 통과했다는 주장은 아닙니다.** 실제 확인 범위는 [상태 문서](docs/PROJECT_STATUS.md)에 구분합니다.

공개 복제본의 원본 검사는 [공개 해시 목록](profiles/public-original-hashes.json)의 정책 22개를 확인합니다. 기존 개발 폴더에 비공개 `work/phase1-original-hashes.json`이 있으면 종전 37개 검사를 유지합니다. 정책 자체와 기존 해시는 바꾸지 않았습니다.

## 코드와 문서

| 경로 | 역할 |
| --- | --- |
| `src/core/` | 정책·신호·위험·비용·검증 계약 |
| `src/server/` | SQLite 저장소, 모의 엔진, HTTP·worker·CLI |
| `src/web/` | 로컬 사용자 화면 |
| `src/native/` | 실험적 Windows 격리·권한 검토 코드 |
| `tests/`, `fixtures/` | 자동 시험과 합성 입력 |
| `profiles/`, `outputs/` | 별도 실행 프로필과 불변 원본 거래 기준 |
| `docs/` | 기능별 사용법·설계·검증 범위 |

주요 안내: [개발 실행 가이드](docs/DEVELOPMENT_EXECUTION_GUIDE_v1.md), [D03 비용 통합 지도](docs/COST_ENGINE_INTEGRATION_PLAN.md), [학습 연구](docs/LEARNING_LAB.md), [Codex 분석 모형](docs/CODEX_ANALYSIS_MOCK.md).

## 공개 범위와 보안

코드·합성 fixture·정책·설계 문서를 공개합니다. 실제 DB·조회 자료·로그·인증값·개인 설정·원본 진행 일지·자동 생성 그래프는 제외합니다. 과거 문서의 `work/` 명령과 증거 경로는 개발 당시 기록이며 공개 복제본에 없을 수 있습니다. 특히 `outputs/`는 불변 원본이므로 비공개 증거를 가리키는 옛 링크를 그대로 보존했습니다. 그 링크를 현재 재현 가능한 공개 검사로 해석하지 마세요.

[보안·신고·공개 점검 안내](SECURITY.md)를 참고하세요. 민감정보 패턴 검사는 보안 감사나 유출 부재의 보증이 아닙니다. 별도 오픈소스 라이선스는 아직 지정하지 않았으며 공개 저장소라는 이유만으로 재배포·상업적 이용 권한이 부여되지는 않습니다.
