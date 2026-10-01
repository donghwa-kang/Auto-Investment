# 원화 운영비 공통 장부 사용 안내 — D6

2026-09-25 · DEV-D03 부분 통합 · 합성 KR/KRW 전용 개발자 API

새 계약 `SYNTHETIC_KRW_OPERATING_LEDGER_V4`는 매매와 운영비가 **하나의 초기 현금**을 사용하도록 연결한다. 운영비 예약·의무 인식·지급·해제, 미지원 자료 보존과 신규 진입 HOLD를 기존 Repository의 동일 writer/epoch/lease 및 COMMIT에 기록한다. 실제 비용 지급이나 증권사 주문을 실행하는 기능이 아니다.

사용자는 [D5 선택안](OPERATING_COST_INTEGRATION_DECISIONS.md)의 U08-A/U06-A 권장 조합에 “그렇게 진행해줘”로 동의했다. D6는 그중 공통 장부·원자 저장/재생과 최소 청산 보류 경계만 구현한다. **기간 마감·확정 배분·최종 연속손실 재판정은 아직 없다.** 원본 정책과 V1/V2/V3의 저장 의미·해시는 유지한다.

## 🎯 현재 제공 범위

후속 D7(2026-09-26): [읽기 전용 마감 보고](COST_OPERATING_CLOSE_REPORT.md)가 합성 전체기간 manifest 대조·배분·최종 손실 투영을 추가했다. 아래 D6의 저장 계약은 그대로이며 **원장 마감/카운터 확정은 아직 미지원**이다. D7 계산 성공으로 기존 HOLD를 해제하지 않는다.

| 항목 | D6 동작 | 제외 범위 |
| --- | --- | --- |
| 실행 | 빈 Repository에서 명시적으로 새 V4 생성, KR/KRW, KST 09시 기준 한 위험일 안의 합성 시각 | 기존 DB 변환, USD·다일 실행, 새 실계좌 연결 |
| 운영비 | RESERVE / RECOGNIZE / PAY / RELEASE, 정수 KRW, 하나의 채무를 전액 인식·지급 | 분할 지급, 정정·환불, 실제 구독 결제 |
| 현금 | 매매 결제 이익/손실과 운영비의 지급·채무·예약을 공통 잔액에서 대조 | 보조장부 초기 잔액 합산, 미수금의 가용현금 간주 |
| 저장 | 명령·금융 효과·ID 중복 검사·보류·감사·writer 갱신의 원자 기록, 전체 명령 재생 | 실제 OS 격리, 전원 차단·디스크 고장 보장 |
| 미지원 자료 | bounded raw JSON·오류 사유와 HOLD 저장, 기존 금융 사실 유지 | 오류의 자동 정정·비용 확정·HOLD 자동 해제 |
| 청산 | 거래비 손익과 보호 중지 유지, 운영비 미확정 표시, 최종 카운터 적용 대기 | 운영비 포함 최종 순손익·학습 라벨·모델 활성화 |

한 위험일은 장 운영시간이나 최대 보유시간을 변경하는 정책이 아니다. 설정 `horizonEnd`는 그 위험일 안에 있어야 하고, 지원하는 운영비 사건은 현재 시각 이상·기간 끝 미만·horizonEnd 이하에 한정한다. 경계를 넘은 자료는 자동 이월하지 않는다. 원화 우선 검증은 미국 시장·SOXL/SOXX를 최종 대상에서 제외하는 결정이 아니다.

## 🧮 공통 현금과 중복 방지

금융 계산은 [V4 비용 연결](../src/core/cost-operating.ts), [공통 계좌 합산](../src/core/cost-handoff.ts), [위험 투영](../src/core/cost-risk-context.ts)을 사용한다. [기존 보조장부](../src/core/operating-journal.ts)의 독립 실행 API는 보존하고, V4는 새 delta-only 재생 결과만 사용한다. 별도 운영비 현금 잔액을 노출하거나 초기 자금으로 지급 가능액을 다시 제한하지 않는다.

하위 B 체결 원장의 `operatingCosts=EXPLICIT_ZERO_FIXTURE`는 기존 매매 전용 계약을 보존한다. V4의 계좌 운영비는 `operating.events/effects`에서 별도로 인식해 공통 계좌에 한 번 합산하므로, 그 B 표식을 계좌 전체의 운영비 0원으로 해석하면 안 된다. 이 구분을 모르는 구형 보고·학습 경로로 V4를 내보내지 않는다.

매매가 없는 초기 현금 5,000,000원·운영비 50원의 합성 예시다.

| 사건 | 현금 | 미지급 | 예약 | 순자산 E | 가용 현금 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 초기 | 5,000,000 | 0 | 0 | 5,000,000 | 5,000,000 |
| RESERVE 50 | 5,000,000 | 0 | 50 | 5,000,000 | 4,999,950 |
| 연결된 RECOGNIZE 50 | 5,000,000 | 50 | 0 | 4,999,950 | 4,999,950 |
| PAY 50 | 4,999,950 | 0 | 0 | 4,999,950 | 4,999,950 |

- 의무 인식 때 E가 한 번 감소한다. 지급은 현금과 같은 채무를 동시에 줄이며 두 번째 비용이 아니다. 예약 해제는 지출·수익이 아니다.
- 매매 예약·미지급과 다른 운영비 채무/예약을 빼고 지급 가능액을 검사한다. 지급을 위해 미수금을 사용하지 않는다. 결제된 매매 이익은 공통 현금에 포함된다.
- 새 운영비 예약은 원본 월 한도 `min(운용금 × 0.2%, 10,000원)`와 가용 현금을 함께 검사한다. 이전 월내 발생/예약은 이번 합성 계약에서 명시적 0이다. 실제 월내 이력의 누락을 0으로 대체할 수 없다.
- 이미 발생한 것으로 확인된 의무는 한도·현금을 초과해도 지우지 않고 채무와 중지를 기록한다. 과다 채무로 가용 현금이 음수가 돼도 검증된 보유 수량의 SELL·유효 체결·취소·결제를 막지 않는다. 초과 매도나 잘못된 대체 주문까지 허용하는 예외는 아니다.
- 수용된 같은 `eventId`/같은 내용은 같은 금융 효과와 원래 수용 영수증으로 반환한다. 새 commandId 재수신도 금융 효과는 없다. 같은 eventId의 다른 내용은 명시 충돌 오류이며 기존 기록은 불변이다. 격리 후 올바른 순서로 수용된 사건은 정상 수용 영수증을 기준으로 재수신을 대조한다.

기존 [로컬 저장 경계](COST_RESERVATION_STORE.md)를 재사용한다. 별도 DB의 비용을 나중 합산하는 방식이 아니다. COMMIT 원자성을 검사한 것이며 실제 처리 지연이 항상 1ms 이하라는 주장은 아니다.

## 🔒 신규 진입 HOLD와 입력 보존

초기에는 명시적 무비용 합성 fixture로 승인 경로를 검사할 수 있다. 그러나 후보의 운영비 추정과 경제성 검사가 아직 연결되지 않았으므로 **첫 수용 운영비 사건부터 신규 승인·인계를 HOLD**한다. 이는 미확정 청산 이후만 막는 U06-A보다 이 개발 단계에서 더 일찍 보류하는 안전 경계다. 최종 정책의 거래 기회를 자동 변경한 것이 아니며 비용 추정 연결 전 임시 봉쇄다.

운영비 적용 V4의 청산 결과는 `OPERATING_ALLOCATION_NOT_FINAL`, `counterApplied=false`, `lossStreakAfter=null`을 유지한다. `finalNetPnlKrw=null`, `allocationStatus=HOLD`다. 잠정 이익으로 연속손실을 0으로 만들지 않는다. 60분 재진입 대기·거래비만으로 확인되는 최초 예산 2배 초과 손실 중지와 계좌 손실 중지는 유지한다. 지급이나 예약 해제로 이 중지가 사라지지 않는다.

| 입력 상태 | 처리 | 복구/제약 |
| --- | --- | --- |
| 정상 사건 | 원자 기록과 위험 합산 | `.read()`는 전체 재생 결과를 반환 |
| 잘린 JSON·미지원 스키마/통화/환불 | `.operatingInput()`의 원문·고정 오류 사유를 `rejectedInputs`에 저장 | 자격증명이나 실제 개인정보를 보내지 않는 합성 시험 입구 |
| 늦음·기간 밖·순번/의무 연결 오류 | 원문과 이유를 저장하고 `OPERATING_INPUT_RECONCILIATION_REQUIRED` 유지 | 기존 현금·채무·예약·시각을 되감지 않음, 자동 수정/재배분 없음 |
| eventId 충돌·stale 승인·만료 writer | 명시 오류, 해당 쓰기 롤백 | 같은 ID 덮어쓰기·새 writer 권한 추정 금지 |
| 예약 한도/지급 현금 부족 | 해당 요청 거절, 기존 사실 유지 | 미확정 비용을 0으로 바꾸거나 다른 예약 사용 금지 |
| 원문 크기/사건 용량 초과 | 입력 거절, 새 근거 저장하지 않음 | 호출자가 미수용 자료를 보존해야 함. 완전한 실자료 수집기는 아님 |

원문 한도는 8,192 UTF-8 bytes다. 수용 사건과 격리 입력은 합계 최대 100이며, 활성 예약마다 인식+지급 2칸, 미지급 채무마다 지급 1칸을 먼저 남긴다. 따라서 격리 자료 폭증이 기존 채무 지급 공간을 소모하지 않는다. 운영비 명령은 매매의 5,200개 명령·100개 제어 명령 예산과 분리하며 저장 전체 상한은 5,300이다. 한도 시험은 합성 자원 경계이지 장시간 실운영 부하 인증이 아니다.

`.operatingInput()`은 JSON 파싱/스키마 판정을 거쳐 같은 저장 입구로 들어간다. 스키마가 유효하면 원문도 명령에 보존하며 재생 때 파싱 내용과 사건의 일치를 검사한다. 격리된 사건은 수용 사건 ID를 소비하지 않지만, 나중 수용돼도 기존 격리 기록/HOLD를 자동 삭제하지 않는다. 재시작만으로 신규 진입이 재개되지 않는다.

## 🛠️ 개발자 실행 예제

프로젝트 루트의 기존 설치 환경에서 먼저 `npm run build:engine`을 실행한다. 현재 검증 환경은 Windows PowerShell·Node 24.20.0이다. UI나 HTTP API에 V4를 노출하지 않았으며 API 키도 필요 없다.

아래는 테스트 fixture를 사용하는 **메모리 전용** 예제다. `node --input-type=module`의 표준 입력이나 루트의 임시 `.mjs`에서 실행할 수 있다. 실제/기존 DB 경로로 바꾸지 않는다.

```javascript
import { openedOperating, op, record } from './dist/runtime/tests/cost-operating-helpers.js';

const { repo, store } = openedOperating(); // :memory:, synthetic KR/KRW only
try {
  let s = record(store, op(store.read(), 'RESERVE', 'reserve'));
  s = record(store, op(s, 'RECOGNIZE', 'cost', '50', 'debt', 'reserve'));
  s = record(store, op(s, 'PAY', 'pay'));
  console.log(s.handoff.accounts.KRW.cash,
    s.handoff.accounts.KRW.payable,
    s.operating.effects.incurredKrw,
    store.context().status,
    s.learningAllowed);
} finally {
  repo.close();
}
```

기대 출력: `4999950 0 50 HOLD false`. 순자산의 비용 반영은 이미 의무 인식 때 끝났으며 지급이 두 번째 비용이 되지 않는다.

직접 사용하는 메서드는 [CostReservationStore](../src/server/cost-reservation-store.ts)의 `operating(commandId, event, expectedState)`와 `operatingInput(commandId, rawJson, expectedState)`다. `.read()`로 현재 재생 상태를 받고, 변경 요청은 그 revision/hash와 활성 writer lease로 대조한다. 반환 `current.operating.rejectedInputs`와 `current.handoff.admissionHolds`를 확인해야 하며 함수 반환만으로 비용 수용 성공이라고 간주하지 않는다. `.report()`/`.exportEvidence()`는 V3 전용이므로 V4를 거절한다. D4와 구형 학습 입력에 V4를 밀어 넣지 않는다.

## 🧪 검증과 다음 단계

```powershell
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/cost-operating.test.js dist/runtime/tests/operating-journal.test.js
npm test
npm run lint
npm run build
npm run format:check
npm run verify:originals
```

[전용 시험](../tests/cost-operating.test.ts)은 독립 금액 기대값, ID 중복/상충, 예약 경쟁, 매매 이익/미지급/청산, writer 만료, 쓰기 단계별 롤백, 재시작·재생·캐시 변조, 격리 원문·지급 슬롯, 구형 계약 보존을 검사한다. 자체 시험 자식 프로세스를 COMMIT 전/후 종료하는 시험은 운영 서비스나 사용자 프로세스를 종료하지 않는다.

D5 OI-01~03의 이 합성 범위와 OI-06/08/09의 보호 경계를 구현했다. OI-04~10 전체의 기간 마감·배분·최종 손실·추정 경제성·보고/학습 연결은 완료가 아니다. 실제 실행 수, 실패 재현/수정, 독립 검토와 파일 보존 결과는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)에 기록한다.

다음 작업은 동일 원자료에서 **기간 마감·확정 배분과 최종 손익/연속손실 재생**을 연결하는 것이다. 미지급 비용도 배분하되 E를 재차감하지 않고, 배분용 ID 정렬과 청산 순서를 분리해야 한다. 미결정 OC-U01/02/03/04/05/07의 영향을 확인하고 필요한 선택은 구현 전에 요청한다. 자동 재개·학습 활성화로 확대하지 않는다.

실자료·실계좌·실제 요율·수익성, USD/다일·환불/정정 자동 수용, 전체 상한의 동시 부하·장시간 운용, OS 격리/전원 차단, 새 설치·앱 화면 E2E는 미검증이다. 현 프로그램의 투자 안전성 또는 수익성을 인증한 결과가 아니다.
