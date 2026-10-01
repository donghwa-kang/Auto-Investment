# 합성 운영비 원자 마감 — D8

2026-09-26 · DEV-D03 내부 부분 인수 · TEST_ONLY

## 📋 제공 범위

새 합성 KRW 실행에서 명시적으로 선택한 D8 확장은 [D7 마감 계산](COST_OPERATING_CLOSE_REPORT.md)을 저장 직전에 다시 수행하고, 결과와 실제 손실 카운터를 **같은 writer 트랜잭션**으로 확정한다. 기존 V4 기록을 자동 이관하지 않으며 원본 거래 기준·비용 계산·중지 조건을 바꾸지 않는다.

구현은 [마감 reducer](../src/core/cost-finalization.ts), [Store](../src/server/cost-reservation-store.ts), [39개 시험](../tests/cost-finalization.test.ts), [자식 종료 fixture](../scripts/cost-finalization-crash-fixture.mjs)에 있다. 웹 UI·학습·실제 공급자·계좌에는 연결하지 않았다.

### 명시 계약

새 `OperatingConfig`에 `finalization: { contractHash: finalizationContractHash }`를 지정한다. V4 기반 `kind`는 유지하지만 설정 해시가 달라지는 **별도 선택 확장**이다. 옵션 없는 기존 실행은 D8 명령을 수용하지 않고, 기존 DB를 옵션만 바꿔 다시 여는 것도 설정 불일치로 거절한다. 지원하지 않는 해시나 V1/V2/V3에 옵션을 넣어 우회할 수 없다.

운영비가 도입된 뒤의 신규 진입 HOLD, 원래 HALT·재진입 대기·위험 이력은 그대로 남는다. 마감 성공은 다음날 거래 재개나 실제 주문 허가가 아니다. `orderSubmissionAllowed`, `learningAllowed`, `liveEnabled`는 여전히 false다.

## 🧮 확정 값과 보존 값

마감 전 검증된 전체 명령·영수증·감사·체결 인덱스·캐시를 재생하고, 같은 쓰기 트랜잭션 안에서 신뢰된 합성 전체기간 manifest와 대조한다. 호출자가 계산한 손익이나 손실 횟수를 받아 쓰지 않는다. 열린 주문/포지션·예약·격리·불완전 근거는 마감 거절이며 일부 행만 성공 처리하지 않는다.

| 위치 | 마감 후 의미 |
| --- | --- |
| `finalization.checkpoint.report` | 마감 직전 원자료로 다시 계산한 D7 보고의 불변 사본. 배분·최종 순손익·손실 순서를 보관 |
| `finalization.checkpoint.counterApplied` | true. 같은 COMMIT에서 카운터를 적용했다는 D8 기록 |
| `seed.ledger.lossStreak` | 보고의 `projectedLossStreak`로 실제 갱신되는 공통 원장 카운터 |
| `operating.allocationStatus`, 기존 최종손익 필드 | D6 역사적 사실로 HOLD/null 유지. D8 확정 결과는 위 체크포인트에서 읽음 |
| 기존 `outcomes`의 `counterApplied` | D6 당시의 false를 보존. D8 적용 여부를 대신하는 필드가 아님 |
| 체크포인트 안 D7 보고의 `counterApplied` | 읽기 전용 투영 계약의 false 보존. 바깥 D8 체크포인트의 true와 구별 |
| 현금·미수/미지급·운영비 의무·거래비 손익 | 그대로 유지. 비용 배분을 현금 차감으로 또 적용하지 않음 |

거래비 손익 +2/+2와 운영비6이면 최종 -1/-1, 카운터2다. 거래 종료 시각과 동시각 revision 순서로 판정한다. 기간 중 2연속 손실을 만난 뒤 이익으로 최종 횟수가0이 되어도 `CONSECUTIVE_LOSSES` 검토중지는 남는다. 기존 중지도 해제하지 않는다. 거래0건은 가짜 손실 거래를 만들지 않고 운영비 전부 미배분, 초기 카운터 유지다.

명령·체크포인트·카운터·revision/epoch·감사·인덱스 저장은 기존 Repository의 동일 COMMIT 경계다. 저장 도중 오류나 lease 만료는 전부 롤백한다. 재열기는 전체 명령 재생과 저장 결과를 대조한다. 논리 시각 `appliedAt`은 요청의 합성 `asOf`이며 실제 시계의 서명된 실행 증명이 아니다.

## 🔁 ID 재전송과 상태

`finalizeOperating(commandId, closeId, request, expectedState)`가 쓰기 진입점이다. 최초 호출은 최신 상태 해시/revision과 유효 writer 소유권이 필요하다. 동일 `closeId`와 동일 요청 전체 해시의 재전송은 새 명령 ID·새 epoch·이전 expectedState여도 원래 영수증과 현재 상태를 반환하고 `duplicate=true`다. 재전송도 유효 writer 소유권과 DB 재검증을 생략하지 않는다.

다른 closeId, 같은 closeId의 변경된 요청(`asOf` 포함), 다른 종류 명령에 이미 사용한 commandId는 충돌로 거절한다. 재시도 때 원래 request를 보관해 재사용해야 한다. 마감 후 상태로 manifest를 새로 만들어 바꾸는 것은 동일 재전송이 아니다.

| 상태 | 허용되는 다음 처리 |
| --- | --- |
| `OPEN` | 기존 합성 사건 처리 또는 근거가 완전한 최초 마감 |
| `FINALIZED` | 검증 읽기·동일 마감 재전송·후속 원문 격리. 새 금융 변경 불가 |
| `RECONCILING` | 후속 원문 때문에 검토 대기. 기존 체크포인트 불변, 재마감/자동 재개 불가 |

마감 후에는 `store.read().finalization.checkpoint`를 읽는다. 기존 `operatingClose()` 재투영은 거절한다. 알려진 동일 체결/운영비 사건 등의 재전송은 원래 영수증을 반환할 수 있지만 돈이나 카운터를 다시 반영하지 않는다.

## ⚠️ 후속 자료와 미지급 보존

이번 D8은 마감 후 지급·결제의 **실제 반영을 지원하지 않는다**. 새 PAY(지급)/SETTLE·관측·예약 등 기존 금융 쓰기 API는 예외를 반환하며, 미지급 의무나 미결제 채권을 삭제하거나 지급 완료로 만들지 않는다. 이 API들이 원문을 자동 격리하는 것은 아니다.

후속 자료를 보존하려는 호출자는 별도 `postCloseInput(commandId, rawJson, observedAt, expectedState)`를 호출해야 한다. 수용된 원문과 관측 시각은 같은 COMMIT으로 보관하고 `POST_CLOSE_RECONCILIATION_REQUIRED`를 추가한다. 상태는 RECONCILING이 되지만 기존 현금·채무·체크포인트·카운터는 바뀌지 않는다. 같은 마감을 재전송해 이 HOLD를 없앨 수 없다.

후속 입력은 실행당 최대100개, 원문 하나당 기존 제한인8,192 UTF-8 bytes다. 관측 시각은 현재 논리 시계보다 앞설 수 없다. 초과/역전/마감 전 입력은 예외이고 DB에 보관되지 않으므로 호출자가 원문을 유지해야 한다. 이 한도는 메모리·저장 자원 경계이지 거래 한도 변경이 아니다. 별도 마감1개+격리100개 슬롯을 두어 기존 매매5,200개/운영비100개 명령 예산을 소급 확장하지 않는다.

전체 재생·해시 검사는 서명이나 악의적 DB 관리자에 대한 인증이 아니다. `FULL_PERIOD_FROM_EMPTY`는 합성 시험 작성자가 빈 시간까지 알고 있다는 전제이며 실제 공급자의 누락 없음 증명이 아니다. 임의 DB를 자동 봉인하는 제품 기능은 없다. 내부 순수 reducer를 직접 호출한 결과는 Store의 재생·트랜잭션 검증을 대신하지 못한다.

## 🔧 개발자 실행 예제

프로젝트 루트의 기존 설치 환경(Node24.20.0/npm11)에서 `npm run build:engine` 뒤 아래 JavaScript를 `node --input-type=module` 표준입력 또는 프로젝트 안 `.mjs`로 실행한다. 테스트 전용 helper로 메모리 DB에 거래비 손익+2·운영비3의 **합성 한 거래**를 만든다. 실제 DB나 API 키를 사용하지 않는다.

```javascript
import assert from 'node:assert/strict';
import { openedOperating } from './dist/runtime/tests/cost-operating-helpers.js';
import {
  finalizationConfig, closedFixture, closeRequest,
} from './dist/runtime/tests/cost-finalization-helpers.js';

const f = openedOperating(finalizationConfig());
try {
  closedFixture(f);
  // Test author knows the entire synthetic day, including empty intervals.
  // This helper is NOT a real-provider completeness certification tool.
  const request = closeRequest(f);
  const before = f.store.read();
  const first = f.store.finalizeOperating('close', 'period', request, before);
  const retry = f.store.finalizeOperating('retry', 'period', request, before);
  assert.deepEqual(retry.receipt, first.receipt);
  assert.deepEqual(retry.current, first.current);
  assert.equal(first.current.finalization.checkpoint.counterApplied, true);
  console.log(first.current.finalization.status,
    first.current.seed.ledger.lossStreak, retry.duplicate, first.current.liveEnabled);
} finally {
  f.repo.close();
}
```

기대 출력: `FINALIZED 1 true false`.

전용 검사:

```powershell
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/cost-finalization.test.js
```

실제 검사 결과·전체 회귀·원본 보존·초기 실패/수정 이력은 [PROGRESS · 공개 요약](PROJECT_STATUS.md)에 기록한다. 자식 프로세스 종료 시험은 자신이 만든 합성 DB/자식만 대상으로 하며, 실제 OS 격리·물리 전원 차단·하드웨어 디스크 장애 시험을 대신하지 않는다.

## 📍 다음 인수

후속 [D8 적대 경계 보강](COST_FINALIZATION_HARDENING.md)은 자동 롤백 오류 보존·포화 입력 조기 차단과 실제 프로세스 잠금/소유권 교체·응답 유실·비용 재시도 검사를 다룬다. 원래 마감 계약과 금융 값은 바꾸지 않는다. 외부 API·실계좌·대규모/장기 운영 검증과 구별한다.

마감 이후 검증된 지급·결제는 아래 D9의 별도 선택 계약으로 분리했다. 기존 체크포인트·배분·손실 카운터를 재적용하지 않고 현금/채무만 바꾼다. 새 비용·정정·늦은 자료의 재배분은 OC-U05/U07 등 미결정 선택을 임의 확정하지 않는다.

후속 D9-A(2026-09-27)는 [지급·결제 계약과 PC 인수 조건](COST_POST_CLOSE_SETTLEMENT_CONTRACT.md)을 정의하며 [D9-B 구현](COST_POST_CLOSE_SETTLEMENT.md)은 새 명시 합성 실행에서만 알려진 원화 의무/체결의 전액 결제를 같은 Store에 연결한다. **이 문서의 기본 D8 차단 동작은 불변**이고 옛 PAY/SETTLE 경로를 다시 열지 않는다. 다음은 조정·부분 결제·관찰 기간 밖 미결제 이관의 사전 계약이다.

다일·USD·환불·정정·실제 자료 완전성, 후보 운영비 추정 경제성, V4/D8 학습 입력·앱/UI·자동 재개·수익성은 이번 인수 밖이다. 현재 단계에 API 키나 계좌는 필요하지 않다. D8 내부 완료율과 DEV-D03 전체 통합/전체 계획 진행률을 구별한다.
