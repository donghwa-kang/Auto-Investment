# 키움 호출 예산·중단/재개 오프라인 모형

상태: 로컬 합성 로그 시험용 · 기준 확인: 2026-09-21 · 실제 수집/주문 연결 없음

후속 [DEV-D02 호출·대조 실험실](BROKER_CONTROL_LAB.md)은 별도 합성 공유 큐·슬롯·미확정 대조·SQLite 복구 시험을 제공합니다. 이 문서의 기존 순차 로그 함수는 변경하지 않았습니다. 후속 모형도 실제 키움 통신/계좌 전체 호출 제한의 실측 검증은 아닙니다.

---

## 📋 무엇을 검증하는가

**`replayMockKiwoomCollection`은 실제 수집기가 아니다.** 사용자가 작성한 합성 요청·응답 및 중단/재개 사건을 시간순으로 대조하여, 어느 요청을 허용하고 어느 요청을 차단해야 하는지 계산하는 순수 함수다. 실제 요청, 타이머 대기, 인증, 파일 저장, 서버 시작을 하지 않는다.

기존 [키움 응답 형식 검증](KIWOOM_OFFLINE_INGEST.md)을 재사용한다. 국내/미국 분봉·최우선 호가의 네 읽기 TR만 취급하며 모든 정상 자료도 **의미 확인 전 보류**다. `eventAt=null`, `realCollectionEnabled=false`, `realDataReady=false`, `strategyReady=false`, `paperOrdersEnabled=false`, `liveEnabled=false`를 유지한다. 원래 매매 기준과 위험 한도는 변경하지 않는다.

이 모형은 한 합성 클라이언트의 예산만 계산한다. 계좌 전체 호출 조정, 동시 프로세스, 실제 수집·강제 종료 복구, 투자 수익성의 검증을 대체하지 않는다.

## ⚙️ 공개 한도와 로컬 설계의 구별

공개 소개 페이지의 조회 한도를 다음과 같이 고정해 시험한다. 실제 사용 직전에는 최신 안내와 계정 적용 조건을 다시 확인해야 한다.[^limits]

| 범위 | 문서에 나온 조회 한도 | 이 모형의 적용 |
| --- | --- | --- |
| 국내 | 계좌/토큰별 초당 5회 | `ka10080`·`ka10004` 합산 |
| 미국 일반 | 계좌/토큰별 초당 5회 | `usa06011`·`usa20101` 합산 |
| 미국 피크 | 한국시간 09:00~10:00, 초당 3회 | 로컬 요청 시각의 UTC+9로 `[09:00, 10:00)` 판정 |
| 모의 서버 | 계좌/토큰별 TR당 초당 1회 | `PUBLISHED_MOCK_LIMITS` 선택 시 TR별 계산 |
| 미국 추가 제한 | 전체 초당 50회·차트 초당 20회 | 현재 두 조회 TR에서는 더 작은 5/3회 제한이 먼저 적용됨. 다른 분류 지원을 뜻하지 않음 |

`PUBLISHED_QUERY_LIMITS`와 `PUBLISHED_MOCK_LIMITS`는 **비교할 한도 프로필 이름**이지 접속할 서버 설정이 아니다. 둘 다 가상 응답만 처리한다. 공개 문서의 세션·실시간 구독 수 제한은 이번 REST 순차 로그 모형의 구현 대상이 아니다.[^limits]

다음은 공급자의 확정 사양이 아니라 **명시적인 로컬 시험 설계**다.

- 최근 1초의 이동 구간 `(요청 시각−1,000ms, 요청 시각]`을 사용한다. 정확히 1,000ms 지난 호출은 구간에서 빠진다. 공급자의 실제 서버 창 계산 방식까지 확인한 것은 아니다.
- 미국 피크로 바뀌면 직전 1초의 피크 이전 호출도 포함하여 더 작은 한도로 재평가한다. 피크 시간은 미국 개장 시간으로 추정하지 않는다.
- `minIntervalMs`는 시장/TR에 관계없이 적용되는 최소 요청 간격이다. 시간대별 공급자 한도를 완화하지 못한다.
- `maxAttempts`는 1~50회, `maxPagesPerChain`은 1~20페이지다. 실행 마감은 시작 후 최대 24시간이다. 이는 로컬 자원 상한이며 투자 한도나 공급자 보장값이 아니다.
- `faultCooldownMs`는 1,000~60,000ms의 시험용 최소 대기다. 429 또는 오류 후 자동 재시도는 없다. 이 값만 지나면 실제 공급자가 다시 허용한다는 뜻이 아니다.
- `notBefore`는 재검사할 수 있는 시각의 하한이지 미래 호출 허용 예약이 아니다. 실제 시간 이동·재시도·지연 보정은 하지 않는다.

## 🔄 중단·재개와 실패 처리

간단한 상태 표로 동작과 실패 조건을 구분한다. `READY`는 **로그 끝의 모형 상태**일 뿐 백그라운드 프로그램이 실행 중이라는 표시가 아니다.

| 사건/조건 | 결과 | 보존하거나 차단하는 것 |
| --- | --- | --- |
| 허용되는 `ATTEMPT` | 예산 1회 차감, 응답 형식 대조 | 실패 응답·타임아웃도 이미 사용한 호출로 계산 |
| 호출 한도·간격·커서/질의 불일치 | `REJECTED` | 응답 정규화·예산 차감 없이 해당 후보 거절 |
| HTTP 오류·타임아웃·단절·필드/상충 오류 | `PAUSED` | 최소 대기 기록, 다음 요청과 자동 재시도 차단 |
| 페이지 오류·페이지 한도 도달 | `PAUSED` | 현재 커서 체인 폐기, 전체 이력 확보 판정 금지 |
| `PAUSE` | `READY`에서 `PAUSED` | 사용 예산·호출 이력·최소 간격 유지, 커서 폐기 |
| `RESUME` | `PAUSED`에서만 `READY` | 최소 대기 충족 및 연결 세대 정확히 +1 요구, 첫 요청은 새 `N` 커서 |
| `STOP`·총 예산 소진·마감 도달 | `STOPPED` | 같은 로그에서 다시 시작하거나 예산 환급 불가 |
| 응답이 마감 이후 가용해짐 | `STOPPED` | 요청 예산은 차감, 늦은 응답 본문은 정규화하지 않음 |

한 번에 **하나의 요청/응답 구간**만 허용한다. 앞선 요청의 `availableAt` 전에는 다음 요청과 제어 사건을 거절한다. 수신 중 취소·즉시 중단·동시 연결은 구현하지 않았으며, 실수집기의 중단 버튼으로 그대로 사용할 수 없다. HTTP 상태 또는 서버 오류 코드를 읽는 것은 실제 응답이 아닌 입력된 합성 응답에 한정한다.

로그에는 완료 시각을 아는 후보 응답만 넣는다. `requestedAt ≤ receivedAt ≤ availableAt ≤ asOf`이고 사건의 요청/제어 시각이 감소하지 않아야 한다. 같은 시각 사건은 배열 순서대로 처리한다. 마감 정각에는 새 요청을 받지 않지만 그 시각에 가용해진 기존 응답은 검사할 수 있다. 미래 응답이 포함된 입력은 잘라내어 성공시키지 않고 전체를 거절한다. 실시간 스트림의 미완료 요청을 표현하는 계약은 아니다.

`decisions.at`은 후보 요청/제어 사건 시각이고 `resultKnownAt`은 그 행의 결과 상태를 알 수 있는 시각이다. 응답 결과를 요청 시각에 미리 알았다고 해석하면 안 된다. 수신 중 겹친 사건의 상태 기록도 앞선 응답 완료 또는 마감까지 포함한 사후 대조 결과이며, 실시간 상태 스트림으로 사용하지 않는다.

### 페이지와 자료 기록

차트의 `Y` 커서가 남아 있으면 같은 질의의 다음 페이지만 허용한다. 다른 종목/TR을 처리하려면 기존 체인을 끝내거나 명시적으로 중단하고 새 세대로 시작한다. 호가의 `Y`/미상 연속조회는 지원하지 않는다. 기존 페이지 검증기의 반복 커서·새 행 없음·빈 연속 페이지·미상 종료 규칙을 재사용한다.

재개는 이전 페이지를 이어받는 것이 아니라 **새 `N` 요청으로 다시 시작하는 모형**이다. 이때 전역 중복/상충 검증에는 재개 이전 자료도 남는다. 재수신을 덮어쓰거나 상충을 성공으로 처리하지 않는다. 페이지 예산은 체인 단위지만 총 요청 예산은 세대가 바뀌어도 유지된다.

보고서의 `ingest`는 허용되고 마감 안에 가용한 응답의 형식 검증 결과다. 호출/페이지 운영상의 거절과 중단은 `decisions`·`stopReason`에서 함께 확인해야 한다. `ingest`가 형식상 정상이어도 수집이 완전하거나 거래가 가능하다는 뜻이 아니다. `pendingContinuation=true`는 로그 종료 시 아직 다음 페이지가 남은 상태다. `historyCoverageVerified`는 항상 `false`다.

### 재생과 실제 복구의 차이

같은 전체 입력 로그를 다시 넣으면 같은 결과를 만든다. 보고서를 체크포인트로 받아 호출 예산을 복원하는 기능은 없으며 원자료를 다시 계산한다. 해시는 비교용이지 전자서명이나 변조 방지 장치가 아니다. 로그를 지우거나 다른 프로세스에서 실행했을 때 계좌 전체 예산을 보호하지 못한다.

실제 복구에는 별도의 영속 사건 기록, 계좌/토큰 단위 단일 조정자, 시계 이상 감지, 이미 전송된 요청과 불명 상태의 대조가 필요하다. 이번에는 저장 스키마·DB·권한 원장을 만들거나 변경하지 않았다.

## 🔧 로컬 실행 방법

현재 설치된 프로젝트 루트에서 PowerShell을 사용한다. 지원 Node 범위는 `package.json`을 따르며 새 SDK·계좌·키가 필요하지 않다.

```powershell
npm run build:engine
@'
import { kiwoomCollectionSample } from './dist/runtime/src/core/kiwoom-collection-sample.js';
import { replayMockKiwoomCollection } from './dist/runtime/src/core/kiwoom-collection.js';
const r = replayMockKiwoomCollection(kiwoomCollectionSample());
console.log(JSON.stringify({ state: r.state, stopReason: r.stopReason, budget: r.budget, captures: r.ingest?.counts.captures, networkRequests: r.networkRequests, liveEnabled: r.liveEnabled }, null, 2));
'@ | node --input-type=module
```

예상 결과는 `STOPPED`, `USER_STOP`, `maxAttempts=8`, `used=4`, `remaining=4`, 캡처 4개, `networkRequests=0`, `liveEnabled=false`다. 네 가상 TR 사이에 중단/새 세대 재개를 끼운 자체 합성 사례이며 실제 지연 표본이 아니다. UI나 거래 엔진에는 연결하지 않았다.

### 입력과 오류

TypeScript 계약은 [kiwoom-collection.ts](../src/core/kiwoom-collection.ts), 고정 예시는 [kiwoom-collection-sample.ts](../src/core/kiwoom-collection-sample.ts)에 있다.

- 최상위 입력: `schemaVersion`, `purpose`, `limitProfile`, `startedAt`, `deadlineAt`, `maxAttempts`, `maxPagesPerChain`, `minIntervalMs`, `faultCooldownMs`, `sourceInput`, `events`.
- `sourceInput`: 기존 `OFFLINE_KIWOOM_INGEST_V1`의 모형 캡처 1~50개. `pagePlans`는 비워 두며 페이지 체인은 사건 순서에서 재구성한다.
- `events`: `ATTEMPT {captureId}`, `PAUSE {at}`, `RESUME {at, connectionEpoch}`, `STOP {at}`의 엄격한 합집합. 최대 150개. 모든 캡처를 정확히 한 번 참조한다.
- 초기 연결 세대는 0이다. 한도 프로필의 숫자 덮어쓰기, 주문/인증 TR, 미지 필드·비밀 필드·중복 참조·미래/역행 시각은 거절한다.
- 전체 입력 4MiB 및 기존 수신기의 합계 2,000행 상한을 적용한다. 오류는 값을 포함하지 않는 `KIWOOM_COLLECTION_INPUT_INVALID`로 반환한다. 요청 거절과 응답 실패는 보고서에 사유 코드로 기록한다.

실제 키나 계좌 자료를 시험 입력으로 넣지 않는다. 입력/보고서는 합성 자료이며 공급자 진본 인증 결과가 아니다.

## 🔍 검사와 남은 조건

```powershell
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/kiwoom-collection.test.js dist/runtime/tests/kiwoom-ingest.test.js dist/runtime/tests/network-boundary.test.js
```

테스트는 호출 창·미국 피크 전환·모의 TR별 한도·간격·총량·마감, 오류 후 명시 재개, 연결 세대·커서·중복/상충, 미래 관측·비밀값/주문 거절과 전이 의존성 경계를 확인한다. 실행 결과와 보존 근거는 [진행 기록 · 공개 요약](PROJECT_STATUS.md)에 남긴다. 정적 의존성 검사는 외부 패키지 내부나 OS 전체 격리 시험이 아니다.

다음 실제 수집 단계의 필수 조건은 [원천 의미·수집 조건 확인](KIWOOM_DATA_SEMANTICS.md)에 정리되어 있다. **시세의 개인 로컬 저장·분석 이용권과 조회 비용은 아직 확정하지 않았다.** 미확인 내용을 동의·무료·허용으로 간주하지 않는다. 공시·뉴스·전략·SOXL 거래 가능 여부와 연결을 새로 승인하지도 않는다.

권리/요금 및 제한 수집 범위가 확인되면 주문 없는 진단용 수집기를 별도 구현·검증할 수 있다. 그때 최신 한도·오류별 재개 조건·실제 타임아웃/취소·중복 실행 방지·자료 격리 저장과 복구를 다뤄야 한다. 실제 시세 지연·호환성·장기 이력·수익성·UI E2E·OS 격리는 이번 모형으로 검증되지 않는다. `G1 HOLD`, `G2 NOT_RUN`, 실주문 `HOLD`는 그대로다.

---

[^limits]: 키움증권, 「REST API 소개」의 호출 제한 및 공통 적용사항. 2026-09-21 확인. https://openapi.kiwoom.com/intro
