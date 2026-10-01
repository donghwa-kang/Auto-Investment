# 합성 운영비 읽기 전용 마감 보고 — D7

2026-09-26 · DEV-D03 내부 읽기 전용 연결 · TEST_ONLY

후속 안내: [D8 명시 원자 마감](COST_FINALIZATION.md)은 새 실행의 선택 확장으로 별도 제공한다. 이 문서의 D7 읽기 전용 계약은 그대로다. D8 체크포인트 저장 뒤에는 `operatingClose()`를 재투영하지 않고 `read().finalization.checkpoint`를 읽는다.

---

## 📋 이번에 제공하는 것

`CostReservationStore.operatingClose(request)`는 [D6 V4 공통 원장](COST_OPERATING_LEDGER.md)을 **하나의 읽기 트랜잭션**에서 다시 검증한다. 합성 시험 작성자가 별도로 확정한 전체기간 manifest와 대조한 뒤, 운영비 배분·비용 차감 최종 손익·청산 순서별 연속손실을 계산한다. 검증 코드와 API는 [마감 투영 모듈](../src/core/cost-operating-close.ts), [Store](../src/server/cost-reservation-store.ts), [시험](../tests/cost-operating-close.test.ts)에 있다.

**마감 보고의 계산 완료이지 실제 마감 저장이나 매매 기능 완료가 아니다.** 기존 V4 계약은 `UNIMPLEMENTED_HOLD`이며 이를 바꾸지 않았다. DB의 `allocationStatus`는 HOLD, `finalNetPnlKrw`는 null, 각 청산의 `counterApplied`는 false로 남는다. 원래 현금·채무·손실 카운터·중지·대기시간도 변경하지 않는다.

| 구분 | 이번 API의 동작 |
| --- | --- |
| 원자료 검증 | 설정·전체 명령·영수증·감사·체결 인덱스·캐시를 기존 `decode()`로 재생하고 같은 스냅샷을 사용 |
| 보고 가능 | `VERIFIED_FIXTURE_PROJECTION`: 명시 합성 전제 아래 정수 배분·손익·손실 순서 계산 |
| 근거 불충분 | `HOLD`: 이유 배열, 배분·기간 최종 손익·손실 투영은 null |
| 잘못된 요청/손상 DB/구형 계약 | 예외. 보고를 성공으로 돌려주거나 DB를 고쳐서 통과시키지 않음 |
| 실제 권한 | 원장 변경·카운터 반영·자동 재개·학습·주문·LIVE 모두 false |

이는 [D5 U08-A/U06-A](OPERATING_COST_INTEGRATION_DECISIONS.md)의 마감 계산 부분이다. 지급·원자 저장을 담당하는 D6와 최종 카운터 쓰기/멱등 마감 인수는 구별한다. D1/D2/D4 API를 V4 지원으로 확장하거나 기존 웹 화면/CLI/학습기에 연결하지 않았다.

## 🔐 입력과 신뢰 경계

요청은 `schemaVersion=OPERATING_CLOSE_FIXTURE_REQUEST_V1`, `purpose=TEST_ONLY`, `provenance=SYNTHETIC_FIXTURE`, `manifest`, `asOf`로 구성하며 추가 필드를 거절한다.

| manifest 필드 | 의미와 검사 |
| --- | --- |
| `configHash`, `stateHash` | 현재 검증된 설정과 전체 상태의 해시 |
| `recordsHash`, `recordCount` | 순서 있는 `{id,input,receipt}` 전체 명령 목록의 해시·개수 |
| `periodStart`, `periodEnd` | V4 설정의 KST 09:00~다음 09:00 반열린 1위험일과 정확히 일치 |
| `coverage` | `FULL_PERIOD_FROM_EMPTY` 또는 `INCOMPLETE`. 후자는 HOLD |
| `finalizedAt`, `availableAt` | `periodEnd ≤ finalizedAt ≤ availableAt ≤ asOf`. 스냅샷 자료도 확정 시각 전에 가용해야 함 |

`FULL_PERIOD_FROM_EMPTY`는 **합성 시험 작성자가 기간 전체와 빈 시간 구간까지 알고 있다는 전제**다. DB를 읽어 자체 해시를 붙였다는 사실만으로 누락 없는 실제 시장 자료가 되지 않는다. manifest는 서명된 공급자 증명도 아니며, 임의의 DB를 자동으로 완전하다고 봉인하는 제품 API는 제공하지 않는다. 신뢰되지 않는 사람이 DB와 manifest를 함께 바꿀 수 있다면 이 대조로 진위를 인증할 수 없다.

초기 설정은 빈 원장이다. 시작 전 이월 거래/비용, 설정의 자료 범위 밖 사건, 실제 공급자 지연·누락·세션 완전성은 지원하지 않는다. `finalizedAt`는 합성 보고의 전제 시각이며 DB에 저장된 실제 마감 사건이 아니다. 미래 시각으로 값을 지정해 실제 학습 이용 권한을 얻을 수 없다.

공개 진입점은 Store 메서드다. 내부 `projectOperatingClose`에 임의 상태를 직접 전달하는 것은 전체 재생 검증이 아니며, 외부 입력 수용 경로로 사용하면 안 된다. 반환 `observed`는 **현재 검증 스냅샷**이지 `asOf`의 과거 계좌 복원 기능이 아니다.

## 🧮 배분과 손실 판정

발생이 확인된 의무의 총액 O를 사용한다. 미지급 의무도 포함하고 예약금만 있는 경우는 비용으로 바꾸지 않는다. 지급은 이미 인식한 의무의 현금/채무 교환이므로 배분 비용을 늘리지 않는다.

| 계산 | 규칙 |
| --- | --- |
| 완료 거래 N>0 | O를 정수 나눗셈. 나머지 1원은 **ASCII 거래 runId 순서**로 배분, 합계 O 보존 |
| 완료 거래 N=0 | 배분 행 없음, O 전부 미배분. 기간 손익에서는 차감, 가짜 손실 거래는 만들지 않음 |
| 거래 최종 순손익 | 원장 거래비 차감 손익 − 해당 운영비 배분액. 원래 거래비 손익은 보존 |
| 기간 최종 순손익 | 전체 완료 거래비 손익 합계 − O. 현금/순자산을 다시 차감하는 명령이 아님 |
| 연속손실 순서 | `closedAt`, 동시각이면 `closedRevision`. 나머지 배분 ID 순서와 별개 |
| 연속손실 변화 | 초기 설정의 체크포인트에서 음수 +1, 양수 0으로 초기화, 0은 유지 |
| 중간에 2연속 손실 | 뒤에 이익이 나서 최종 횟수가 0이어도 `projectedConsecutiveLossReviewHalt=true` 유지 |

예: 거래비 차감 손익 +2/+2, 운영비6 → 각3 배분 → 최종 -1/-1, 투영 횟수2. 기존 원장 횟수를 2로 쓰거나 중지 과거 이력을 새로 만들지는 않는다. 이미 설정에 있는 손실 횟수도 보존하며 중복 조회로 늘리지 않는다.

정수 배분은 BigInt, 소수 손익 연산은 입력 자릿수/합산 상한에 충분한 별도 Decimal 정밀도를 사용한다. 전역 금융 정밀도·R0·C_stop·2배 초과 손실 정책은 변경하지 않는다. 기존 HOLD/HALT·재진입 대기시간은 `observed`에 남고 어떤 보고 성공도 이를 해제하지 않는다.

## ⚠️ 보류와 오류

열린 포지션, 접수/취소 미확정 주문, 미체결 주문, 로컬/운영비 미해결 예약, 격리된 운영비 원문이 있으면 **전체 보고 배분을 보류**한다. 문제 거래를 분모에서 빼고 남은 행만 성공 처리하지 않는다. 취소 확정된 미체결 주문은 완료 거래로 세지 않는다.

| 상황 | 결과 |
| --- | --- |
| 다른/오래된 manifest, 명령 누락·개수 불일치 | `MANIFEST_SNAPSHOT_MISMATCH` |
| 기간 불완전 선언 | `PERIOD_COVERAGE_INCOMPLETE` |
| 기간 종료 전 확정/가용시각 역전/가용 전 조회 | `CLOSE_EVIDENCE_NOT_AVAILABLE` |
| 열린 거래/주문 또는 예약 | `OPEN_POSITION_OR_ORDER`, `UNRESOLVED_RESERVATION` 등 |
| 미지원 원문 격리 | `QUARANTINED_INPUT` |
| 요청 스키마 위반 | `OPERATING_CLOSE_REQUEST_INVALID` 예외 |
| V1/V2/V3 Store | `OPERATING_CLOSE_V4_REQUIRED` 예외, 자동 업그레이드 없음 |
| 원장·명령·감사 등 변조 | 기존 재생 검증 예외, 읽기 트랜잭션 롤백 |

보류 보고의 `totalOperatingKrw`/`observed`는 스냅샷 금융 사실이며 기간 완전성을 인증하는 수치가 아니다. 배분과 판정은 null로 남는다. 보류를 풀려고 원문을 삭제하거나 기준 해시를 현재 DB로 무조건 바꾸지 않는다. 원자료를 대조하고 지원 가능한 별도 시험인지 확인해야 한다.

## 🔧 개발자 실행 예제

프로젝트 루트에서 기존 설치 환경의 Node 24.20.0 및 npm 11을 사용한다. 먼저 `npm run build:engine`을 실행하고, 아래 JavaScript를 `node --input-type=module` 표준입력 또는 프로젝트 안 `.mjs` 파일로 실행할 수 있다. 실제 사용자 DB를 열지 않는 **비어 있는 합성 원장 전용 예제**다. 원장 생성·writer 취득은 예제 준비 동작이고 `operatingClose` 자체는 읽기 전용이다.

```javascript
import assert from 'node:assert/strict';
import { hash } from './dist/runtime/src/core/policy.js';
import { openedOperating } from './dist/runtime/tests/cost-operating-helpers.js';

// Fixture author knows this entire synthetic day contains NO events.
// This empty-list manifest is not valid for real or populated databases.
const { repo, store, c } = openedOperating();
try {
  const snapshot = store.read();
  const request = {
    schemaVersion: 'OPERATING_CLOSE_FIXTURE_REQUEST_V1',
    purpose: 'TEST_ONLY',
    provenance: 'SYNTHETIC_FIXTURE',
    manifest: {
      configHash: hash(c), stateHash: hash(snapshot),
      recordsHash: hash([]), recordCount: 0,
      periodStart: c.operating.periodStart,
      periodEnd: c.operating.periodEnd,
      coverage: 'FULL_PERIOD_FROM_EMPTY',
      finalizedAt: c.operating.periodEnd,
      availableAt: c.operating.periodEnd,
    },
    asOf: c.operating.periodEnd,
  };
  repo.db.exec('PRAGMA query_only=ON');
  const result = store.operatingClose(request);
  assert.deepEqual(store.read(), snapshot);
  console.log(result.status, result.periodNetPnlKrw,
    result.allocations.length, result.counterApplied);
} finally {
  // Repository.close releases the fixture writer; restore write permission
  // only after all read-only assertions have completed.
  repo.db.exec('PRAGMA query_only=OFF');
  repo.close();
}
```

기대 출력: `VERIFIED_FIXTURE_PROJECTION 0 0 false`.

전용 검사:

```powershell
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/cost-operating-close.test.js
```

검사별 실제 실행 결과·초기 실패/수정·독립 검토·파일 보존 근거는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)에 기록한다. 예제와 검사 실행 성공은 실제 공급자 완전성·장중 지연·전략 수익성 검증이 아니다.

## 📍 다음 인수와 미지원

D7 다음 인수였던 **명시 새 실행의 마감 체크포인트·결과/손실 카운터 원자 저장·멱등·재시작 복구**는 D8로 분리했다. D8은 전달된 투영 수치를 그대로 쓰지 않고 저장 직전 원자료를 같은 writer/epoch/lease 아래 재검증한다. 마감 후 금융 변경은 차단하고 별도 원문 intake만 허용한다. 실제 후속 지급/결제 반영은 다음 인수로 남아 있다.

현재 시험의 지급 전후 비교는 **동일 위험일 내 두 원자료 스냅샷** 비교다. 실제 마감 후 비용 지급·다음 위험일 전환을 구현/검증했다는 뜻이 아니다. 다일·USD/환불/정정/늦은 자료, 미결정 OC-U01/02/03/04/05/07, 후보 운영비 추정 경제성, V4 학습 입력·UI·브로커 연결은 남아 있다. 기존 키·실계좌·유료 AI는 사용하지 않는다.

D7의 내부 검사 완료율과 DEV-D03 통합/전체 계획 진행률은 별도로 보고한다. 문서는 Markdown 스킬의 방식에 따라 제공 기능·입력 전제·보류·미구현 권한을 구분했다.
