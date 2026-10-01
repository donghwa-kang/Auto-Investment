# 확정 비용 포함 합성 학습 입력 검증기 — S10-B

2026-10-01. 개발자용 로컬 TEST_ONLY 읽기 검증이다. [S10-A 계약](COST_LEARNING_INPUT_DESIGN.md)의 S9-B 단일 KRW 월초 첫 후보·완료20위험일 합성 이력·자동 체결/시간 감시·D8 마감 조합만 지원한다. 모델 학습이나 주문 기능이 아니다. 실제 검사 결과/미검증은 [PROGRESS · 공개 요약](PROJECT_STATUS.md)를 따른다.

## API와 신뢰 경계

[구현](../src/server/cost-learning-input.ts)의 공개 API:

| API | 동작 |
| --- | --- |
| `createCostLearningInput(raw)` | 엄격한 외피를 JSON으로 생성하고 `{ text, inputHash }` 반환. 출처/금융 인증은 아니다 |
| `verifyCostLearningInput(text, anchor)` | 외부 고정 hash·config 아래 금융 전체 재생·원래 신호/RVOL·비용/시점 검증 |
| `verifyCostLearningBatch(entries)` | 1~16개 `{ text, anchor }` 전부 검증. 정확한 입력 중복은 한 행, 같은 의도의 다른 입력은 그룹 전체 HOLD |
| `costLearningInputLimits` / `costLearningPermissions` | 고정 자원 제한 / 모두 false인 권한 목록 |

외피 필드는 `kind: SYNTHETIC_COST_LEARNING_INPUT_V1`, `purpose: TEST_ONLY`, `asOf`(정수 epoch 밀리초), 원래 `replay`/`settings`/`selection`, `operatingEvidenceText`(원래 V4 JSON 문자열)다. 추가 features/label/verified 필드를 받지 않는다.

외부 anchor는 `{ inputHash, operating: { config, exportHash } }`다. 신뢰하는 호출자가 독립적으로 보존한 config와 hash를 공급한다. 받은 자료에 맞춰 anchor를 자동 생성하는 검증 서비스는 없다. 생성 helper의 hash는 보존할 수 있지만 출처 신뢰는 호출자의 별도 책임이다.

검증기는 Store/Repository를 열거나 승인·예약·접수·DB 쓰기를 하지 않는다. `CostSignalProgram`의 순수 생성과 새 순수 `proposalForEvidence(stateHash)`/`frameForEvidence()`로 원래 제안과 동일 재생의 프레임을 대조한다. 불필요한 두 번째 전체 신호 재생을 하지 않는다. 기존 `verifyOperatingEvidence`가 명령·영수증·CAS/epoch·비용·보고서를 전부 재생한다. 신뢰/스키마/원자료 재생 오류는 예외로 거절하고 부분 적격 결과를 반환하지 않는다.

## 결과와 시점

확정 자료는 `SYNTHETIC_INPUT_ELIGIBLE`, 유효하지만 미확정/시점 부적격 자료는 `HOLD`·`trainingLabel: null`이다. 둘 다 학습/모델 등록·승격/실주문/새 지출/자동 재개가 false다. 기존 V4 보고 HOLD와 구형 학습 입력은 그대로다.

- `features`: 원자료에서 독립 재구축한 RVOL 문자열과 `DECIMAL40_V1`만 제공한다. Float64 벡터가 아니다.
- `decisionContext`: 승인 당시 후보·역사적 운영비 추정/근거·forecast를 감사 문맥으로 분리한다. 최종 손익은 특징이 아니다.
- `trainingLabel`: 실제 체결 총손익에서 COMMISSION/TAX/EXCHANGE/FX `amountDelta` 합과 실제 D8 운영비 배분만 차감한다. 슬리피지 추정·과거 운영비 추정·지급을 다시 빼지 않는다.
- `population`: 선택 프레임의 비벤치마크 모든 후보 상태/사유/평가 여부. 미선택 비용은 `NOT_RECORDED`, 결과는 발명하지 않는다. 전 시장 모집단 인증은 아니다.
- `audit`: 원래 검증 금융 보고·RVOL 원자료·signal/export hash·미결제 여부. 손실·보호 HOLD·확정 미수/미지급을 보존한다.
- `intentKey`/`decisionBasisHash`/`labelBasisHash`/`resultHash`: 의도/판단/라벨/결과를 분리한다. 반환값은 detached 복사본이다.

`labelAvailableAt`은 체결 수신·주문 종료 근거·운영비 사건·D8 manifest 가용시각/적용시각의 최댓값이다. 나중 금융 export를 과거 asOf에 넣으면 `FINANCIAL_EXPORT_AFTER_AS_OF`/`LABEL_NOT_AVAILABLE` 등으로 HOLD하며 과거 상태를 추측해 자르지 않는다.

예약/미접수/무체결/부분 체결/열린 주문, 미마감/마감 후 격리는 각각 `ENTRY_NOT_TRANSFERRED`, `TRADE_NOT_CLOSED`, `OPEN_ORDER_OR_RESERVATION`, `OPEN_LOCAL_RESERVATION`, `OPERATING_NOT_FINALIZED`, `UNRESOLVED_OR_POST_CLOSE_INPUT` 등으로 HOLD한다. 사유는 정렬·중복 제거한다. 원본 config·신호·승인·외부 hash 불일치는 HOLD가 아니라 거절이다.

배치는 동일 JSON 값/hash의 반복을 `duplicateCount`(첫 원본 제외 추가 수)로 센다. 종목/시장/통화/세션/B·P/신호 시각/BUY로 같은 의도를 정규화한다. 실행 이름/namespace·입력/export hash·asOf로 표본을 늘리지 않는다. 다른 입력은 `INTENT_INPUT_CONFLICT`로 그룹 전체 HOLD하며 라벨을 제거한다. 최신/최고 결과 선택이 없고 배치 순열도 같은 hash다. 해당 메모리 배치 내 검사이며 영구 등록기는 아니다.

## 실행 예제와 검사

프로젝트 루트 PowerShell·기존 Node24.20/npm11에서 실행한다. 첫 빌드 실패 시 다음 명령을 진행하지 않는다. 시험 helper의 새 메모리 DB는 합성 B 자료 캡처 후 닫힌다. 실제 자료/사용자 DB가 아니다.

```powershell
npm run build:engine
```

```powershell
@'
import { capturedLearning } from './dist/runtime/tests/cost-learning-input-helpers.js';
import { verifyCostLearningInput, verifyCostLearningBatch } from './dist/runtime/src/server/cost-learning-input.js';
const captured = capturedLearning();
const row = verifyCostLearningInput(captured.text, captured.anchor);
const batch = verifyCostLearningBatch([captured, captured]);
console.log(JSON.stringify({ status: row.status, rvol: row.features.rvol,
  finalNetPnlKrw: row.trainingLabel?.finalNetPnlKrw,
  learningAllowed: row.learningAllowed, liveEnabled: row.liveEnabled,
  uniqueCount: batch.uniqueCount, duplicateCount: batch.rows[0].duplicateCount }));
'@ | node --input-type=module
```

기대 결과는 적격·RVOL2·합성 최종2330원·두 권한 false·고유1/중복1이다. 고정 숫자는 정합성 검산값이지 시장 기대수익이 아니다. 새 입력/결과를 기존 `parseLearningInput`에 넣으면 거절된다. API 키나 `portfolio:web` 실행은 필요 없다.

```powershell
node --test --test-concurrency=1 dist/runtime/tests/cost-learning-input.test.js
```

[시험](../tests/cost-learning-input.test.ts)은 LI-01~16의 대표 정상/손실/미지급·누출/누락/상충·라벨 시점·미확정/마감 후 격리·부분/대체·재전송/배치·변조/자원·읽기 전용/구형 경계를 검사한다. 모든 가능한 입력/장애를 증명하지 않는다. 실행 횟수/실패·보완/회귀는 PROGRESS에 기록한다.

## 제한과 다음 단계

외피 UTF8 64MiB·깊이64·노드100만, 배치1~16·총 문자열64MiB. 공개 제한값/권한 상수도 런타임에서 고정해 JavaScript 호출자가 이를 변경할 수 없다. 기존 금융 JSON16MiB/50만 노드·기록 제한과 replay 자산8/프레임8·이력/작업 한도도 유지한다. 금액은 문자열128자리 Decimal 합/차, RVOL은 기존40자리 규약이다. 새 반올림 정책·금액 Number 변환이 없고 timestamp/수량만 제한 정수다.

전체 replay를 읽는 오프틱 동기 함수이므로 보호/청산 루프 안에 넣지 않는다. 최대 허용 입력 성능·영구 중복 등록·학습/모델 효과·실자료 수익성·앱/HTTP/UI 관통·외화/다일·D9/D10 새 결합·환불/정정은 미구현/미검증이다. 다음은 외부 연결 없이 앱 관통 인수 범위와 원래 D03 잔여 조건을 대조한다.
