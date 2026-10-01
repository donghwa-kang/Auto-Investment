# V4 운영비 보고·독립 재생 사용법과 계약

_2026-09-29 · DEV-D03-S8-A · 결정/인수 명세 · 제품 기능은 아직 미구현_

후속 S8-B 구현 상태(2026-09-29): 아래 S8-A의 ‘미구현/제안’은 설계 당시 기록이다. 현재 제공 API·실행 예제는 다음 절을, 실제 시험 결과/한계는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)를 따른다. S7-마감 새 조합·파일/HTTP/UI·학습은 여전히 제외한다.

후속 S8-C 상태: [새 명시 S7+D8 단일 마감](COST_LOOP_CLOSE.md)을 이 보고/메모리 export/검증과 연결했다. config의 `operatingLoop.closeContract`를 고정해 재생하며 기존 S7을 자동 전환하지 않는다. 아래 S8-A/B의 조합 거절은 기본 계약 기준이고, 새 opt-in만 예외다. S7+D9/D10·파일/HTTP/UI·학습은 여전히 제외한다.

## ▶️ S8-B 개발자용 사용법

기존 설치 환경에서 프로젝트 루트의 `npm run build:engine`으로 엔진과 시험을 컴파일한다. 새 패키지·API 키·`portfolio:web` 실행은 필요 없다. 사용자 DB가 아닌 **새 TEST_ONLY KRW 합성 실행**에만 사용한다.

| API | 실제 동작 |
| --- | --- |
| `store.operatingReport(asOf?)` | 한 검증 snapshot에서 현재 계정·거래비·운영비·D8·D9/D10을 분리한 읽기 보고 |
| `store.exportOperatingEvidence(asOf?)` | 같은 snapshot의 config/records/보고를 메모리 객체로 반환. 파일 저장 안 함 |
| `verifyOperatingEvidence(jsonText, anchor)` | 독립적으로 신뢰한 config/exportHash로 DB 없이 재생. 성공도 HOLD/권한 false |

기존 `report()`와 `exportEvidence()`는 V3 전용 그대로다. 기본 V4, S7 단독, 명시 D8, D8+D9 또는 D8+D10은 지원하되 S7+D8/D9/D10은 여전히 거절한다. 내부 `buildOperatingReport`/`buildOperatingEvidence`는 검증 snapshot 투영용이며 외부 JSON 진입점이 아니다.

다음은 테스트 helper로 새 메모리 장부에 가상 운영비50원을 인식한 뒤 DB를 닫고 검증하는 JavaScript 예제다. `anchor`는 **신뢰한 원래 생성 과정**에서 별도로 보관해야 하며 가져온 JSON의 config/hash로 만들면 안 된다. 이 예제는 키/계좌/파일을 사용하지 않는다.

```javascript
import { openedOperating, op, record } from './dist/runtime/tests/cost-operating-helpers.js';
import { verifyOperatingEvidence } from './dist/runtime/src/core/cost-operating-evidence.js';
const f = openedOperating();
let jsonText, anchor;
try {
  record(f.store, op(f.store.read(), 'RECOGNIZE', 'demo-cost', '50'));
  const evidence = f.store.exportOperatingEvidence();
  anchor = { config: structuredClone(f.c), exportHash: evidence.exportHash };
  jsonText = JSON.stringify(evidence);
} finally {
  f.repo.close();
}
const result = verifyOperatingEvidence(jsonText, anchor);
console.log({ status: result.status,
  incurredKrw: result.report.financialEvidence.operating.current.incurredKrw,
  periodNetPnlKrw: result.report.financialEvidence.finalization.periodNetPnlKrw });
```

기대 결과는 `{ status: 'HOLD', incurredKrw: '50', periodNetPnlKrw: null }`이다. 비용 인식은 확인되지만 아직 마감하지 않았으므로 기간 최종 손익은 미확정이다. UI 표시·학습 자료 생성·주문 실행은 발생하지 않는다.

제품 시험은 빌드 후 다음 명령으로 실행한다. 기존 helper의 전체 합성 신호 생성 때문에 단순 산술 시험보다 오래 걸릴 수 있다. 실제 소요 시간은 해당 실행 로그만 근거로 삼는다.

```powershell
node --test --test-concurrency=1 dist/runtime/tests/cost-operating-report.test.js
```

### 출력과 오류 해석

`financialEvidence` 안에 현재 계정/거래/운영비/마감과 원래 증거가 있고, `followup.report`에 D9/D10 대상별 현재 진행이 있다. `historicalPostings`의 원래 결제 표시는 후속 지급으로 바뀌지 않는다. 미지원/잘못된 입력은 예외로 거절하며 숫자를 보정하거나 DB에 HOLD 사건을 새로 쓰지 않는다. 유효하지만 미완료인 보고는 HOLD/null이다.

- `financialBasisHash = hash({source, financialEvidence})`: 기록에 기반한 금융/원천 내용이다. `asOf`만 바꾼 관찰 보고는 이 해시를 바꾸지 않는다.
- `reportHash`: 자기 필드를 제외한 보고 전체, `exportHash`: 자기 필드를 제외한 export 전체다. `checkpointHash`는 원래 D8 checkpoint 전체 해시다. 후속 지급이 있어도 과거 checkpoint는 불변이다.
- 기본 `asOf`는 금융 clock과 기록된 마지막 감시 시각 중 큰 값이다. 명시 `asOf`는 이보다 이르면 거절한다. 관찰 시각 갱신은 원장 시각·시세·지급을 생성하지 않는다.
- `OPERATING_EVIDENCE_ANCHOR_REQUIRED`/`HASH_MISMATCH`/`CONFIG_MISMATCH`: 원래 신뢰 기준을 확인한다. 입력 파일의 해시로 anchor를 교체해 통과시키지 않는다.
- `SCHEMA_INVALID`/`COMMAND_MISMATCH`/`RECEIPT_MISMATCH`/`REPORT_MISMATCH`/`REPLAY_REJECTED`: 변조·누락·미지원 근거를 확인한다. 실패 원문/개인정보를 에러 문자열에 반사하지 않는다.
- `SIZE_LIMIT`/`STRUCTURE_LIMIT`/`RECORD_LIMIT`: 전체를 거절한다. 자동 절단·상한 증가·기록 삭제는 하지 않는다. 16MiB·깊이64·500,000노드와 계약별 명령 상한을 적용한다. record 스키마는 순차 검사해 첫 실패에서 종료한다.
- `OPERATING_REPORT_TIME`/`V4_REQUIRED`: 보고 시각 또는 명시 계약이 맞지 않는다. 기존 실행을 자동 변환하지 않는다.

입력 config의 `seed`는 신뢰한 호출자의 상태이며 범용 외부 상태 importer가 아니다. 같은 reducer의 DB 독립 재생이지 독립 금융 모델/실자료의 정확성 증명은 아니다. 새 금액 연산은 로컬 Decimal128과 일반 십진 문자열을 쓰며 전역 정밀도·원본 반올림 정책을 바꾸지 않는다. 운영비의 정수 원화 제한과 체결 결제의 소수 허용 범위는 별개다.

다음 구현은 S8-C의 **새 명시 S7-마감 조합 인수**다. 아래 S8-A의 S8-B 실행 지시는 이력이며 재실행 지시로 쓰지 않는다. 원래 D03 체크는 이 기능 하나로 완료 처리하지 않는다.

## 🎯 결정과 범위

다음 구현은 **기존 V4 실행을 한 검증 시점에서 읽는 보고서와, DB 없이 재생 가능한 합성 근거**로 한정한다. 새 장부·비용 계산기·정정 정책을 만들지 않는다. 현재 `report()`/`exportEvidence()`의 V4 거절과 S7-마감 조합 거절은 이번 문서 작업에서 그대로다. 원본 B/P 기준·위험 한도·V3 형식/해시·D8~D10 체크포인트를 바꾸지 않는다.

승인 범위는 [D5의 U08-A/U06-A](OPERATING_COST_INTEGRATION_DECISIONS.md), [S6 잔여 인수](D03_INTEGRATION_ACCEPTANCE.md), [S7 합성 루프](COST_OPERATING_LOOP.md)다. OC-U01/02/03/04/05/07, 실제 자료 이용권/비용, 외화·다일 이월·정정은 미결정으로 남는다. 국내 KRW부터 연결하는 순서이지 미국 시장/ETF 제외 정책이 아니다.

| 대안 | 판단 | 이유 |
| --- | --- | --- |
| V3의 버전 검사를 제거해 재사용 | 채택 안 함 | 명시 무운영비였던 기존 보고/학습 근거의 의미가 바뀜 |
| 현재 잔액·미배분 결과·불변 마감·후속 지급을 별도 영역으로 표시 | 채택 | 기존 원장을 그대로 읽으며 비용 이중 차감과 과거 덮어쓰기를 피함 |
| 보고·S7 마감·후보 심사·학습·UI를 한 번에 변경 | 채택 안 함 | 새 조합의 금융 변경과 읽기 기능을 구분해 인수할 수 없음 |

## 🔎 현재 근거와 읽기 원천

아래는 확인한 현재 구현이다. 새 통합 보고 DTO/API는 뒤의 제안이며 존재한다고 가정하지 않는다.

| 원천 | 제공하는 사실 | 통합 시 지켜야 할 경계 |
| --- | --- | --- |
| [Store](../src/server/cost-reservation-store.ts)의 전체 검증 재생 | 명령/영수증·상태·감사·승인·체결 인덱스 대조 | 공개 조회 여러 번을 합쳐 서로 다른 revision의 보고를 만들지 않음 |
| [V3 보고](../src/core/cost-outcome-report.ts)와 [내보내기](../src/core/cost-outcome-export.ts) | 거래비 결과·신뢰 기준 고정·독립 재생/HOLD | 기존 V3 API·JSON·해시 의미 유지. V4를 V3로 형변환하지 않음 |
| [V4 운영비](../src/core/cost-operating.ts) | 예약·발생·지급·격리 입력·공통 현금 | 지급과 설명용 배분을 새 비용으로 차감하지 않음 |
| [D7 계산](../src/core/cost-operating-close.ts) | 명시 완전성 근거를 검증한 마감 계산 미리보기 | `persistedFinalization=false`이며 그 자체는 D8 영속 마감이 아님 |
| [D8 마감](../src/core/cost-finalization.ts) | 불변 체크포인트·확정 배분·한 번 적용한 손실 카운터 | 후속 현재 잔액과 분리. 재보고에서 카운터를 다시 적용하지 않음 |
| [D9 지급](../src/core/cost-post-close.ts) / [D10 부분 결제](../src/core/cost-partial-settlement.ts) | 체크포인트 이후 현재 계정·`currentOperating`·대상별 잔여 | 과거 `operating.effects`나 원래 posting의 결제 표지만으로 현재 미결제를 계산하지 않음 |

현재 D9/D10은 명시 선택한 상호 배타적 확장이다. 이때 기존 운영비 사건/거래 posting은 과거 근거로 보존되고, 후속 지급의 현재 결과는 확장 투영에 있다. 새 보고서는 이 차이를 감추지 않는다.

## 📋 보고 데이터 계약 — 다음 구현의 제안

제안 버전명은 `SYNTHETIC_OPERATING_REPORT_V1`, 메서드는 `operatingReport()`다. 구현 전 이름이 바뀌면 근거와 문서를 함께 정리하되 기존 버전 의미는 바꾸지 않는다. 금액은 정확한 일반 십진 문자열, 시간·revision은 기존 검증된 정수 형식이다.

| 영역 | 필수 내용 | 미확정 처리 |
| --- | --- | --- |
| `source` | TEST_ONLY, 계약/정책/config/state 해시, revision/epoch, records 해시/개수, 금융 관측 시각 | 불일치·미지원 config는 오류. 임의 초기화/복구 안 함 |
| `currentAccounts` | 통화별 C/R/P/Q 원자료와 가용현금, 현금성 순잔액 | USD 활성화나 미확인 환산 금액 생성 안 함 |
| `trades` | 원래 run/주문/체결 ID, 수량, 거래비, 거래 상태, 거래비 차감 중간 손익 | 미완료·UNKNOWN은 미완료. 운영비 포함 최종 손익과 구분 |
| `operating` | 발생액·지급액·미지급액·예약액, 원본 사건/근거 참조, 격리 사유 | 모르는 비용을 0으로 변환 안 함 |
| `finalization` | OPEN/FINALIZED/RECONCILING, D8 checkpoint 및 해시 또는 null | 체크포인트 없는 최종 배분·기간 순손익·최종 거래 순손익은 null |
| `followup` | NONE/D9/D10, 대상별 지급/잔여·증거 참조·관찰 종료 여부 | 기한 도달은 지급 증거 아님. 잔여·HOLD 유지 |
| `diagnostics` | 미해결 주문/예약·격리·배분 대기·중지 사유, 원자료 범위 | 모든 유효 보고도 운용/학습 관점에서는 HOLD |

`orderSubmissionAllowed`, `learningAllowed`, `liveEnabled`, `newSpendingAllowed`, `automaticResumeAllowed`는 모두 false다. 재생 성공과 운용 허용은 다르다. 정상 합성 검증을 실제 금융 증거 검증 또는 수익성 검증이라고 부르지 않는다.

금융 시각, 감시의 마지막 `lastPulseAt`, 보고 관찰 시각 `asOf`, 마감 시각/비용 이용 가능 시각을 구분한다. `asOf`는 명시 입력 또는 기록된 결정론적 기준을 쓰고 내보내기에 고정한다. `Date.now()`로 재생 해시를 바꾸거나 시간이 흘렀다는 이유로 새 시세·체결·마감을 생성하지 않는다. 기존 D9/D10의 시각 검증을 그대로 적용한다.

### 금액과 수익 표시

- C는 현금, R은 미수, P는 모든 현금성 미지급 의무, Q는 현금 예약이다. 기존 계정의 `payable`과 `unpaidFees`를 원자료로 분리 표시하고 P에 중복 없이 포함한다. Q는 기존 공통 계정의 총예약을 쓰며 운영비 예약을 다시 더하지 않는다.
- 현금성 순잔액은 `C + R - P`, 가용현금은 `C - P - Q`다. 예약은 비용이 아니다. **주식이 남아 있으면 현금성 순잔액은 총자산/NAV가 아니다.** 첫 구현은 새 시가평가·총수익률 계산기를 추가하지 않는다.
- 거래비 차감 중간 손익은 기존 종료 결과를 재검증해서 쓴다. D8 마감 전 운영비 포함 최종 손익은 null이며, 이미 인식된 운영비 채무가 없었던 것처럼 현재 현금을 표시하지 않는다.
- D8 이후에는 체크포인트의 원래 확정 배분/기간 순손익을 참조한다. 현재 지급 상태가 바뀌어도 확정 손익을 다시 계산·차감하지 않는다. 미지급 의무가 남아 있어도 기존 D8의 완전성 조건을 충족하면 마감 가능하다는 의미를 보존한다.
- 완료 거래 N=0이고 운영비 O>0이면 배분 목록은 빈 배열, 미배분은 O, 해당 기간 손익은 -O다. 가짜 손실 거래나 학습 표본을 만들지 않는다. 마감 근거 자체가 없으면 이 값도 확정값으로 표시하지 않는다.
- 배분 나머지는 기존 안정적 거래 ID 순서, 손실 카운터는 기존 종료 시각/revision 순서다. 둘을 같은 정렬로 합치지 않는다. 순손익 0·기존 중지·자동 재개 금지는 기존 계약을 따른다.
- 정확한 산술은 기존 BigInt/로컬 Decimal 설정을 재사용한다. 금액에 `Number`, 지수/NaN, 암묵 반올림을 사용하지 않는다. 입력 경계와 최대 항목 수에 따른 합산 정밀도를 시험하며 출력 한도를 넘으면 명시 거절한다. 전역 Decimal 정밀도는 바꾸지 않는다.

### 마감 미리보기와 확정값

첫 통합 보고는 `operatingClose(request)`를 자동 호출하지 않는다. D7은 별도 명시 미리보기이며, D8 체크포인트에 포함된 원래 D7 계산을 확정 근거로 참조한다. OPEN 보고에서 조회자가 `complete=true`나 현재 시간을 제공하는 것으로 최종 배분을 얻을 수 없어야 한다. 합성 manifest의 FULL_PERIOD_FROM_EMPTY 선언은 외부 브로커 자료의 완전성 증명이 아니다.

## 🔒 일관된 읽기와 독립 검증

제안 내보내기 버전명은 `SYNTHETIC_OPERATING_EVIDENCE_V1`, API 이름은 `exportOperatingEvidence()` / `verifyOperatingEvidence()`다. 아직 구현·제공하지 않는다.

1. Store의 단일 읽기 트랜잭션에서 config·initialEpoch·순서 있는 전체 명령/영수증·상태를 검증해 캡처한다. writer lease 취득/연장, 상태 수정, 명령 추가, 캐시 복구, 사용자 DB 마이그레이션은 하지 않는다. 새 읽기 보고에 별도 쓰기 테이블은 필요 없다.
2. 동일 snapshot에서 보고·`financialBasisHash`를 만든다. 보고 관찰 시각과 진단을 포함한 전체 보고는 `reportHash`로 구분한다. D8 `checkpointHash`는 이후 지급에도 불변이고 현재 보고 해시는 바뀔 수 있다. 해시별 포함 필드와 자기 해시 필드 제외 규칙을 구현 스키마/시험에서 명시한다.
3. export는 버전·config·정책 해시·initialEpoch·전체 records·보고와 해시·고정 false 권한을 포함한다. 명령은 기존 CAS/epoch/commandId와 원래 영수증을 보존한다. 보고만 보내거나 격리/빈 거래/감시 기록을 조용히 빼지 않는다. raw 격리 입력은 로컬 근거일 뿐 외부 전송 승인이 아니다.
4. verifier는 파일과 **별도로 신뢰한 config 및 exportHash**를 필수 인수로 받는다. 같은 입력 JSON 안에서 anchor를 꺼내 자체 승인하면 안 된다. pinned config에는 기존 확장 옵션·고정 결제 증거 목록과 그 해시도 포함된다. hash는 서명이나 데이터 공급자 인증이 아니다.
5. 바이트/깊이/노드/항목 한도와 엄격한 스키마를 먼저 검사한다. 알 수 없는 필드·모드, 누락·중복 ID·순서/CAS/epoch/영수증 불일치, 현재 조합으로 금지된 옵션을 거절한다. 더 최신 anchor에 대한 오래된 export도 거절한다. 명령을 누락하거나 재해시해 맞춘 파일은 신뢰한 pin을 통과하지 못해야 한다.
6. 기존 초기화/명령 분기와 reducer를 재사용해 처음부터 재생한다. D8 명령에는 그 명령 **직전 prefix records**만 넘겨 원래 manifest를 대조하고, D9/D10은 원래 불변 basis와 증거 목록으로 검증한다. persisted records 안의 중복 command/fill/payment를 새 정상 사건으로 인정하거나 임의 제거하지 않는다. 정상 writer 재전송이 원래 영수증을 반환하는 동작과 구분한다.
7. 재구성한 상태·보고·해시를 export와 대조한다. 성공은 `VERIFIED_SYNTHETIC_REPLAY` 수준의 검증 표시와 HOLD/권한 false만 반환한다. 실패는 명시 오류로 끝내며 거래값을 보정하지 않는다. 이 verifier는 DB에 연결하지 않는다.

이 독립성은 **DB·저장된 보고/캐시에 의존하지 않는 재생**이다. 같은 reducer를 재사용하므로 독립 금융 모델 검증은 아니다. 산술의 별도 BigInt 기대값 시험을 함께 둔다. 캡처 시 DB 감사/인덱스를 검사한 사실과, portable export가 DB 파일·전체 감사 테이블의 포렌식 증명인 것은 구별한다.

### 자원과 파일 경계

기존 계약별 명령 상한을 그대로 적용한다. V4 기본 상한은 5,200+100, D8은 여기에 1+100, D9는 대상 최대5,300, D10은 대상당 최대3사건으로15,900 슬롯을 더하는 구조다. D9/D10을 동시에 더하지 않으며 각 사건 종류별 하위 제한도 유지한다. S7 틱4,096·감시64 제한을 늘리지 않는다. export 최대 개수 검증만으로 이 제한들을 대신할 수 없다.

첫 export의 방어 예산은 기존 V3의 16MiB·깊이64·500,000노드 제한을 출발점으로 삼는다. 합법적인 최대 장부라도 이보다 클 수 있으므로 **모든 합법 장부의 내보내기 성공을 약속하지 않는다**. 초과하면 원장 불변 상태에서 명시 거절하고 잘라내거나 허위 성공을 반환하지 않는다. 최대 크기/실행 시간은 별도 측정하며 장중 SLA를 주장하지 않는다.

첫 S8-B는 검증된 메모리 JSON 생성·순수 verifier까지다. 파일 저장 CLI/HTTP/UI는 제외한다. 후속 파일 연결 때는 [기존 파일 경계](../src/server/cost-outcome-file.ts)의 로컬 경로·링크/재분석 지점·새 파일 전용·부분 파일/완료 파일 구분을 재사용해 인수한다. V4 JSON을 V3 파일 함수에 억지로 전달하지 않는다.

## 🧪 독립 검산 기준

아래 tuple은 `[C,R,P,Q]`다. E 표기는 포지션 평가를 제외한 **현금성 순잔액**이며, Av는 가용현금이다. 제품 결과를 복사해 기대값을 만들지 않고 별도 고정소수 BigInt로 검사한다. 후속 지급 사례는 마감 자체를 다시 계산하는 것이 아니다.

| 사례 | 전 → 후 tuple | E 전 → 후 | Av 전 → 후 |
| --- | --- | --- | --- |
| OP-PAY | [1000,0,50,0] → [950,0,0,0] | 950 → 950 | 950 → 950 |
| SELL-AR | [900,120,0,0] → [1020,0,0,0] | 1020 → 1020 | 900 → 1020 |
| BUY-AP | [1000,0,100,0] → [900,0,0,0] | 900 → 900 | 900 → 900 |
| SELL-FEE | [1000,0,0.4,0] → [999.6,0,0,0] | 999.6 → 999.6 | 999.6 → 999.6 |
| PARTIAL | [1000,0,50,0] → [980,0,30,0] | 950 → 950 | 950 → 950 |
| THREE | [1000,120,150,0] → [970,0,0,0] | 970 → 970 | 850 → 970 |
| RECOGNIZE | [1000,0,0,50] → [1000,0,50,0] | 1000 → 950 | 950 → 950 |
| PAY-Q | [1000,0,50,40] → [950,0,0,40] | 950 → 950 | 910 → 910 |

OP-PAY～THREE는 기존 결제 항등식 사례다. RECOGNIZE는 예약50의 의무 인식, PAY-Q는 다른 예약40을 유지한 지급이다. 이 두 사례는 마감 전 개념 검산이며 예약0을 요구하는 D9/D10 마감 후 입력으로 주입하지 않는다. N=0/O=50은 미배분50·기간손익-50·완료거래0이고, 보유 주식이 있는 C=900인 계정을 자동으로 NAV=900이라고 표시해서는 안 된다.

## ✅ 단계별 최소 인수

아래는 **향후 제품 인수 조건**이다. 이번 S8-A의 기존 시험 재실행/문서 검산 통과를 이 표의 구현 통과로 세지 않는다.

### S8-B — 기존 지원 V4 조합의 읽기 보고·메모리 export/verifier

| ID | 완료 조건 |
| --- | --- |
| OR-01 | 기본 V4·S7·명시 D8·D9 또는 D10을 한 snapshot으로 조회. query_only 읽기 및 금융/감사/lease 불변 확인 |
| OR-02 | 운영비 예약→인식→지급, 거래비/미배분/최종 손익, 열린 포지션/UNKNOWN·N=0을 정확히 구분. 독립 산술 대조 |
| OR-03 | D7 미리보기와 D8 영속 마감 구분. 지급 전후 현재 잔액은 변하되 checkpoint·배분·손실 카운터 불변. D9/D10 현재 비용/잔여는 확장 투영에서 읽음 |
| OR-04 | 모든 지원 조합의 원래 config/records를 DB 없는 verifier로 재생. 부분 결제·원래 prefix·S7 원자 틱/재전송 영수증 보존 |
| OR-05 | anchor 누락/교체·낡은 export·명령/체결/지급 중복·변조·누락·재정렬·epoch/CAS 오류·보고 재해시 위조 거절 |
| OR-06 | 크기/깊이/개수·금액 정밀도 경계, 초과 명시 거절 및 원장 불변. unsupported config/권한 true/추가 필드 거절 |
| OR-07 | 기존 V3 보고/export와 D8~D10 회귀·원본 정책 보존. 모든 성공 결과 HOLD/권한 false, 설명·진행률·실행 검사/한계 기록 |

최소 변경 후보는 새 V4 보고/내보내기 모듈과 Store의 읽기 메서드다. 초기화/명령 분기 공유가 필요하면 기존 저장 형식/해시/영수증이 불변인 작은 추출만 허용한다. 새 주문/금융 쓰기 메서드·DB migration·시간 감시 변경·자동 HOLD 해제·새 학습 표본은 범위 밖이다. 실제 구현 파일/이름은 코드 대조 후 확정한다.

### S8-C — 이후 S7과 마감의 명시 결합

S8-B를 통과해도 S7+D8/D9/D10 조합 거절은 그대로다. 아래는 다음 금융 연결의 인수 조건이지 이번 실행 승인이나 신규 지원 선언이 아니다.

- 새 명시 opt-in 계약으로만 생성하고 기존 실행은 전환하지 않는다. S7과 결합된 단일 마감 경로부터 인수하며 D9/D10 결합은 각각 실제 시험으로 확인한다.
- runtime을 정지/직렬화한 뒤 CAS/epoch로 일관된 마지막 상태를 확정한다. 정지는 청산이 아니다. 실제 수량0·종결 주문·예약 해소·완전한 합성 기간 근거 없이는 마감을 거절한다. UNKNOWN이나 열린 노출을 시간 만료로 없애지 않는다.
- 기존 D8의 단일 COMMIT·closeId/hash 충돌·재시도 원래 영수증·손실 카운터 한 번 적용을 유지한다. 경합하는 tick/pulse/마감의 양쪽 순서와 저장/COMMIT 실패를 검증한다.
- 마감 뒤 S7 tick/pulse/신규 거래를 허용하지 않는다. raw 후속 입력과 명시 D9/D10 결제만 각각 원래 계약으로 처리하며 과거 checkpoint를 수정하지 않는다. 관찰 기한 후 잔여를 자동 소거하지 않는다.
- 보고/export는 결합 계약을 명시적으로 인식하고 같은 원장/근거로 재생한다. 단순히 초기화 guard를 삭제해서 기존 schema에 숨기지 않는다. 모든 운용/학습/재개 권한 false를 보존한다.

그 뒤에 비영20위험일 이력 후보 심사 → 새 합성 학습 입력/HOLD → 앱 관통의 S6 잔여 인수를 진행한다. 현재 문서 완료는 D03-03/04 전체 완료나 실제 API 연결 준비 완료가 아니다.

## ▶️ 다음 작업에 사용할 실행 지시

```text
docs/COST_OPERATING_REPORT_AND_REPLAY.md와 최신 PROGRESS/실행 가이드를 읽고
DEV-D03-S8-B만 구현·검증한다.
기존 지원 V4 config에서 한 검증 snapshot의 네이티브 보고,
메모리 JSON export, DB 없는 pinned-anchor 재생 verifier를 제공한다.
현재 잔액·거래비 중간 결과·미배분 비용·D8 불변 마감·D9/D10 현재 지급을 분리한다.
OR-01~07을 실제 시험하고 기존 V3 형식/해시 및 정책 원본을 보존한다.
S7-마감 새 조합, 파일 CLI/HTTP/UI, 새 후보 승인/학습, 미정 정책은 구현하지 않는다.
실제 API/계좌/키/수집/유료 AI/실주문/사용자 DB는 사용하지 않는다.
필요한 최소 공유 추출 외 무관한 리팩터링은 하지 않는다.
완료 기능·실행 검사·미검증·다음 한 작업과 진행률을 구분해 보고한다.
```

이번 명세 대조·선택 회귀·독립 검산·문서 보존/표시 확인의 실제 결과는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)에 기록한다. S8-A 내부 완료율과 제품 전체 진척을 중복 합산하지 않는다.
