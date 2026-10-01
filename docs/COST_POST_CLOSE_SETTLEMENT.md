# 마감 후 지급·결제 구현 — D9-B

2026-09-27 · DEV-D03 내부 합성 인수 · 실제 계좌/주문/학습 연결 없음

---

[D9-A 계약](COST_POST_CLOSE_SETTLEMENT_CONTRACT.md)에 따라 **새로 만든 명시 합성 KRW 실행**에서 마감 당시 확정된 미지급 의무·미결제 체결을 전액 처리한다. 원래 마감 결과를 수정하거나 다음날 매매를 허용하는 기능이 아니다. 개발자 Store 함수만 제공하며 앱 버튼·HTTP API·제품 outbox는 추가하지 않았다.

## 🎯 제공 범위와 금지 경계

| 제공하는 기능 | 계속 금지·미지원 |
| --- | --- |
| 운영비 의무 1건의 전액·동일 금액 지급 | 새 비용, 부분 지급, 금액 조정·환불·역분개 |
| 체결 1건의 원래 미수/미지급 전액 결제 | 새 체결, 수수료 재계산, 여러 대상의 추정 상계 |
| 별도 유한 관찰 기간의 후속 사건 | 다음 위험일 매매, 거래/학습 자동 재개 |
| TEST_ONLY/SYNTHETIC_FIXTURE KRW | 실제 자료 인증·키·계좌·USD/FX |
| 검증된 현재 잔액과 원래 마감 결과 조회 | 구형 보고/학습으로 현재 잔액을 잘못 내보내기 |

기존 V1~V4/D8 기록·기본 계약 해시는 보존한다. D9 옵션은 빈 새 실행의 전체 설정 해시에 포함되므로 기존 DB에 사후 주입하면 설정 불일치로 거절한다. D8 기본 계약의 마감 후 금융 변경 차단은 그대로이며, 아래 두 명령만 새 확장의 별도 경로를 통과한다.

## 🧱 저장·회계 구조

[후속 결제 모듈](../src/core/cost-post-close.ts)은 최초 D8 마감과 같은 COMMIT에서 기준점을 만든다. 기준점에는 마감 체크포인트 해시·revision, 공통 현금, 미지급 운영비와 미결제 posting의 목록·원본 해시가 들어간다. 이후 [기존 Store](../src/server/cost-reservation-store.ts)의 같은 명령·영수증·감사·상태 테이블에 사건을 추가한다. 별도 금융 DB는 없다.

| 영역 | D9의 처리 |
| --- | --- |
| 원래 checkpoint·최종 손익·배분·손실 횟수 | 변경하지 않음 |
| 원래 source.events·운영비 events/effects·요율·기간 | 변경하지 않음. 마감 이전의 역사적 합계 |
| 현재 `handoff.accounts` | 마감 잔액 + 검증된 후속 차액, 단 한 번 반영 |
| `postClose.currentOperating` | 원래 발생액 보존, 후속 지급만 paid/payable에 반영 |
| 기존 HOLD/HALT·RECONCILING | 결제 성공으로 제거하지 않음 |

닫힌 합성 현금성 장부에서 `E=C+R−P`, `Available=C−P−Q`를 대조한다. 운영비 지급은 C와 P를 함께 줄이고, 미수 수령은 R을 C로 옮긴다. 이미 인식된 비용을 다시 손실로 차감하지 않는다. 열린 포지션/예약이 없는 범위이며 실제 전체 계좌 NAV 인증이 아니다.

금액은 문자열과 D9 전용 Decimal 정밀도128로 계산한다. 최대 정수60자리·소수40자리와 유한 대상5,300개 누계의 정밀도 여유를 검산한다. 전역 정밀도40은 변경하지 않는다. 표현 범위를 넘는 결과나 음수/불일치 잔액은 전체 거절한다. 오래된 모듈의 정밀도 제한까지 소급 해결한 것은 아니다.

## 🔧 개발자 함수와 입력

새 `OperatingConfig`에 다음 옵션을 명시한다. 종료 시각은 운영비 기간 종료보다 뒤여야 하며 실제 영업일 결제 기한을 뜻하지 않는다.

```typescript
postClose: {
  contractHash: postCloseContractHash,
  followupEndExclusive: /* bounded synthetic timestamp */
}
```

| 함수 | 역할 |
| --- | --- |
| `store.settlePostClose(commandId, command, expectedState)` | 검증·멱등·단일 COMMIT 후 원래/새 영수증과 현재 상태 반환 |
| `store.postCloseReport(asOf)` | 전체 저장 이력 재검증 후 현재 잔액·운영비·대상별 해결 상태와 원래 checkpoint 반환 |
| `store.postCloseInput(...)` | 미지원 원문의 명시 격리. 실패한 결제 요청이 자동 보관되는 것은 아님 |

`command.kind`는 `PAY_CLOSED_OBLIGATION` 또는 `SETTLE_CLOSED_FILL`이다. 대상은 `postClose.basis.targets`에 존재해야 한다. 확장/configHash·sourceScope·KRW·closeId/checkpointHash, businessEventId·sourceHash, occurred/available/received/posted 시각을 엄격 검사한다. 정확한 필드와 제한은 [스키마](../src/core/cost-post-close.ts)를 따른다. 합성 sourceHash는 실제 브로커 서명이나 출처 인증이 아니다.

같은 commandId의 변경된 요청은 충돌이다. 새 전달 ID라도 같은 업무 사건·canonical 내용이면 최초 영수증과 최신 상태를 반환하며 차액을 다시 쓰지 않는다. 전달 시각만의 변화는 업무 동일성을 바꾸지 않지만 같은 commandId의 전체 요청을 바꿀 권한은 아니다. 다른 업무 ID로 이미 지급한 대상을 재지급하는 것도 거절한다. 새 epoch에서 동일 원래 요청을 복구할 수 있다.

새 사건은 `마감 ≤ occurred ≤ available ≤ received ≤ posted < 후속 종료`이고 posted는 현재 논리 시계 이상이어야 한다. 이 시계는 lease 벽시계와 다르다. 정상 재전송은 후속 관찰 기간이 끝나도 원래 영수증을 복구한다. D9의 새 원문도 종료 이상 시각은 거절해 시계 오염을 막는다. 종료 미만 원문 뒤에는 같은 posted 시각의 유효 지급이 가능하다.

원문100개 한도와 정상 결제 M개 슬롯을 분리했다. M은 마감 당시 미지급 의무+미결제 체결 수이며 대상당 한 번만 소비한다. 0원 대상도 식별자/슬롯을 소비한다. 이 제한은 다중 run·파일 생성·OS 전체 디스크/CPU 사용량 제한이 아니다.

보고는 `HOLD`와 `orderSubmissionAllowed/learningAllowed/liveEnabled=false`를 유지한다. 관찰 종료 뒤에도 미결제 금액을 삭제하지 않으며 확인된 실제 예정일이 없어 `dueAt=null`이다. 구형 보고/내보내기는 D9를 거절하고 구형 직접 위험 조회도 `POST_CLOSE_REPORT_REQUIRED` HOLD다. Store 생성·종료까지 무쓰기라는 뜻은 아니며, 보고 메서드의 금융/명령/감사 비변경과 구분한다.

## 🧪 실행 예제

프로젝트 루트의 기존 Node24.20.0/npm11 설치에서 `npm run build:engine` 후 아래 JavaScript를 `node --input-type=module` 표준입력으로 실행한다. 테스트 helper로 만든 **메모리 합성 DB**의 50원 미지급 의무를 다음날 지급한다. helper는 실제 공급자 완전성·실제 지급의 증명 도구가 아니다.

```javascript
import assert from 'node:assert/strict';
import { hash } from './dist/runtime/src/core/policy.js';
import {
  closedPostClose, paymentCommand,
} from './dist/runtime/tests/cost-post-close-helpers.js';

const f = closedPostClose();
try {
  const before = f.store.read();
  const checkpointHash = hash(before.finalization.checkpoint);
  const request = paymentCommand(before);
  const paid = f.store.settlePostClose('pay', request, before);
  const retry = f.store.settlePostClose('pay', request, before);
  const report = f.store.postCloseReport(paid.current.seed.clock);
  assert.deepEqual(retry.receipt, paid.receipt);
  assert.equal(hash(report.checkpoint), checkpointHash);
  assert.equal(report.operating.incurredKrw, '50');
  assert.equal(report.accounts.KRW.payable, '0');
  console.log(report.operating.paidKrw, report.unresolvedCount,
    retry.duplicate, report.status, report.liveEnabled);
} finally {
  f.repo.close();
}
```

기대 출력: `50 0 true HOLD false`.

```powershell
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/cost-post-close.test.js dist/runtime/tests/cost-post-close-failure.test.js
```

## 🔎 인수 시험과 증거 범위

실제 실행 결과·초기 실패·명령/로그는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)의 D9-B 기록을 따른다. 아래는 시험별 범위를 나타내며 실제 외부 환경 검증을 뜻하지 않는다.

| 인수 | 시험 내용·한계 |
| --- | --- |
| PC-01 | 새 옵션·구형 DB·잘못된 확장/시각/추가 필드 거절. 초기 조회/config·명령/expected·현재 상태/보고의 반환 객체 격리 |
| PC-02 | 실제 Store의 다음날50원/0원 지급, 역사적 장부·카운터 불변 |
| PC-03 | 실제 Store의 매수 채무·매도 미수·SELL 비용 초과 결제. 60+40자리·5,300대상은 별도 detached 투영 산술 시험이지 Store 최대 부하 시험은 아님 |
| PC-04/05 | 업무/요청/대상 중복·충돌, 실제 서로 다른 프로세스의 같은/다른 대상 경합. stale 상태 거절 후 새 상태로 재시도 |
| PC-06/07 | 부분/초과/잘못된 통화·범위·시각 거절, 발생 순서 역전, 원문 시계 오염 차단 |
| PC-08/14 | 기간 종료 뒤 미결제 보존, RECONCILING 유지, 원래 마감 재전송, 구형 보고/진입 거절 |
| PC-09 | PAY/FILL×쓰기5단계 예외, rollback 후 재시도/중복이 별도 무실패 golden 금융 테이블·영수증과 동일. SQLite 실제 FULL(errcode13) 오류 보존·복구 |
| PC-10 | 발송 전 요청 파일을 wx/flush로 보존, COMMIT 전/후 자식 강제 종료 뒤 파일만 받는 새 프로세스 복구. 제품 HTTP outbox·전원 차단 시험 아님 |
| PC-11 | writer 소유권·epoch·lease 만료, DB 쓰기 잠금 경합. 절대 벽시계 마감 보장 아님 |
| PC-12 | 기준점/체크포인트/명령/감사/현재 캐시/체결 인덱스 변조 재생 거절 |
| PC-13 | 실제 Store 원문100개 포화 뒤 M=3의0/1/2원 결제 모두 처리·추가 지급 차단. 전역 최대 M의 DB 부하 인수 아님 |
| PC-15 | 관련/전체 회귀·원본37파일·읽기 전용 독립 검토·예제/문서 검사, 결과는 진행 기록 |

## 🚧 남은 인수와 다음 단계

후속 [D10-A 사전 계약](COST_SETTLEMENT_ADJUSTMENT_CONTRACT.md)에서 아래 공백의 처리 규칙·산술·인수 계획을 정리했고, [D10-B 부분 결제](COST_PARTIAL_SETTLEMENT.md)를 별도 명시 합성 실행에 추가했다. **이 문서의 D9-B 전액 계약은 바뀌지 않았다.** D10-B 검증 근거는 PROGRESS를 따르며, 비용 조정 정책 선택·관찰 이관은 여전히 후속이다.

다음은 **D9-B 당시 남긴 사전 계약의 문제 구분**이다. 부분 결제만 별도 D10-B로 구현하며, D9-B 자체에 아래 기능을 임의 추가하지 않았다.

- 원래100원 채권 중99원만 수령: 근거 있는 부분 결제라면 1원 채권이 남는다. 자동 손실 처리 대상이 아니다.
- 원래100원에서 확정 수수료1원이 새로 발생: 별도 비용/조정 근거·기간 귀속·승인 계약이 필요하다. 순수 결제와 달리 E가 바뀔 수 있다.
- 출처 불명1원 차이: 검토 대기이며 소액 무시·수동 완료 클릭만으로 원장에 맞추지 않는다.

조정 기능은 원래 체크포인트를 덮어쓰지 않고 별도 정정 이력/보고 버전, 멱등성·한도·권한·원인 증거를 먼저 정의해야 한다. 관찰 종료는 채무 삭제/상각이나 지급 실패 증거가 아니다. 현재는 모두 원래 잔액을 보존한 HOLD이며 실제 브로커 연결 전 필수 후속 인수다.

실제 API·지급 증거·부분/정정/USD·제품 HTTP outbox·다중 실행 할당량·극단 OS 정지/물리 정전·최대 Store 부하·장시간 운용·새 설치·앱 E2E·수익성은 미검증 또는 미구현이다. 소유 시험 자식/임시 DB만 사용하며 사용자 실행 서비스와 구별한다. D03 2/4·전체 계획10/40·누적158/167은 유지한다. API 키는 아직 필요 없다.
