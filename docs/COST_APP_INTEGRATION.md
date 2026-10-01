# 비용·마감·학습 입력의 앱 연결 — S11-B

_2026-10-01 · 로컬 고정 합성 KRW 한 위험일 · 실제 투자/모델 실행 아님_

---

## 📋 현재 범위

[S11-A 설계](COST_APP_INTEGRATION_DESIGN.md)에 따라 기존 **비용 코어 시험** 메뉴에 명시적인 `COST_WEB_OPERATING_KRW_V1` 경로를 추가했다. 기존 `COST_WEB_SYNTHETIC_KRW_V1`는 유지하며 recipe 생략 시 기존 V3 의미다. 새 기능은 단일 합성 연결이며 전 시장 수익성·실계좌 준비도를 뜻하지 않는다. 최종 인수 상태와 실제 실행 결과는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)를 따른다.

동일 Store의 승인/접수·부분 체결·현재 운영비·청산/결제·D8 마감 뒤 금융 export의 같은 report를 표시한다. 입력 적격도 금융 보고 `HOLD`나 `canCreate`를 해제하지 않는다. 학습/모델 등록·승격/주문/새 지출/자동 재개는 모두 금지된다.

## 🔧 사용법

프로젝트 루트에서 기존 설치 환경으로 실행한다. 사용자 서버를 이번 검증에서 자동 재시작하지 않았다.

```powershell
npm run build
npm run portfolio:web
```

1. 터미널에 표시되는 로컬 주소와 연결 코드를 사용한다. API 키가 아니다.
2. **비용 코어 시험 → 시험 경로 → V4 · 운영비·마감·입력 검증**을 선택하고 합성 자료 동의 후 생성한다.
3. `IDLE`을 확인한 뒤 **비용 시험 시작**을 누른다. 생성만으로는 시작하지 않는다.
4. 사건13개가 처리되고 별도 다음 처리 단위에서 기간 완전성을 확인해 D8 마감한다. 정상 값은 현금5,002,330원, 거래비20원, 현재 운영비 발생/지급50원, 최종 손익2,330원이다. 모두 합성 기대값이다.
5. **고정 입력 검증 요청**을 누르면 별도 읽기 worker에서 검증한다. `SYNTHETIC_INPUT_ELIGIBLE`는 모델 학습이나 투자 성공 판정이 아니다.
6. 검증 완료 후 금융 근거·원래 입력·참고 pin·검증 결과를 로컬 다운로드할 수 있다. 같은 snapshot은 같은 bytes를 반환한다. 외부 전송/import 기능은 없다.

기존 미해결 실행/HOLD가 있으면 다른 recipe로도 새 실행을 만들 수 없다. 이 제한을 피하려고 사용자 기록을 삭제하지 않는다. 이번 인수는 별도 임시 루트만 사용했다.

### 중지와 재시작

새 V4는 **고정 합성 사건 시계**다. 과거120세션을 각60분으로 구성한 새 합성 자료와 현재 세션(총121세션)을 보존한다. 기존 V3 전체 세션 자료를 줄여서 대체하지 않았다. 현재 RVOL 비교315봉은 유지한다. API 지연이나 실제 체결 성능을 이 시계로 측정할 수 없다.

STOP은 사건 커서만 멈추며 청산/결제/마감이 아니다. FEED_OFF 시험은 합성 시각을 진행시키고 pulse/HOLD를 기록한다. 복구 후 이미 지나간 고정 사건을 새 시각으로 고쳐 넣지 않고 `COST_APP_SCHEDULE_TIME_PASSED`로 정지한다.

서버 재시작/다시 열기는 검사 전용이다. 원자료/config를 다시 만들어 덮지 않으며 START·예약 반환·HOLD 해제를 하지 않는다. 마감 dispatch 전 종료는 `UNCOMMITTED_INSPECTION_ONLY`, COMMIT 후 종료는 원래 명령/영수증을 대조해 `COMMITTED`로 표시한다. COMMIT 후 파일 캡처 전에 종료된 기록에는 snapshot이 없을 수 있다. 이를 성공한 입력 캡처로 만들거나 자동 재실행하지 않는다.

## 💾 저장·권한 경계

기존 `cost-runs/<UUID>` 아래 다음 파일을 사용한다. 브라우저는 경로나 금액을 지정할 수 없다.

| 파일 | 목적 |
| --- | --- |
| `request.json` | 불변 recipe/실행 ID. 같은 UUID의 다른 recipe는 활성 실행에서도 거절 |
| `fixture.json`, `fixture-pin.json` | 원자료/설정/선택/config/이력/고정 사건·작성자 완전성 선언과 별도 로컬 pin |
| `cost.sqlite` | 기존 V4 원장/lease와 앱 제어 의도. 별도 금융 DB를 만들지 않음 |
| `close-intent.json` | dispatch 전 commandId/closeId/request/expected state/epoch와 hash |
| `financial.json`, `learning-input.json`, `anchor.json` | 같은 금융 snapshot·원래 입력·분리된 로컬 기준 |
| `snapshot.json` | 앞선 파일을 flush한 후에만 게시하는 캡처 식별자 |

파일은 임시 파일→flush→rename 패턴이며 기존 다른 본문을 덮지 않는다. 실패한 `.partial`은 보존되고 완료 파일로 읽지 않는다. 파일 저장과 금융 DB COMMIT을 하나의 원자적 트랜잭션이라고 주장하지 않는다. 물리 전원 차단/파일 시스템 내구성 검증은 별도다.

로컬 생성 pin은 전송 손상/파일 상충을 감지하기 위한 기준이지 악성 사용자가 모든 파일과 pin을 함께 바꾼 경우의 서명 인증이 아니다. 사용자 import나 외부 공급자 진실성 보장은 없다.

검증 worker에는 캡처한 text/anchor만 넘긴다. Repository·DB 경로·계좌 키·주문 객체를 전달하지 않는다. 한 번에 검증 작업1개, 같은 snapshot 재요청은 같은 상태 반환이다. 제한시간180초이며 금융 worker의5초 stale/20초 제어 시간은 늘리지 않았다. 작업 실패/종료는 금융 결과를 수정하지 않는다. 이 분리는 코드/worker 경계이며 OS 권한 격리 증명이 아니다.

폴링은 작은 상태/보고 요약만 반환한다. 큰 다운로드는 검증 worker가 확인한 고정 bytes를 메모리에 보존해 반환한다. 검증 결과는 서비스 재시작 시 자동 복구/실행하지 않고, 저장된 입력을 사용자가 다시 검증할 수 있다. 같은 snapshot 실패 재요청은 실패 상태를 유지하며 자동 재시도하지 않는다.

HTTP는 기존 인증/Host/Origin/CSRF/8KB 제한을 유지한다. 새 작은 요청은 `create.recipe`, `verify {runId,snapshotId}`이며 다운로드는 인증된 `/api/cost-lab/download?runId=...&snapshotId=...&artifact=financial|input|anchor|result`다.20실행·100제어(마지막STOP)·8대기 및 recipe 간 미해결 차단을 공유한다.

## 🔍 CW-03 조사와 보완

CW-03은 [기존 V3 웹 시험](../tests/cost-web.test.ts)이다. S9/S10/D8을 관통하지 않는다. [Runtime](../src/server/cost-loop-runtime.ts)은 타이머뿐 아니라 `start/quote/check`에서 동기 heartbeat를 수행하고 [Repository](../src/server/repository.ts)는 COMMIT 직전에도 owner/epoch/만료를 확인한다. 따라서 S10 JSON 파싱이 이 시험의 타이머를 막았다는 설명은 코드와 맞지 않는다.

- 수정 전 원래 CW-03의 계측 재실행:1/1 통과. writer16회, 최대1,251.84ms, writer 진입 시 최소 잔여8,014ms, 계측된 fencing0. 로그 (로컬 비공개 기록: `work/cost-app-integration/cw-before-1790835981291.log`).
- 이전 실패 당시 owner/epoch/만료 시각이 없어 그 실행의 정확한 실패 구간은 소급 확정할 수 없다. 이번 성공을 최초 실패 해결 증거로 바꾸지 않는다.
- 최소 보완: V3 quote가 반환한 이미 검증/커밋된 상태로 같은 보고를 만든다. 중복 전체 DB 재생1회를 제거했으며 writer의 replay/CAS/해시/lease 검사는 모두 유지한다.
- 추가 진단: 오류 코드는 `FENCED_WRITER` 그대로이며 원인에는 행 존재/owner·epoch 일치 여부/잔여ms만 담는다. 실제 owner ID나 계좌값은 넣지 않는다. 앱 오류 snapshot에도 이 제한된 진단을 보존한다.
- lease를10초에서 늘리거나 만료 뒤 부활시키지 않았다. COMMIT은 SQLite 트랜잭션의 끝이지 소유권 전체 해제와 같은 개념이 아니다. 검사 중 yield로 동기 JSON 파싱을 선점할 수 있다는 전제도 사용하지 않는다.

추가 교차 검사에서 **별도의 V4 시험 실패**도 관찰했다. 당시 로그 (로컬 비공개 기록: `work/cost-app-integration/last-admission-1790838831349.log`)는5개 중3통과/2실패다. 정상 마감 후 시험이 전체 export를 다시 읽고 원래 D8 명령을 직접 재전송하는 과정에서, writer 진입 검사는 통과했으나 COMMIT 직전 검사에서 `ownerMatches=true`, `epochMatches=true`, `remainingMs=-3788`로 거절했다. 두 번째 실패는 첫 시험이 끝나지 않아 초기화되지 않은 공유 `closedView`를 후속 시험이 읽은 준비 코드 오류다. 현재 앱의 정상 마감 자체나 별도 S10 worker가 실패한 로그는 아니다. 최초 V3 CW-03의 원인으로 소급할 수 없다.

시험을 실제 앱의 정지 상태 다음 처리 단위와 맞췄다. 중복 마감 직전의 불필요한 전체 export 재생을 이미 저장된 동일 금융 snapshot 읽기로 바꾸고, 앱 `step()`의 기존 heartbeat를 거친 뒤 재전송한다. 만료된 lease는 이 heartbeat에서도 거절한다. 모든 금융 요청을 끝내고 writer를 닫은 뒤 직접 S10 읽기 검사를 수행하도록 분리했다. 별도의 실제 브라우저 시험은 원래부터 분리 worker를 사용한다. 후속 입력 거절 시험은 자신의 서비스 view로 검사하며 이전 시험의 미초기화 view를 읽지 않는다. 보완 후 계측 재검증 (로컬 비공개 기록: `work/cost-app-integration/repair-traced-1790839129705.log`)은5/5 통과했으며 앞선 실패를 삭제하지 않는다.

## ✅ 인수와 남는 한계

인수 파일은 [앱 시험](../tests/cost-app.test.ts), [실제 브라우저/HTTP/worker 시험](../tests/browser/cost-app.spec.ts)이다. 첫9개 실행 중8개 통과,1개는 위121세션을120으로 잘못 센 테스트 기대값이었다. 원자료는 변경하지 않고 기대값/설명만 고쳤다. 수정 후 선택 재검증5/5가 통과했다. 강제 종료 직전/직후·파일 변조·입력 단절·쓰기 실패 등 결과는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)에 실제 로그와 함께 기록한다.

CA-02/04/06의 금융 변형은 기존 HA/LC/LI/CJ 코어 인수를 함께 사용한다. 웹의 공개 고정 recipe를 손실/UNKNOWN 등의 사용자 임의 입력 경로로 확장하지 않는다. mock 화면만 보고 앱 관통 성공으로 세지 않는다. 전체 npm test·모든 극단적 시스템 부하·실자료·실투자·AI 수익성은 이번 통과 범위가 아니다.

### 인수 근거 대응

아래는 새 앱 인수와 이번에 재실행한 기존 코어 인수를 구분한 대응이다. CA 그룹 수와 실제 테스트 수는 서로 다르다. 실패 변형을 모두 웹 공개 경로로 구현한 것이 아니다.

| 설계 그룹 | 확인한 경로와 근거 |
| --- | --- |
| CA-01 | V4 명시 선택/동일 UUID recipe 상충·엄격 스키마, 구형 CW 전체8개와 V3 실제 브라우저 |
| CA-02 | 앱의 보존된 원자료/4원 이력·config·수량4, 기존 HA 정상·누락/미래/다른 O/N·epoch/lease 거절 |
| CA-03 | 실제 임시 HTTP→금융 worker→부분 체결·50원 비용/지급→D8→읽기 worker→화면/다운로드. BigInt로2330원 독립 검산 |
| CA-04 | 기존 LI 손실·미지급·미결제·미마감·UNKNOWN·부분 매도 6개. 미확정 라벨/null과 금융 HOLD 보존 |
| CA-05 | 앱 START/STOP·공급 단절과 지나간 사건 거절, 재봉인한 일정 상충 거절. 기존 LC 불완전/미래/오래된 기간·예약/격리 거절 |
| CA-06 | 앱 D8 원래 영수증 재반환·COMMIT 직전 lease 만료 롤백·제어 저장 실패. 기존 LC/CJ 마감/콜백·롤백·fencing, OL/OI 체결/발생/지급 중복·상충 |
| CA-07 | 브라우저 응답 유실/새로고침·동일 요청, 실제 임시 자식 프로세스를 D8 dispatch 전/COMMIT 후 종료하고 재열기. 자동 재개 없음 |
| CA-08 | 실제 검증 중 STOP 응답과 별도 worker 강제 종료 후 금융 heartbeat/보고 보존, 동일 작업 재조회·잘못된 snapshot 거절. 최대 부하/OS 스케줄러 보장은 아님 |
| CA-09 | 같은 캡처의 원장/입력/anchor/결과 대조·재다운로드 bytes 일치, 변조/요청 파일 누락·미게시 partial 거절, 금융 테이블 무변경 |
| CA-10 | 기존 HTTP Host/Origin/세션/CSRF, 새 다운로드 인증/경로 거절·8KB, recipe 공통20실행/8대기 및 V3/V4 각각100제어 마지막STOP |
| CA-11 | 실제 Edge 키보드·390폭 화면, 적격과 금융 HOLD 분리·검사 전용/시점·금액 문자열/null·권한false 표시 |
| CA-12 | 관련 기존34개와 비용/체결 멱등성3개, 새 경계·브라우저, 타입/변경 코드 lint/엔진·웹 빌드·원본/범위/문서 확인. 최초 CW-03 원인 확정은 미완료 |

최종 로그와 중간 실패/재검증 수는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)에 기록한다. 새 앱 테스트11개는 여러 실행에서 각각 최종 통과했으며, 마지막 수정 뒤 전체11개를 한 번에 실행했다는 뜻이 아니다. 기존 코어의 선택 실행도 전체 `npm test`를 대신하지 않는다.

### 재검증 명령

기존 설치 환경에서 먼저 빌드한다. 실행 중인 시험이 읽는 `dist/runtime`을 덮어쓰지 않도록 빌드와 시험은 순서대로 수행한다.

```powershell
npm run typecheck
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/cost-app.test.js
node node_modules/vite/bin/vite.js build
node node_modules/@playwright/test/cli.js test tests/browser/cost-app.spec.ts tests/browser/cost-lab.spec.ts
npm run verify:originals
```

여기서 전체 앱 테스트 명령은 재현용 안내다. 이번 실제 실행에서는 최초9개 실행과 선택 재검증으로 범위를 확대했다. `test-results/cost-app-desktop.png`와 `cost-app-mobile.png`는 임시 합성 시험 화면이며 사용자 계좌 화면이 아니다.

### 미완료와 다음 경계

**S11-B 전체 인수는 보류한다.** 새 기능과 현재 회귀가 통과해도 최초 CW-03 실행의 owner/epoch/lease 진단이 없으므로 그 원인을 확정하거나 해결됐다고 소급 선언하지 않는다. 이번 추가 진단과 기존 만료/새 epoch 실패 시험은 원인 후보를 구분하는 수단이다. 같은 검사를 반복해 우연한 성공을 쌓는 대신, 후속의 제한된 부하/이벤트 루프 지연 시험으로 실제 지연 구간과 fencing 동작을 계측하는 것이 남았다. lease 증가·검사 완화·거래 재개로 통과시키지 않는다.

원래 D03-03/04 완료 여부는 이 연결과 별도로 대조한다. 다일/월 전환·외화/혼합·정정/환불 정책을 임의 확정하지 않았다. 다음은 위 진단 인수를 닫은 뒤 원래 D03 잔여 조건을 증거로 대조하는 작업이다. 새로운 장부 기능·실계좌·AI 실행을 자동 추가하지 않는다.
