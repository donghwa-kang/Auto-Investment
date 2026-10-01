# 합성 운영비 이력의 승인·접수 연결

_2026-09-30 · DEV-D03-S9-B · 개발자용 로컬 TEST_ONLY 계약_

---

## 📋 제공 범위

[S9-A 설계](COST_HISTORY_ADMISSION_DESIGN.md)의 완료20위험일 합성 비용 이력을 기존 신호 → 비용 포함 후보 심사 → 예약 → 합성 접수 재검사에 연결했다. 과거 이력은 **추정 근거**이고 현재 실행의 비용 의무나 자금 이관이 아니다. 기존 운영비 산식·원본 거래 정책은 바꾸지 않았다.

새 옵션 `program.operatingLoop({ historyAdmission: true, finalization: true })`을 지정한 **KRW 위험월 첫 위험일·첫 후보**만 지원한다. 위험월 첫날은 KST 09:00 경계이며 실거래 가능 날짜를 제한하는 정책이 아닌 이번 합성 인수 범위다. N>0, 완전한20위험일, 미래 증가분0, 과거 미해결 이월 없음이 필요하다. 첫 현재 운영비 사건 뒤 신규 진입 HOLD·단일 승인 제한은 유지한다.

UI/브로커/키·외부 AI·유료 분석과 연결하지 않는다. 주문·학습·LIVE·새 지출·자동 재개 권한은 계속 false다. `portfolio:web` 화면에는 아직 이 연결이 없고 현재 사용자가 눌러야 할 새 버튼도 없다.

## 🔧 개발자 API

| 입력/조회 | 실제 동작 |
| --- | --- |
| `program.operatingLoop({ historyAdmission: true })` | 새 합성 V4 확장 계약 생성. 기존 옵션 생략 실행은 그대로 |
| `adapter.prepareEntry(store, history)` | 원신호와 이력으로 후보 심사. 누락/null/미지원 이력은 거절 |
| `store.reserve(commandId, prepared)` | 기존 단일 COMMIT/CAS/epoch에서 원자료·후보·binding·예약 저장 |
| `store.prepareHandoff(reservationId, acknowledgement, currentHistory)` | 별도로 전달한 현재 이력과 원승인 binding/추정액 재대조 |
| `store.handoff(commandId, prepared)` | 같은 근거를 COMMIT 직전 재검사해 합성 주문 기록 |
| `store.exportOperatingEvidence()` | RESERVE/HANDOFF 원자료와 보고서를 함께 메모리로 내보냄 |
| `verifyOperatingEvidence(json, anchor)` | 외부 고정 config/exportHash 아래 DB 없이 명령 재생·보고 대조 |

이력 형식은 [기존 `operatingHistorySchema`](../src/core/operating-cost.ts)를 재사용한다. configHash는 운용 `seed.config` 해시, riskEpoch는 승인 writer epoch에 묶인다. `coverage.complete=true`, 완료 의도 수량·종결 선언은 **합성 작성자의 선언**이며 브로커 자료 완전성 인증이 아니다.

새 [이력 확장](../src/core/cost-history-admission.ts)은 기존 비용/완료 의도 배열 각각10,000개, 금액30자리·ID128자 한도에 **이력 한 개의 정규 JSON UTF-8 256 KiB** 한도를 추가한다. 초과는 잘라내지 않고 쓰기 전 거절한다. 전체 export는 기존16 MiB 한도다. 이 값들은 직렬화 자원 제한이지 투자 한도 변경이 아니다.

RESERVE에는 `proposal.operatingHistory`와 승인 `operatingBinding`, HANDOFF에는 별도 `operatingHistory`를 남긴다. O/N과 가용시각·식별자는 원자료 및 정규화 해시로 보존하고 추정액은 `candidate.operatingEstimateKrw`에 저장한다. 보고서의 `financialEvidence.approvals`에서도 같은 자료를 확인한다. 새 요약 O/N을 다른 산식으로 중복 저장하지 않는다.

### 접수 거절의 의미

O10/N3와 O11/N3는 둘 다 추정4원이지만 서로 다른 근거이므로 접수하지 않는다. 동일 레코드 중복·순열은 같은 정규 binding으로 인정한다. 현재 이력이 없으면 저장된 과거 승인 자료를 최신 자료처럼 대신 쓰지 않는다.

거절은 해당 시도의 명시적 실패이며 원예약·감사를 변경하지 않는다. 해제는 `release()`로 따로 요청해야 한다. 해제했다고 두 번째 후보가 허용되는 것은 아니다. 원래 신호·호가·예측·요율의 기한도 연장하지 않는다. 새 writer epoch에서 이전 예약의 이력을 덮어써 재접수할 수 없지만, 이미 COMMIT된 동일 명령의 원래 영수증 조회는 가능하다.

## 🧪 재현 예제

프로젝트 루트 PowerShell, 기존 설치 Node24.20.0/npm11에서 실행한다. 먼저 엔진/시험을 빌드하고 종료0을 확인한다. 신규 설치·실제 API 시험은 아니다.

```powershell
npm run build:engine
node --test --test-reporter=tap --test-concurrency=1 dist/runtime/tests/cost-history-admission.test.js
```

아래 JavaScript는 **컴파일된 개발자 시험 helper**로 월초 합성 신호·20일 이력을 만드는 메모리 전용 예제다. 실계좌 이력을 수집하거나 사용자의 기존 DB를 열지 않는다. 프로젝트 루트의 `.mjs`에서 실행할 수 있다. `currentHistory`는 예제에서 별도로 공급하는 합성 원자료이며 Store가 저장값으로 자동 보충하지 않는다.

```javascript
import assert from "node:assert/strict";
import { admissionFixture } from "./dist/runtime/tests/cost-history-helpers.js";
import { verifyOperatingEvidence } from "./dist/runtime/src/core/cost-operating-evidence.js";

const f = admissionFixture();
let evidence;
try {
  const prepared = f.adapter.prepareEntry(f.store, f.history("10"));
  assert.equal(prepared.candidate.operatingEstimateKrw, "4");
  f.store.reserve("example-reserve", prepared);
  const currentHistory = f.history("10");
  const handoff = f.store.prepareHandoff(f.adapter.reservationId, "CONFIRMED", currentHistory);
  f.store.handoff("example-handoff", handoff);
  evidence = f.store.exportOperatingEvidence();
  assert.equal(evidence.report.financialEvidence.operating.current.incurredKrw, "0");
} finally {
  f.repo.close();
}
const verified = verifyOperatingEvidence(JSON.stringify(evidence), {
  config: f.c,
  exportHash: evidence.exportHash,
});
console.log({ estimateKrw: "4", currentIncurredKrw: "0", status: verified.status, learningAllowed: verified.learningAllowed });
```

예상 결과는 `estimateKrw: '4'`, `currentIncurredKrw: '0'`, `status: 'HOLD'`, `learningAllowed: false`다. 이것은 후보 비용 전달·독립 재생 확인이며 수익성 결과가 아니다.

## 🔍 인수 근거와 오류 구분

신규 시험은 [HA-01~16 설계](COST_HISTORY_ADMISSION_DESIGN.md)의 정상·실패 조건을 고정 합성 입력으로 검사한다. 비용0/4 비교에서 같은 q의 거래비·손절 위험·현금 예약은 유지되고 경제성 비용/netQ05만4원 바뀐다. 높은 비용은 거절하며 원장 변화가 없다. 부분 체결→현재 비용50원→청산→지급→D8에서 과거 비용10원을 재인식하지 않고 현재50원만 배분한다.

| 검사/오류 | 의미와 범위 |
| --- | --- |
| `HISTORY_ADMISSION_CURRENT_INPUT_REQUIRED` | 새 계약에 필요한 명시 이력이 없음. 0원 fallback 금지 |
| `HISTORY_ADMISSION_SCOPE` / `…FRESH_MONTH_FIRST_RUN_REQUIRED` | N=0·창 밖 사건·월중·이월 등 이번 지원 범위 밖 |
| `HISTORY_ADMISSION_HOLD:…` | 기존 추정기의 시각/설정/epoch/중복/coverage 검증 실패 |
| `HISTORY_ADMISSION_REAPPROVAL_REQUIRED` | 승인과 현재 이력의 정규 근거 또는 추정액 불일치 |
| `HISTORY_ADMISSION_EPOCH_CHANGED` | 과거 예약을 새 writer에서 재접수하려 함 |
| `HISTORY_ADMISSION_OPT_IN_REQUIRED` | 구형 실행에 새 이력을 주입하려 함 |
| 스키마 오류 / `HISTORY_ADMISSION_SIZE_LIMIT` | 잘못된 형식·분류·금액·자원 한도 초과 |

쓰기 단계별 실패 주입, pre-COMMIT lease 만료, 로컬 파일 DB 정상 닫기/재열기, 원래 영수증 재조회, 원자료 누락/변조 독립 재생 거절을 검사한다. 강제 프로세스 종료·물리 정전·외부 네트워크 장애를 이번 새 조합에서 시험했다는 뜻은 아니다.

변경 전 빌드가 만든 V1/V2/V3/D6/D8/D9/D10/S7/S8-C 합성9종은 새 코드로 읽기 전용 재조회해 상태·행을 대조했다. V4 여섯 종류는 export·보고·독립 재생도 동일했다. 사용자 DB를 마이그레이션하거나 열어 보는 검사가 아니다. 실제 실행 로그·통과 수·처음 실패와 보완은 [PROGRESS · 공개 요약](PROJECT_STATUS.md)에 남긴다.

## ⚠️ 남은 한계와 다음 작업

이번 연결은 1위험일의 첫 후보만 지원한다. 비용 후 연속 진입·N=0 새 연결·부분 이력·월중/다일 이관·외화 운영비·미정 정정/환불·S7+D9/D10 결합은 그대로 제외한다. 보호 reducer에 이력 수집/AI 대기는 추가하지 않았다. 다만 Store의 기존 전체 재생 검증 비용은 존재하며 tick 처리 O(1), 실시간 SLA나 최대 입력에서의 성능을 주장하지 않는다.

다음 최소 작업은 **S10-A: 확정 비용을 포함한 합성 학습 입력의 계약·인수 설계**다. 판단 시점 원자료·당시 비용 추정과 나중 확정한 배분·라벨 가용시각을 분리한다. 입력 적격 판정과 모델 학습·등록·실거래 승격은 별개다. 기존 D4 HOLD·V4 학습 false를 단순 해제하지 않고, 새 버전 입력이 필요한지와 정상/누출/중복/미확정 사례를 먼저 정한다. UI·실제 연결·유료 AI는 자동 확장하지 않는다.
