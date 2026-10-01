# S7 합성 자동매매 루프와 V4 운영비 연결

_2026-09-29 · DEV-D03-S7 · 개발자용 새 TEST_ONLY 실행 · 검증 결과는 PROGRESS 참조_

후속 상태: [S8-B 보고·검증](COST_OPERATING_REPORT_AND_REPLAY.md)과 [S8-C 단일 마감](COST_LOOP_CLOSE.md)을 별도 opt-in으로 추가했다. 아래 S7 기본 계약의 D8 거절은 그대로이며 `operatingLoop({ finalization: true })`로 만든 새 실행만 S7+D8을 허용한다. S7+D9/D10·UI/학습·기존 DB 전환은 지원하지 않는다. 아래 ‘보고/마감 미구현·다음 작업’은 S7 작성 당시 기록이다.

## 🎯 제공 범위

[S6 인수 지도](D03_INTEGRATION_ACCEPTANCE.md)의 첫 연결이다. 기존 B/P 신호로 승인·인계한 한 KRW 합성 거래를 V4 공통 현금 장부에서 처리한다. 이후 합성 운영비가 발생해 신규 진입이 보류되어도, 유효한 기존 체결·손절/목표/시간 청산·합성 결제를 처리한다. 운영비 예약·발생·지급을 거래비와 구분한다.

이것은 새로운 투자 전략, 실시간 브로커, 실전 수익성 검증이 아니다. 기존 V3 실행 계약과 [S5 화면](COST_WEB_LAB.md)은 V4로 전환하지 않는다. 공용 Store의 체결 재전송·원자 명령 한도는 이번 시험에서 발견한 경계 문제를 함께 보완했다. 기존 DB를 변환하지 않으며, 새 DB도 미해결 의무나 중지를 지우는 운용 수단으로 사용할 수 없다.

| 입력/상태 | 허용되는 처리 | 자동으로 하지 않는 것 |
| --- | --- | --- |
| 기존 명시 무운영비 조건의 B/P 신호 | 같은 고정 신호·가격·정책으로 새 V4 실행의 접수 검토 | 다른 전략/위험 배율·실주문 승인 |
| 운영비 RESERVE → RECOGNIZE | 연결 운영비 예약을 상계하고 채무를 한 번 인식 | 발생 비용을 현금에서 바로 차감하거나 버림 |
| 비용/HOLD 중 유효 호가 | 기존 주문 체결·취소 확정·보호·청산·명시 합성 결제 | 신규 진입 재개, UNKNOWN 상태를 추측해서 해소 |
| 시간 점검 | 시세 공백·취소/청산 검토 필요와 시간 트리거 기록 | 가격·체결·결제·취소 확정·현금 변동 생성 |
| 유효한 PAY | 기존 채무를 현금 지급으로 대체 | 비용 재인식·손익 확정·중지 해제 |
| 비용 배분 대기 | 거래별 거래비 차감 결과와 운영비 채무를 각각 보존 | 합산 최종 손익·손실 카운터·학습 라벨 확정 |

`orderSubmissionAllowed`, `learningAllowed`, `liveEnabled`, `newSpendingApproved`는 false다. 운영비의 `finalNetPnlKrw`는 null, `allocationStatus`는 HOLD다. 지급 완료·포지션 0·새 호가·재시작은 해제 증거가 아니다. 이미 확인된 `STOP_LOSS_EXCEEDS_2X` 등 안전 중지는 유지한다.

## 🔌 명시 연결 방법

프로젝트 루트에서 현재 의존성이 설치된 Windows/Node 24.20.0 환경으로 실행한다. 새 설치 검증이나 실제 API 시험이 아니다.

```powershell
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/cost-operating-loop.test.js
```

성공 판단은 실패/취소/건너뜀 0과 모든 선택 시험의 통과다. 아래는 이미 검증된 합성 입력·선택값을 가진 호출부의 API 사용 순서다. 완결된 실행 예제와 입력은 [시험](../tests/cost-operating-loop.test.ts)의 `makeFixture`와 `open`을 따른다.

```typescript
const program = new CostSignalProgram(input, settings, selection, {
  executionLoop: true,
  watchdog: true,
});
const operating = program.operatingLoop();
const store = new CostReservationStore(repo, operating.config(), {
  initialize: true,
});
store.reserve("reserve", operating.prepareEntry(store));
store.handoff(
  "handoff",
  store.prepareHandoff(operating.reservationId, "CONFIRMED"),
);
// 이후 CostLoopRuntime 또는 검증된 합성 tick/pulse/operating 명령 사용.
```

`repo`는 새 전용 Repository이며 소유권 획득이 필요하다. 예제 ID는 한 시험 실행의 고정 식별자다. 운용 재시도 때 새 ID를 만드는 예제가 아니다. `CostLoopRuntime`의 시계·직렬 처리·오류 정지 조건은 [S4 계약](COST_SIGNAL_BRIDGE.md#s4-watchdog)을 그대로 따른다.

- `program.config()/prepareEntry()/evidence()`는 여전히 V3다. S7은 `program.operatingLoop()`가 반환한 별도 config/접수 검토를 사용한다.
- 새 opt-in은 `operatingLoop.kind = SYNTHETIC_COST_OPERATING_LOOP_V1`과 원래 `signalBasisHash`를 고정한다. 다른 Store의 run hash나 다른 신호의 승인 내역은 거절한다.
- 단일 KRW·빈 초기 실행·합성 1위험일·명시 비용 이력 0을 사용한다. 비용 발생 후 신규 접수 HOLD를 우회하지 않는다.
- V3 `executionLoop`를 V4 config에 섞거나 S7을 D8 `finalization`/D9 `postClose`/D10 `partialSettlement`와 함께 초기화하는 것은 거절한다. 각각의 기존 기능은 유지하지만 새 결합의 마감/내보내기 인수는 후속이다.

## 🧮 현금·비용·손익의 구분

공통 초기 현금은 한 번만 적용한다. 원화 가용현금은 기존대로 `C - P - Q`이며, 미수는 지급 가능한 현금으로 쓰지 않는다. 가격/금액은 기존 정확한 십진 문자열·Decimal 산술을 재사용한다. 시간·수량·revision의 정수형 사용과 금융 금액을 혼동하지 않는다.

독립 BigInt 기대값을 가진 합성 목표 청산 예시는 4주 × (22,000 − 21,400) = 2,400원이다.

| 과금 단위 | 왕복 거래비 | 운영비 50원 지급 전 현금 / 미지급 | 지급 후 현금 / 미지급 |
| --- | --- | --- | --- |
| 주문별 ORDER | 20원 | 5,002,380원 / 50원 | 5,002,330원 / 0원 |
| 체결별 FILL | 80원 | 5,002,320원 / 50원 | 5,002,270원 / 0원 |

지급 전후 가용현금은 같다. 운영비 지급은 채무를 현금으로 갚는 사건이지 비용을 다시 발생시키는 사건이 아니다. 거래별 `netPnlNative`는 거래비까지만 반영한 중간 결과다. 위 잔액을 운영비 배분까지 확정된 최종 거래 손익이나 학습 라벨로 내보내지 않는다. 고정된 상승 합성 경로는 수익성 증거가 아니다.

## 🛡️ 원자성·멱등성·시간 경계

금융 writer는 기존 [CostReservationStore](../src/server/cost-reservation-store.ts)와 Repository 하나다. 틱 하위 사건의 체결·비용·예약·현금·체결 인덱스·감사는 같은 writer 트랜잭션/epoch에서 반영된다. 논리 사건은 추가 전용이며, 기존 재생 가능한 상태 캐시의 UPDATE를 별도 원장 변경으로 오해하지 않는다. 캐시는 전체 사건·영수증·감사·체결 인덱스와 대조한다.

루프의 재시도 조회는 V3 공개 내보내기에 의존하지 않고, 하나의 검증된 내부 읽기 snapshot을 사용한다. 뒤따르는 writer는 다시 CAS/소유권을 검사한다. 읽기와 쓰기를 하나의 무잠금 동작으로 간주하지 않는다.

동일 명령은 원래 envelope/영수증을 재사용한다. 개별 FILL 재전송은 체결 식별자와 의미를 검사한 뒤 원래 기록의 영수증을 반환한다. 자동 틱 안의 체결은 검증된 재생에서 새로 추가된 사건을 추적해 부모 틱 영수증을 찾는다. 시각이나 생성 ID만 보고 추측하지 않으며 저장 형식/기존 상태 해시를 추가 변경하지 않는다. 내용이 바뀐 동일 체결은 충돌이다.

운영비 가용시각이 기록된 감시 시각보다 앞서면 원문을 격리하고 금융 반영하지 않는다. 기존 과거/기간 밖 입력 제한도 유지한다. 감시 pulse 자체는 금융 시계를 움직이지 않는다. 운영비 100슬롯(종료용 예약 포함)은 기존 실행 5,200슬롯과 분리하며 틱 4,096회·감시 64회 상한도 유지한다. 한도에 도달하면 정지/보류할 수 있으므로 무한 장기 운용 지원이 아니다.

## ✅ 검사 범위와 남은 작업

실행 로그·실패 후 수정·최종 통과 수는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)에 기록한다. S7 시험은 신호 연결, 부분 체결 중 비용 인식, 주문/체결별 과금, 목표/손절/시간 청산, UNKNOWN, 현금 부족, 동일 요청/체결 재전송, DB 재열기, 쓰기 단계/COMMIT 실패, lease 만료, 시간 입력 격리와 실행 한도 경계를 다룬다.

일반 DB 닫기/재열기는 전원/OOM/프로세스 강제 종료 시험이 아니다. `DISK_FULL`은 실패 주입이며 물리 디스크 포화가 아니다. S7 타이머 시험은 제어 가능한 시계/콜백이고, 기존 S4 실제 Node 타이머 회귀와 구분한다. 한도 끝 reducer 시험은 분기 검증이지 5,200개 저장 명령 성능 시험이 아니다. 장부 전체 재생 때문에 시간 감시도 지연될 수 있으며 O(1) 또는 실시간 SLA를 주장하지 않는다.

V4에서 기존 `report()/exportEvidence()`는 계속 거절한다. S7은 개발자용 상태/원장 연결까지만 제공하며 UI 전환·최종 마감 보고·독립 내보내기·새 학습 입력은 제공하지 않는다. 다음 작업은 **V4 네이티브 보고·독립 검증 근거 계약**이다. 이후 비영 20위험일 이력의 후보 심사, 합성 학습 입력, 앱 관통 인수가 남는다. 정책 미결정·실제 자료 권리/요금·실계좌·수익성·AI 효과는 별도다.
