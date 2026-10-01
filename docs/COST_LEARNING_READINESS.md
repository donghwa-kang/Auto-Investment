# V3 학습 준비도 진단기 — D4

_2026-09-24 · DEV-D03 내부 개발자 API. 읽기 전용 합성 자료 진단이며 학습 변환·운영 활성화 기능이 아니다._

---

## 📋 제공 기능과 한계

[사전 계약](COST_LEARNING_INPUT_CONTRACT.md)에 따라 `assessCostLearningReadiness(text, anchor)`를 [구현](../src/core/cost-learning-readiness.ts)했다. 원래 D2 JSON과 별도 신뢰 기준을 기존 `verifyCostOutcomeExport`로 검증·재생하고, 재구성한 금융 보고와 학습 보류 진단을 반환한다. 결과는 항상 `COST_LEARNING_READINESS_V1` / `TEST_ONLY` / `HOLD`다.

금액·체결·비용·환율을 새로 계산하지 않는다. 승인된 모든 기록과 D1의 원래 사유·null을 보존하며, 손실이나 미완료 기록을 골라 지우지 않는다. 확정 승인 이전에 거절된 후보나 전체 시장 모집단을 수집했다고 표시하지 않는다. 승인 0개여도 최상위 진단 5개는 남는다.

학습 입력과 라벨은 null, 학습·주문·LIVE 허용은 false다. `FINANCIAL_REPLAY=VERIFIED`는 금융 재생 일치만 뜻하며 **학습 적격·자료 출처 인증·수익성 검증은 아니다**. 구형 학습기·웹 앱·CLI에 자동 연결하지 않는다.

## 🔐 입력과 부작용 경계

| 입력 | 의미 |
| --- | --- |
| `text: string` | 원래 `SYNTHETIC_COST_HOLD_EXPORT_V1` JSON 문자열 |
| `anchor: CostExportAnchor` | 별도로 신뢰하는 `OutcomeConfig`와 당시 `exportHash` |

대상 파일에서 설정과 해시를 읽어 그대로 기준으로 사용하면 독립 검증이 아니다. 신뢰 기준의 보관·서명·최신성·OS 격리는 [D2 한계](COST_OUTCOME_EXPORT.md)를 그대로 따른다. ‘검증 완료’ 파생 객체, D4 보고, 특징/운영비 덮어쓰기 옵션은 입력 계약이 아니다.

이 함수는 DB를 열거나 파일을 저장하거나 lease를 갱신하지 않는다. 네트워크·모델 fitting·등록·자동 교체 함수도 호출하지 않는다. 다만 D2가 원본 정책 파일을 **읽고 해시를 검사**하므로 파일 시스템 접근이 전혀 없는 함수는 아니다. 프로젝트 루트에서 실행해야 하며 정책 읽기 실패도 거절한다.

D2의 16MiB·깊이64·노드500,000·명령5,200 제한과 `CostOutcomeExportError`를 그대로 전달한다. 잘못된 형식·기준·명령·영수증·보고는 부분 결과 없이 거절하며 보정·절삭·재시도하지 않는다. 재생 결과 내부의 인계-거래 관계가 깨지면 `COST_READINESS_TRANSFER_MISSING`으로 중단한다. 이 검사는 원장 복구 기능이 아니다.

## 📊 출력 읽기

| 필드 | 의미 |
| --- | --- |
| `source` | D2 exportHash, D1 source 메타데이터와 financialBasisHash/reportHash |
| `financialReport` | 재생한 D1 전체 보고의 분리 사본 |
| `coverage` | `PERSISTED_APPROVALS_ONLY`, `approvalCount`, `transferCount`, 다섯 `phaseCounts`, `preApprovalDecisions=NOT_RECORDED_BY_V3_CONTRACT` |
| `records` | 승인 순서대로 정확히 한 행; D1 비용·손익·원래 사유/상태/근거와 rowId/phase/checks |
| `checks` | 아래 순서의 고정 5개. 각 행에도 별도 사본 제공 |
| `readinessHash` | 이 필드만 제외한 전체 본문의 기존 정렬 JSON 해시 |

| 체크 | 상태 | 사유 |
| --- | --- | --- |
| FINANCIAL_REPLAY | VERIFIED | 빈 배열 |
| FEATURE_BINDING | MISSING | V3_FEATURE_SOURCE_NOT_BOUND |
| OPERATING_ALLOCATION | UNSUPPORTED | OPERATING_COST_ALLOCATION_UNSUPPORTED |
| TRAINING_CONTRACT | UNSUPPORTED | V3_TRAINING_CONTRACT_NOT_INTEGRATED |
| POPULATION_SCOPE | LIMITED | V3_PREAPPROVAL_POPULATION_NOT_RECORDED |

각 체크는 `{ id, status, reasons: string[] }`다. 행 phase는 `RESERVED_LOCAL`, `RELEASED_LOCAL`, `NO_FILLS`, `INCOMPLETE_TRADE`, `CLOSED` 중 하나다. CLOSED여도 특징·운영비 계약이 없으므로 학습은 HOLD다. `UNKNOWN` 주문 상태, 결제·FX 미확정, 위험 중지 래치는 `financialReport`에서 원래대로 확인한다.

`rowId=hash({configHash, sourceScope, reservationId})`로 같은 실행에서 결제 전후 같은 승인임을 식별한다. 거래 없는 승인의 runId/outcomeBasisHash는 null이다. 새로운 스냅샷은 결과 해시를 바꿀 수 있지만 별개 거래 표본이 되지 않는다. 서로 다른 실행의 경제적 중복 탐지·자료셋 조립 기능은 아직 없다.

반환 사본은 수정할 수 있으나 입력이나 다른 행에 영향을 주지 않는다. 사본 수정 후 해시는 자동 갱신되지 않는다. 이 해시는 인증서가 아니며 D4 결과를 파일에서 다시 검증/등록하는 별도 API도 제공하지 않는다. 다시 진단하려면 원래 D2와 별도 기준을 사용한다.

## 🔧 실행과 확인

런타임·설치는 [README](../README.md)를 따른다. 기존 설치의 프로젝트 루트 PowerShell:

```powershell
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/cost-learning-readiness.test.js
```

다음 JavaScript를 빌드 후 `node --input-type=module`의 표준 입력으로 실행할 수 있다. 테스트 도우미가 새 메모리 합성 DB를 만들며 사용자 DB·API 키는 사용하지 않는다. 기준은 신뢰된 생성 단계에서 메모리에 별도로 보관한다.

```javascript
import { openedOutcome, beginTrade, fillTrade, closeTrade } from "./dist/runtime/tests/cost-outcome-helpers.js";
import { assessCostLearningReadiness } from "./dist/runtime/src/core/cost-learning-readiness.js";

const { repo, store, c } = openedOutcome();
let artifact;
try {
  const run = beginTrade(store);
  fillTrade(store, run);
  closeTrade(store, run, "10100");
  artifact = store.exportEvidence();
} finally {
  repo.close();
}
const anchor = { config: c, exportHash: artifact.exportHash };
const result = assessCostLearningReadiness(JSON.stringify(artifact), anchor);
console.log(result.status, result.coverage.approvalCount,
  result.records[0].phase, result.checks.length, result.learningAllowed);
```

기대 출력은 `HOLD 1 CLOSED 5 false`다. 합성 거래가 끝났더라도 학습이 허용되지 않는 정상 동작이다. 이 함수나 `npm run learning:convert`로 새 학습 모델을 만들 수 있다는 뜻이 아니다.

## 📌 검사와 다음 단계

[전용 시험](../tests/cost-learning-readiness.test.ts)은 D4-A01~A10의 비용 보존, 빈/미완료/UNKNOWN, 손실/FX/중지, 부분 체결/대체/결제, 결정성·변조·한도, 입력/DB/파일 불변, 구형 학습/등록/평가 거절을 검사한다. 성공한 학습·등록은 전용 시험 범위가 아니다. 실제 실행 수·실패 수정·관련 회귀·독립 검토·문서 예제 결과는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)에 기록한다.

원본 정책, 구형 학습, V1/V2/V3 금융 계산과 DB 형식은 변경하지 않는다. D03-03/04는 여전히 미완료이며 준비도 함수 하나로 전체 비용·학습 연결을 완료 처리하지 않는다. 실제 자료/요율/수익성, 최대 상한 동시 부하·장시간 운용, OS 격리·전원 차단·새 설치·화면 E2E는 미검증이다.

후속 [D5 선택안](OPERATING_COST_INTEGRATION_DECISIONS.md)의 U08-A/U06-A 승인 후 [D6 원화 공통 장부](COST_OPERATING_LEDGER.md)를 새 V4로 연결했다. 의무·예약·지급/재생과 미지원 자료 HOLD까지만 제공하며 확정 배분·최종 손실/학습 라벨은 아직 없다. D1/D2 보고·내보내기는 V4를 거절하고 이 D4의 입력 계약도 변경하지 않았다. 따라서 D6 구현이 학습 준비도 통과를 뜻하지 않는다. OC-U01/02/03/04/05/07은 미결정이며 API 키는 아직 필요 없다.
