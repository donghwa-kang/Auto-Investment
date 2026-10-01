# 마감 후 부분 결제·잔여액 추적 — D10-B

2026-09-27 · 개발자용 로컬 합성 KRW 확장 · 검증 결과는 PROGRESS 참조

---

[D10-A 계약](COST_SETTLEMENT_ADJUSTMENT_CONTRACT.md) 중 **부분/잔여 전액 결제만** 구현한다. 50원 의무를 20원 지급하면 30원 채무가 남고, 이후 30원 지급으로 종료한다. 지급은 이미 인식한 비용을 다시 손실로 만들지 않는다. 비용 조정·환급·순액 상계·관찰 창 연장·실계좌 연결은 제공하지 않는다.

## 🎯 지원 범위

| 제공 | 여전히 미지원 |
| --- | --- |
| 새 명시 합성 KRW 실행에서 한 대상의 증분 지급/수령 | 기존 D9 DB 이관·설정 변경·USD/FX |
| 고정 합성 증거 목록과 원천 지급 식별자 대조 | 실제 공급자 인증·누락 없음 증명·계좌 API |
| OPEN/PARTIAL/SETTLED와 원금·누계·잔여액·마지막 revision | 소액 자동 상각·수수료 역산·임의 금액 조정 |
| 같은 Store/DB의 원자 저장·전체 재생·중복 영수증 | HTTP API·제품 outbox·웹 버튼·자동 재개 |

D10-B는 장기 계획의 DEV-D10 배포 단계가 아니라 DEV-D03 내부 작업이다. D9의 전액 계약과 기본 D8 해시를 보존한다. 새 `partialSettlement` 옵션을 빈 실행 초기화 전에 명시하며, `postClose` 옵션과 함께 설정하면 거절한다. 구형 실행에 옵션을 넣어 열거나 관찰 종료를 늘려 재시도하는 기능은 없다.

## 🔧 설정과 개발자 함수

구현은 [부분 결제 모듈](../src/core/cost-partial-settlement.ts)과 [기존 Store](../src/server/cost-reservation-store.ts)에 있다. D9와 공유하는 것은 원래 마감의 불변 기준점 추출이며, D9의 대상당1회 투영에 부분 사건을 넣지 않는다. DB 테이블을 추가하거나 기존 데이터를 마이그레이션하지 않는다.

| API/설정 | 의미 |
| --- | --- |
| `partialSettlementContractHash` | 별도 합성 계약 해시 |
| `OperatingConfig.partialSettlement` | contractHash, followupEndExclusive, evidenceHash, evidence |
| `partialSourceEventKey(scope, paymentId, lineId)` | 공급자/계정/namespace와 불변 지급 ID·행 ID의 버전 고정 해시 |
| `store.settlePartial(commandId, command, expectedState)` | 입력·현재 상태·원천 증거·잔여액 검증 후 같은 COMMIT |
| `store.partialSettlementReport(asOf)` | 전체 저장 이력 재검증 뒤 분리된 현재 보고 반환 |

`evidence`는 원천 paymentId/lineId·sourceEventKey/sourceHash·대상 참조·사건 종류·증분 receivable/payable·occurredAt을 가진 고정 fixture 목록이다. 목록 해시와 전체 configHash를 묶고, 마감/실행 해시를 목록 행에 역참조하지 않아 순환을 피한다. unknown 필드·중복 키·잘못된 해시/시각·15,900행 초과는 초기화 전에 거절한다. 생성자 인수와 반환 객체를 바꿔 private 설정을 변경할 수 없도록 분리한다.

이 목록은 테스트 작성자가 미리 준비한 지급 사실 대조표다. 원장으로부터 지급 사실을 자동 생성하는 기능이 아니며, 미래 시장 정보/전략 입력이나 실제 브로커 인증으로 사용할 수 없다. 실제 네트워크 연결에는 독립된 출처·권한·지급 식별자·보존 계약이 필요하다.

명령 종류는 `SETTLE_PARTIAL_TARGET` 또는 `CONFIRM_ZERO_TARGET`이다. 대상은 운영비 obligationId 또는 체결 runId/fillId로 참조한다. 실제 마감의 targetKey/originalHash, 확장/configHash·sourceScope/KRW·closeId/checkpointHash와 일치해야 한다. 모든 필드는 [엄격한 스키마](../src/core/cost-partial-settlement.ts)를 따른다. 금액은 Number가 아닌 문자열이다.

## 💰 현재 잔액과 과거 결과

| 상태/금액 | 계산·보존 규칙 |
| --- | --- |
| 원래 미수/미지급 | D8 마감 당시 금액·원본 해시 불변 |
| 수령/지급 누계 | 증거가 있는 증분만 한 번 합산 |
| 잔여 미수/미지급 | 원금−누계, 음수/초과 지급 거절 |
| 공통 현금 C | 기준 현금+수령 r−지급 p |
| E와 가용 현금 | E=C+R−P 불변, Available=C−P−Q. 미수는 수령 전 가용액 제외 |
| 과거 비용/보고/손실 횟수 | 원래 source/operating events/effects·checkpoint·카운터 변경 없음 |
| 현재 운영비 | incurred 불변, paid 증가/payable 감소. 보고 배분 재차감 없음 |

열린 포지션/예약이 없는 합성 장부 범위다. 원래 양수 대상은 OPEN→PARTIAL→SETTLED로 추적하며 전액이면 OPEN→SETTLED도 가능하다. 원래 양쪽0인 대상만 명시 0원 확인으로 종료한다. 양수 원금에 0원 사건을 반복 추가할 수 없다.

운영비 지급은 기존30자리 이내 정수 원화, 체결은 정수60/소수40자리 이내 문자열을 사용한다. 국소 Decimal 정밀도128로 처리하며 전역 설정은 바꾸지 않는다. 작은 차액을 버리지 않고 결과 표현 범위를 넘으면 거절한다. 이 구현은 실제 계좌 NAV·외부 부족 잔액/음수 가용액을 인증하는 것이 아니다.

## 🔐 중복·시각·자원 경계

이미 저장된 commandId는 epoch 정규화 외 전체 원래 입력이 같아야 원래 영수증을 반환한다. 같은 업무 ID 또는 안정적인 원천 지급 키가 재등장하면 금융 의미를 비교한다. 같으면 새 금융/감사 행 없이 원래 영수증과 **최신 상태**를 반환하고, 바뀌면 충돌이다. 두 키가 서로 다른 원래 사건을 가리키는 교차 재전송도 거절한다.

새 전달 ID로 재전송해도 반환의 `originalCommandId/originalBusinessEventId`는 최초 저장 건을 가리킨다. 새 별칭 ID는 예약/저장하지 않으므로 호출자는 복구에 최초 요청을 보존해야 한다. 같은 금액의 서로 다른 지급은 별개 원천 증거가 있을 때만 별도 수용한다. 문서 재발행 ID를 새 지급 ID로 만들지 않는다.

새 사건은 `마감 ≤ occurred ≤ available ≤ received ≤ posted < 종료`, posted≥현재 논리 시계다. 원문 intake도 종료 상한을 유지한다. 발생 순서가 역전돼 수신돼도 사실 시각은 바꾸지 않고 posted는 동률을 허용한다. 정확한 과거 중복은 현재 종료 뒤에도 원래 영수증을 복구한다. 종료 뒤 조회가 가능하다는 사실은 신규 결제 허용이 아니다.

대상당 **미완결 부분2개+잔여 전액 종료1개**를 허용한다. 세 번째 부분은 거절하지만 종료 슬롯은 남긴다. 원문100개 포화와 금융 슬롯은 분리된다. 0원 대상은 종료1개만 사용한다. 총 사건은3M, M≤5,300으로 제한하며 재시작/새 ID로 예산을 초기화하지 않는다. 이는 합성 검증용 한도이지 실제 지급 횟수 가정이 아니다. 초과 사건을 실제로 받는다면 별도 대사/보존 처리 인수가 필요하다.

저장은 기존 writer/epoch/lease의 단일 COMMIT으로 명령·영수증·감사·대상 누계/현재 캐시를 함께 반영한다. 거절은 금융/시계 변경 없음이며 원문 자동 저장을 뜻하지 않는다. `postCloseInput`을 별도로 호출하고 그것도 거절되면 호출자가 원문을 보유해야 한다. 현재 HOLD/학습/주문 권한 false는 결제 종료로 해제하지 않는다.

## 🧪 합성 실행 예제

프로젝트 루트의 기존 설치 환경(Node24.20.0, npm11 계열)에서 엔진을 컴파일한다. 새 설치·다른 운영체제 검증은 별도다. 아래 JavaScript는 테스트 helper의 메모리 DB만 사용하며 실제 자금을 움직이지 않는다.

```powershell
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/cost-partial-settlement.test.js dist/runtime/tests/cost-partial-settlement-failure.test.js
```

아래를 프로젝트 루트에서 `node --input-type=module`의 표준입력으로 실행한다.

```javascript
import assert from 'node:assert/strict';
import { hash } from './dist/runtime/src/core/policy.js';
import { closedPartial, partialCommand } from './dist/runtime/tests/cost-partial-settlement-helpers.js';
const f = closedPartial();
try {
  const s = f.store.read();
  const original = hash(s.finalization.checkpoint);
  const request = partialCommand(s);
  const first = f.store.settlePartial('part', request, s);
  const p = first.current.partialSettlement.progress[0];
  console.log(p.status, p.remainingPayable);
  const retry = f.store.settlePartial('part', request, s);
  assert.deepEqual(retry.receipt, first.receipt);
  const next = first.current;
  const second = f.store.settlePartial('remainder', partialCommand(next, 1), next);
  const report = f.store.partialSettlementReport(second.current.seed.clock);
  assert.equal(hash(report.checkpoint), original);
  assert.equal(report.operating.incurredKrw, '50');
  console.log(report.targets[0].status, report.targets[0].remainingPayable,
    retry.duplicate, report.status, report.liveEnabled);
} finally {
  f.repo.close();
}
```

기대 출력:

```text
PARTIAL 30
SETTLED 0 true HOLD false
```

## 🔍 검사 범위와 오류 대응

실제 검사 수·로그·실패 수정·전체 회귀 결과는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)를 따른다. 아래는 인수 범위이며 합성 시험을 실환경 보증으로 해석하지 않는다.

| 계약 인수 | 검사 범위 |
| --- | --- |
| SA-01/02 | 새 옵션·구형 거절·객체 격리·운영비 부분/잔여 지급·체결 원장 미수/미지급/SELL 부족분 |
| SA-03/04 | 0원 원대상·금액/증거/범위 거절·요청/업무/원천 중복·동액 다른 지급 |
| SA-05/06 | stale 상태·경합·초과 지급·raw100 포화 후 종료 슬롯·재시작 |
| SA-07 | 반열린 기간/동률·순서 역전·미래 raw 차단·기간 뒤 잔여 보고/중복 복구 |
| SA-08/09 | 쓰기 단계별 rollback/golden·SQLite FULL·COMMIT 전후 cold restart·변조 재생 거절 |
| SA-10/16 | 정확 산술/표현 경계·관련 회귀·원본/문서/사용 예제 |

`PARTIAL_EVIDENCE_MISMATCH`는 근거 목록과 명령의 불일치다. 사건을 고쳐 성공시키거나 목록을 기존 DB에 덮지 말고 원천 근거와 대상부터 대조한다. `LOCAL_REAPPROVAL_REQUIRED`이면 새 사건은 최신 검증 상태로 재검토한다. 이미 성공했을 가능성이 있으면 새 사건을 만들지 않고 원래 요청으로 먼저 복구한다.

`PARTIAL_REMAINDER_EXCEEDED`는 대상 완료/잔여 초과다. 요청을 잔액에 맞춰 자르지 않는다. `PARTIAL_TERMINATION_SLOT_RESERVED`이면 추가 부분은 한도 밖이지만 별도 증거가 있는 잔여 전액은 가능하다. 시간/저장 공간/증거 문제를 재시도 루프로 숨기지 않는다. 원문 보관 성공 여부와 실제 금융 반영 여부를 구분한다.

## 🚧 미완료와 다음 단계

정정·환급·새 비용/순액 상계, 늦은 자료의 기간 귀속/보고 재판정, 관찰 기간 밖 이관은 아직 미지원이다. 다음은 [D10-A의 OC-U05/U07 선택 경계](COST_SETTLEMENT_ADJUSTMENT_CONTRACT.md)를 바탕으로 조정 종류·권한·기간 귀속·중지 유지의 구체 선택을 정리하는 작업이다. 임의 기타손익·1원 무시·새 관찰 창·다일 매매를 자동 활성화하지 않는다.

실제 API·지급 증거·제품 HTTP outbox·다중 실행/파일 총량·최대 Store 이력 부하·장기/OS 정지·물리 정전·새 설치·앱 E2E·실제 수익성은 미검증 또는 미구현이다. 합성 원천 목록과 파일 기반 시험 재시작을 실제 출처 인증/영구 outbox로 부르지 않는다. 누적158/167·D03 2/4·장기 계획10/40은 유지하며 키/계좌 발급은 필요 없다.
