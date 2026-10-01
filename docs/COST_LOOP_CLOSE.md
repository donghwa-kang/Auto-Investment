# S8-C 자동 청산 루프와 단일 합성 마감

_2026-09-29 · 새 TEST_ONLY KRW 실행의 S7+D8 연결 · 검사 결과는 PROGRESS 참조_

---

## 🎯 제공 범위

[S7 루프](COST_OPERATING_LOOP.md)의 같은 장부에서 체결·청산·운영비와 [D8 마감](COST_FINALIZATION.md)을 연결한다. 기존 S7 실행을 바꾸지 않고 `program.operatingLoop({ finalization: true })`로 만든 **새 명시 실행**만 허용한다. [보고·JSON 검증](COST_OPERATING_REPORT_AND_REPLAY.md)도 같은 계약/원장을 재생한다.

| 설정 | 동작 |
| --- | --- |
| `program.operatingLoop()` | 기존 S7, D8 결합 거절 |
| `program.operatingLoop({ finalization: true })` | 새 S7+D8 단일 마감 |
| 위 config + D9 또는 D10 | 초기화 거절 |
| 기존 V3/S5 화면·DB | 변경/자동 이관 없음 |

새 `operatingLoop.closeContract`는 `SYNTHETIC_S7_D8_SINGLE_CLOSE_V1`이며 D8 `finalization` 옵션과 함께 있어야 한다. config·상태·명령·보고 해시가 이 값을 묶는다. 다른 버전으로 이름만 바꾸거나 기존 DB를 다시 초기화하는 사용법이 아니다. 최초 무운영비 접수 후 비용 사건이 생기면 기존 신규 진입 HOLD를 유지한다.

이번에는 실제 시세/계좌·API·유료 AI·학습·UI·파일 전송을 연결하지 않는다. `npm run portfolio:web` 실행이나 API 키가 필요하지 않다. 미국 상품 제외 정책을 새로 만든 것이 아니라 기존 단일 KRW 합성 범위를 유지한 것이다.

## 🔧 호출과 마감 전제

프로젝트 루트의 기존 설치 환경에서 실행한다. 실제 검증 환경은 Windows/Node 24.20.0이며 새 설치 검사는 아니다.

```powershell
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/cost-loop-close.test.js
```

마감 호출은 기존 `store.finalizeOperating(commandId, closeId, request, expectedState)`를 재사용한다. 새 계약에서는 같은 Store 객체를 소유한 런타임을 먼저 정지한다. 타이머 취소·generation 무효화로 늦은 콜백을 버리고, 진행 중인 동기 작업에 재진입하면 거절한다. 이후 기존 DB writer 트랜잭션 안에서 lease/epoch·CAS·전체 기록과 마감 근거를 대조한다.

- **정지는 청산이 아니다.** 수량이 남았거나 주문이 FILLED/CANCELLED가 아니면 마감을 거절한다. UNKNOWN을 시간이 지났다는 이유로 해소하지 않는다.
- 거래/운영비 예약이 남거나 격리 입력이 있으면 마감을 거절한다. 실제 미수·미지급은 기존 D8 정책대로 보존하며 예약과 혼동하지 않는다.
- `FULL_PERIOD_FROM_EMPTY`는 독립적인 합성 자료 작성자의 완전성 선언이다. DB 해시만으로 빈 시간대가 완전하다고 자동 선언하지 않는다.
- config/state/records/recordCount·기간·가용시각을 검증한다. 새 계약은 기록된 마지막 틱/감시 시각보다 앞선 마감 근거도 거절한다.
- 거절/쓰기 실패 후 런타임을 자동 재개하지 않는다. 금융 상태/기존 HOLD는 보존한다. 원인을 확인한 개발자만 미마감 실행을 명시적으로 다시 시작할 수 있다.

같은 프로세스라도 별도 Store 객체 또는 다른 프로세스의 스케줄러를 전역 중지하지 않는다. 그 경계는 DB 잠금·lease·CAS·마감 상태 검사로 막는다. 다른 객체의 다음 점검은 마감 상태를 만나 정지하며 새 금융 입력은 원장에서 거절한다. 분산 스케줄러나 OS 격리를 제공한다는 뜻이 아니다.

## 🧮 비용과 불변성

독립 정수 검산 예시는 4주 × (22,000 − 21,400) − 거래비 20 − 운영비 50 = **2,330원**이다. 고정 상승 합성 경로이며 투자 수익성 증거가 아니다. 운영비 50원이 미지급이라면 마감 후에도 그대로 남는다. 마감 배분을 현금에서 다시 차감하지 않는다.

마감 계산·checkpoint·손실 카운터·감사는 기존 단일 COMMIT에서 기록된다. 원장 사건은 추가 전용이며 검증 가능한 기존 상태 캐시의 갱신은 별도 금융 사건이 아니다. 같은 closeId/요청은 원래 영수증을 반환하고 다른 내용은 충돌이다. 재시도 때 새 전체기간 request를 만들지 말고 **원래 request와 closeId**를 보존한다.

마감 후 새 틱·pulse·진입·운영비 금융 변경은 거절한다. 과거 틱의 정확한 재전송이 원래 영수증을 반환하는 것은 재실행이 아니다. 후속 원문은 기존 `postCloseInput`으로 RECONCILING에 격리할 수 있지만 마감·비용·현금을 수정하지 않는다. S7+D9/D10 지급 결합은 지원하지 않는다.

운용/학습/실주문/자동 재개 권한은 false다. 보고 상태는 HOLD이며 NAV는 null이다. 최종 배분·기간 손익은 불변 checkpoint에서 읽는다. `operating.finalNetPnlKrw`의 기존 null을 확정값으로 덮어쓰지 않는다. 현재 계정과 과거 마감은 구분한다.

## ✅ 재현 가능한 메모리 예제

다음 코드는 빌드 후 프로젝트 루트에서 Node ES module로 실행한다. 입력 생성/전체기간 선언은 [시험 전용 helper](../tests/cost-loop-close-helpers.ts)이며 실제 시장 수집 완전성을 증명하지 않는다. 제품 경로는 helper 안의 새 adapter·Store·틱과 기존 D8 API다.

```javascript
import { loopCloseFixture, finishLoop } from './dist/runtime/tests/cost-loop-close-helpers.js';
import { verifyOperatingEvidence } from './dist/runtime/src/core/cost-operating-evidence.js';

const f = loopCloseFixture(); // 별도 메모리 DB, 기존 사용자 DB를 열지 않음
let evidence;
try {
  finishLoop(f);
  f.close(); // fixture 작성자가 선언한 전체기간 근거 + 기존 D8 commit
  evidence = f.store.exportOperatingEvidence();
} finally {
  f.repo.close();
}
// 실제 전달에서는 config/exportHash를 JSON과 별도로 신뢰해 확보해야 한다.
const verified = verifyOperatingEvidence(JSON.stringify(evidence), {
  config: f.c,
  exportHash: evidence.exportHash,
});
console.log({
  status: verified.report.status,
  netKrw: verified.report.financialEvidence.finalization.periodNetPnlKrw,
  learning: verified.report.learningAllowed,
});
```

예상 결과는 `{ status: 'HOLD', netKrw: '2330', learning: false }`다. verifier는 DB 없이 재생하지만 동일 reducer를 재사용하므로 독립적인 회계 모델/외부 사실 인증은 아니다. JSON 안의 자체 해시만으로 진위를 보장하지 않는다.

## ⚠️ 오류와 미지원 범위

| 오류 | 의미/다음 행동 |
| --- | --- |
| `COST_OPERATING_LOOP_EXTENSION_UNSUPPORTED` | 계약 쌍 누락 또는 S7+D9/D10. 기존 guard를 삭제하지 않음 |
| `COST_RUNTIME_REENTRANT` | 진행 중 동기 작업에 재진입. 새 명령을 끼워 넣지 않음 |
| `LOCAL_REAPPROVAL_REQUIRED` | 읽은 뒤 장부/소유권 변경. 최신 자료로 검토하되 완료된 마감 재시도는 원요청 유지 |
| `FINALIZATION_HOLD:*` | 포지션/주문/예약/격리/근거 부족. 추측으로 해소하지 않음 |
| `FINALIZATION_ID_OR_CONTENT_CONFLICT` | closeId 또는 내용 상충. 원요청 대조 필요 |
| `COST_RUNTIME_FINALIZED` | 마감 실행 재시작 거절 |
| `FINALIZED_FINANCIAL_MUTATION_BLOCKED` | 마감 후 새 금융/감시 입력 거절 |

실제 실행한 검사와 실패 후 수정은 [PROGRESS · 공개 요약](PROJECT_STATUS.md)를 따른다. 정상 DB 재열기·실패 주입·프로세스 시험을 물리 전원/OOM/디스크 장애 보장으로 확대하지 않는다. 전체 시장·실자료 백테스트·수익성·AI 효과·최대 장부 처리 지연은 별도다. 시간 감시/마감은 전체 장부를 검증하므로 O(1)/실시간 SLA를 주장하지 않는다.

## 📍 다음 작업

[S6 인수 지도](D03_INTEGRATION_ACCEPTANCE.md)에 따라 다음은 **비영 운영비 이력의 후보 심사 연결 범위 확정**이다. 완료20위험일의 확인된 합성 근거·후보 비용 추정·경제성·접수 직전 재검사를 대조한다. 미정 부분 이력/미래 증가분 정책을 임의 결정하거나 첫 비용 사건 HOLD를 일괄 제거하지 않는다. S7+D9/D10은 별도 필요/인수 없이 선행 확장하지 않는다. 학습 입력·앱 관통·D03 전체 완료는 아직 아니다.
