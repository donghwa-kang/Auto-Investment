# 확정 비용을 포함한 합성 학습 입력 계약·인수 설계

2026-10-01 구현 후속: [S10-B 실제 API·예제·제한](COST_LEARNING_INPUT.md)을 추가했다. 이 문서의 미구현/다음 지시는 S10-A 당시 설계 이력이다. 현재 구현·검사/미검증은 PROGRESS를 따르며 기존16개 설계 그룹과 원본 정책은 보존한다.

_2026-09-30 · DEV-D03-S10-A · 설계 완료 / 새 입력 검증기 미구현_

## 📋 결정과 범위

다음 S10-B는 **기존 신호 원자료와 V4/D8 확정 비용을 읽어 검증하는 별도 TEST_ONLY 입력 계약**을 구현한다. 모델을 학습하거나 주문하지 않는다. 정상 합성 자료에는 `SYNTHETIC_INPUT_ELIGIBLE`을 반환할 수 있지만, 이것은 자료 연결 시험의 적격 상태이지 학습·투자 허가가 아니다.

[S9-B](COST_HISTORY_ADMISSION.md)의 새 KRW 위험월 첫날·첫 후보·완료20위험일/N>0·미래 증가분0·이월 없음 범위를 그대로 사용한다. 단일 B 또는 P 신호, 명시 `executionLoop`/`watchdog`, `historyAdmission`/`finalization`을 갖춘 실행만 대상으로 한다. S7+D9/D10, 월중/다일·외화·환불/정정 정책은 확대하지 않는다. 이 제한은 합성 인수 범위이며 원본 투자 정책 변경이 아니다.

완료 조건은 같은 원자료로 판단을 재구성하고, 같은 금융 근거로 비용 후 결과를 검증하며, 누출·중복·미확정 자료를 구별하는 것이다. 표본 수 확보·수익성·모델 성능 검증은 이 단계에 포함하지 않는다.

| 선택지 | 결정과 이유 |
| --- | --- |
| D4의 고정 HOLD를 PASS로 변경 | 제외. D4는 V3 금융 진단이며 원자료/운영비 배분이 연결되지 않은 구형 자료까지 허용하게 됨 |
| 구형 학습 입력에 V4를 억지로 변환 | 제외. 거래소 비용을 수수료에 합치거나 추정 운영비를 정답으로 쓰면 기존 의미/해시가 달라짐 |
| 별도 버전의 읽기 전용 검증 입력 | 선택. 기존 검증·비용 계산을 재사용하고 구형 계약/장부/권한을 보존할 수 있음. 기존 학습 CLI 연결은 별도 작업으로 남음 |

## 🔍 소스로 확인한 현재 경계

| 현재 구현 | 확인한 사실 | 새 계약에서 연결할 부분 |
| --- | --- | --- |
| [신호 브리지](../src/server/cost-signal-bridge.ts) | `signalEvidence()`는 replay/settings에 연결된 해시·선택·평가·호가 해시를 제공. 원본 전체 replay/settings를 내보내지는 않음 | 해시만 받지 않고 원자료를 별도 입력받아 같은 신호/설정/config를 재구성 |
| [신호 재생](../src/core/signal-replay.ts)·[이력 선택](../src/core/signal-history.ts) | 시점별 봉/정정/기업행동·벤치마크를 선택하고 `CHART_SIGNAL`/`NO_CHART_SIGNAL`/`BLOCKED`를 기록 | 선택 프레임의 전체 판단 목록을 보존하고 가용시각을 검사 |
| [독립 RVOL 재구축](../src/core/learning-rvol.ts) | 판단 당시 21×15개 원본 봉을 선택해 기존 지표 계산기와 별도로 RVOL 계산 | 첫 특징은 기존 RVOL 한 개만 재사용. 새로운 예측 지표를 추가하지 않음 |
| [이력 승인](../src/core/cost-history-admission.ts)·[예약](../src/core/cost-reservation.ts) | 원자료, binding, 추정 비용과 당시 승인 후보를 저장 | RESERVE/HANDOFF의 근거와 선택한 원신호를 일치시킴 |
| [V4 보고](../src/core/cost-operating-report.ts)·[독립 재생](../src/core/cost-operating-evidence.ts) | 현재 계정, 체결별 비용 상세, 확정 배분과 checkpoint를 검증. 전체 보고는 HOLD/학습 false | 검증 결과에서만 특징 외의 결과·비용 자료를 파생 |
| [D8 마감](../src/core/cost-finalization.ts)·[마감 계산](../src/core/cost-operating-close.ts) | D7 예상 보고와 저장된 D8 checkpoint는 다름. 기간 완전성은 합성 작성자 선언 | D8 FINALIZED와 가용시각을 요구. 선언을 외부 자료 진위 인증으로 격상하지 않음 |
| [D4](../src/core/cost-learning-readiness.ts)·[구형 변환](../src/core/paper-learning-convert.ts) | D4는 `trainingInput:null`/HOLD. 구형 변환은 미지원 운영비를 UNRESOLVED로 보존 | 코드/형식/해시와 거절 동작을 그대로 유지 |

위 내용은 정적 대조와 아래 기존 시험으로 확인했다. 다음 절의 필드/API/LI 시험은 **구현할 설계**이며 현재 제공 기능이 아니다.

## 🔗 제안 입력과 신뢰 경계

### 입력 봉투와 외부 고정 근거

새 식별자는 `SYNTHETIC_COST_LEARNING_INPUT_V1`로 한다. 기존 `LEARNING_RESEARCH_V1`·`ENGINE_LEARNING_RESEARCH_V1/V2`와 별개다. 다음 필드를 strict schema로 검사하고 알 수 없는 필드는 거절한다.

| 제안 필드 | 내용과 대조 대상 |
| --- | --- |
| `kind`, `purpose` | 새 식별자, `TEST_ONLY` 고정 |
| `asOf` | 자료 검증의 논리 시각. epoch 밀리초의 안전한 정수. 벽시계/파일 생성일로 자동 보충하지 않음 |
| `replay` | 기존 `OFFLINE_SIGNAL_REPLAY_V1` 원자료 전체. 기존 스키마·개수·작업량 제한 재사용 |
| `settings` | 기존 `portfolioSettingsSchema` 원문 설정. capital·정렬·프로필까지 재구성에 포함 |
| `selection` | 기존 `costSignalSelectionSchema`의 프레임/종목/요율/합성 forecast/adverseExitTicks |
| `operatingEvidenceText` | `exportOperatingEvidence()`의 원래 JSON 문자열. 호출자가 가공한 보고서나 `verified:true`는 입력이 아님 |

program 옵션은 이 V1 계약에서 `{ executionLoop:true, watchdog:true }`, operating 옵션은 `{ historyAdmission:true, finalization:true }`로 고정한다. 옵션을 추측하거나 기존 실행에 덧붙이지 않는다.

검증 함수의 두 번째 인수인 **외부 anchor**는 `{ inputHash, operating: { config, exportHash } }`다. `inputHash`는 위 봉투의 파싱된 JSON 값 전체에 대한 기존 `hash()` 값이고 `operating`은 기존 verifier의 고정 근거다. 신뢰할 수 있는 로컬 시험 호출자가 보존·전달한다. 봉투 안에 있는 해시를 그대로 anchor로 채택하지 않는다. 해시가 일치해도 원자료가 실제 시장 자료임을 인증하지 않는다.

검증기는 봉투를 읽어 기존 `CostSignalProgram`의 생성/조회만 사용해 signalEvidence와 V4 config를 재구성한다. `hash(config)`를 외부 anchor 및 금융 export의 config와 대조하고 `signalBasisHash`, run/reservation 식별, 선택 profile/forecast/request, 승인 후보와 두 시점의 운영비 binding을 연결한다. Store 생성·`prepare`·`reserve`·`handoff`·DB 쓰기는 호출하지 않는다. 공용 순수 helper 추출이 필요하면 공개 계약/해시가 그대로임을 회귀로 증명한다.

원자료를 묶은 새 helper는 추가할 수 있으나 검증 우회권을 갖지 않는다. 이미 검증했다는 객체, 요약 금액, 호출자 작성 features/label을 받는 편의 경로는 만들지 않는다.

### 자원·금액·시각

- 입력 텍스트는 UTF-8 64 MiB 이하, 깊이64 이하, 노드1,000,000 이하로 제한한다. 파싱 전 바이트, 파싱 직후 구조 제한을 확인한 뒤 비싼 재생을 수행한다. 초과를 잘라 수용하지 않는다.
- 원래 V4 문자열의16 MiB·500,000노드·명령 수 제한과 원래 replay의 자산8/프레임8/이력·작업량 제한은 별도로 유지한다. 묶음 상한은 내부 JSON 문자열의 escaping 여유를 포함한 직렬화 제한이며 위험 한도나 성능 보장이 아니다.
- 금액은 원래의 평문 Decimal/정수 문자열과 범위로 보존한다. 새 합산은 V4 보고와 같은 로컬128자리 정밀 연산을 사용하고 기존 비용 커널의 승인된 반올림을 재실행한 값과 대조한다. `Number` 금액 변환·허용 오차·새 반올림은 금지한다.
- 주식 수량·revision·시각의 기존 제한 정수 사용은 유지한다. 모든 숫자를 BigInt로 바꾸는 리팩터링이 아니다. RVOL은 기존 `DECIMAL40_V1` 문자열로 출력하고 Float64 학습 벡터 변환은 하지 않는다.

## 🕒 판단 정보와 나중 정답의 분리

### 당시 판단: 특징과 승인 문맥

`decisionAt`은 재생 검증한 원승인의 `issuedAt`, `featureAsOf`는 선택 프레임의 시각, `signalAt`은 해당 완료15분봉의 closeAt이다. `signalAt <= featureAsOf <= decisionAt`를 요구한다. 당시 요율·합성 forecast·호가·운영비 이력의 가용시각/유효기간은 원래 승인/접수 검사를 그대로 통과해야 한다. 접수 시각을 원승인 시각으로 덮어쓰지 않는다.

**학습용 특징 후보는 `rvol` 한 개**다. 원신호를 재생한 뒤 원본 instrument history에서 `createRvolSource`/`rebuildRvol`을 사용한다. symbol, signalAt, dataVersion, historyEvidenceHash와 frame 근거를 묶고 재구축값을 `evaluation.current.rvol` 및 전략의 RVOL trace와 대조한다. B/P 전체 신호는 기존 평가기로 재현하지만 전체 지표를 독립 재구축했다고 주장하지 않는다.

`decisionContext`에는 승인 당시 수량/entry/stop/위험·경제성 금액, `operatingEstimateKrw`, 과거20일 원자료/binding 및 합성 forecast의 출처를 참조로 보존한다. 이 문맥 전체를 학습 벡터로 직렬화하지 않는다. 첫 V1에서 forecast/q05·원시 ID/해시·나중 청산 정보는 특징이 아니다. 추정 운영비도 실제 비용 정답 대신 쓰지 않는다.

원본 봉투에 미래 봉/나중 정정이 들어 있을 수 있다. 감사용 원본 해시는 바뀌어도, `availableAt <= featureAsOf`인 유효 완료 자료로 재구축한 특징과 해당 프레임의 판단은 바뀌면 안 된다. 필요한 과거 봉의 가용시각을 미래로 옮겨 자료가 부족해지면 HOLD다. 모든 미래 레코드를 무조건 거절하는 것과, 미래 레코드를 판단에 쓰는 것은 모두 이 계약과 다르다.

### 확정 결과: 발생 비용과 배분

금융 envelope를 `verifyOperatingEvidence`로 원래 명령부터 재생한 결과만 읽는다. 최소 적격 조건은 다음과 같다.

1. 원승인/접수 한 건과 거래 한 건이 선택한 신호·reservation/run에 정확히 대응한다. 손실/이익의 부호로 선별하지 않는다.
2. 거래 `phase=CLOSED`, 보유 수량0, 모든 주문 FILLED/CANCELLED, 열려 있는 예약 없음. 부분 체결이나 UNKNOWN을 완료로 바꾸지 않는다.
3. D8 `status=FINALIZED`, checkpoint/해시/배분 존재, 이 거래에 배분 정확히 한 건, 미배분0. D7 예상 보고만으로 라벨을 만들지 않는다.
4. 운영비 및 마감 이후의 격리 입력이 없고 `RECONCILING`이 아니다. 미정 정정/환불을 임의로 손익 반영하지 않는다.
5. `closedAt` 이후의 아래 라벨 가용시각이 입력 `asOf` 이하다. 아직 가용하지 않으면 그 시점의 라벨은 null이다.

비용은 `historicalPostings[].lines[].amountDelta`를 **COMMISSION/TAX/EXCHANGE/FX**별로 합산하고 합계를 `tradingFees`와 대조한다. 누적 `line.amount`를 부분 체결마다 다시 더하지 않는다. V1은 KRW이고 외환 거래/환산은 미지원이다. FX 0은 지원 범위와 원장 근거로만 확정하며 알 수 없는 비용의 0 대체가 아니다.

```text
grossPnlKrw = sellValue - buyValue
tradingFees = commission + tax + exchange + fx
tradingNetPnlKrw = grossPnlKrw - tradingFees
finalNetPnlKrw = tradingNetPnlKrw - operatingAllocationKrw
```

슬리피지는 실제 합성 체결 가격에 이미 반영된다. 위 현금 손익에서 별도 슬리피지 비용을 다시 차감하지 않는다. 출력에 `executionFrictionTreatment: EMBEDDED_IN_FILL_PRICES`를 남기고 측정되지 않은 독립 슬리피지 수치를0으로 만들지 않는다. 후보의 예상 불리 체결 버퍼 역시 사후 비용에 더하지 않는다.

과거 O/N 추정4원, 현재 발생50원, 거래차익2400원/거래비20원인 기존 합성 경로의 예상값은 **2380−50=2330원**이다. 4원 추정이나50원 지급을 또 빼지 않는다. 양수로 고정한 시험 경로이며 기대수익 증거가 아니다. 원 단위 나눗셈을 복제하지 않고 D8의 기존 배분을 참조·대조한다.

### 결제와 가용시각

**지급 완료와 손익 확정은 다르다.** D8가 허용하고 비용 금액/배분이 확정된 미수·미지급은 잔액과 `settlementPending`으로 보존한다. 미지급이라는 이유만으로 발생 비용을0으로 만들거나 반대로 미확정 청산을 허용하지 않는다. 이는 발생 기준의 합성 결과 적격이며 현금 결제 성공 증명이 아니다. 보호 HOLD/손실 중지가 남아 있어도 확정된 손실 표본은 적격일 수 있고 권한은 계속 잠긴다.

새 결과의 `labelAvailableAt`은 다음 가용시각의 최댓값으로 산출한다. 호출자가 직접 지정하거나 closedAt으로 일괄 대체하지 않는다.

- 해당 거래의 모든 체결 수신/가용시각 및 주문 종결을 확정한 재생 사건 시각.
- 배분 기간 전체에 포함된 운영비 의무의 availableAt. 내 거래에 배분된 비용만 보고 다른 기간 비용의 가용성을 누락하지 않는다.
- D8 checkpoint의 `manifest.availableAt` 및 `appliedAt`(기존 request.asOf).

`closedAt <= labelAvailableAt <= input.asOf`와 검증한 export의 `asOf <= input.asOf`를 요구한다. 마지막 조건을 만족하지 않는 나중 snapshot을 잘라 과거에 존재했던 금융 상태처럼 만들지 않는다. 금융 export만 새로 열람/내보낸 시각을 labelAvailableAt으로 쓸 필요는 없다. 위 시각은 합성 계약의 논리 시각이며 실제 수집 시점 인증은 아니다.

결과에 `trainingLabel = { kind: SIMULATED_CLOSED_COST_FINAL, currency: KRW, grossPnlKrw, components, operatingAllocationKrw, finalNetPnlKrw, closedAt, labelAvailableAt, checkpointHash }`를 파생한다. 새 `netR`·위험 분모 선택·정규화·학습 fold 실행은 추가하지 않는다. 기존 학습으로 변환할 때 별도 계약으로 결정한다.

## 👥 모집단·중복·출력 상태

선택 프레임의 **모든 비벤치마크 item**을 재계산해 coverage에 남긴다. `CHART_SIGNAL`, `NO_CHART_SIGNAL`, `BLOCKED`와 원래 사유·평가 여부, 선택 여부를 기록한다. 벤치마크는 판단 근거이며 매매 표본에 포함하지 않는다.

scope는 `DECLARED_FRAME_POPULATION`이다. 이것은 제공된 합성 프레임의 전체 후보 목록일 뿐 전체 시장 모집단이 아니다. 미선택 후보는 `NOT_SELECTED_NO_EXECUTION_EVIDENCE`, 비용 심사 기록이 없는 후보는 `NOT_RECORDED`로 남긴다. 손실·무거래·미체결로 가짜 라벨을 채우지 않는다. 표본을 잘 고른 덕분에 이기는지, 놓친 거래가 무엇인지 이 자료 한 건으로 평가할 수 없다. 별도 분모 검증 없이 승률/False Positive/False Negative 비율을 계산하지 않는다.

### 하나의 진입 의도는 하나의 표본

- 추적 ID는 기존 runId/reservationId/명령·체결 key를 그대로 보존한다. 부분 체결, 취소·대체, 재전송, 다른 exportHash가 각각 표본이 되지 않는다.
- 새 비교 키 `intentKey`는 정규화한 `{ market, instrumentId, currency, sessionId, strategy, signalAt, side:BUY }`의 해시다. experimentId/runId/namespace/전송ID/전체 원자료 해시·검증시각은 포함하지 않는다. 동일 봉을 후속 프레임에서 선택하거나 실행 이름만 바꿔도 중복 진입으로 묶는다.
- `decisionBasisHash`는 당시 선택 원자료 근거·RVOL·승인 수량/가격/비용 문맥, `labelBasisHash`는 같은 intent의 체결 경제 내용/비용/배분/가용시각에 묶는다. 금융 추적 해시와 통계 중복 식별을 분리한다.
- S10-B에는 새 입력들을 각각 검증한 뒤 묶는 메모리 전용 비교 경로도 포함한다. 배치 최대16개·원문 합계64 MiB이며 외부 상태·레지스트리를 갱신하지 않는다. 같은 원본 입력의 정확한 반복은 한 행+중복 수로 반환한다. 같은 intentKey에 다른 실행·다른 경제 내용·다른 판본이 들어오면 **그 그룹 전체 HOLD**다. 최신/최고 수익 표본을 자동 선택하지 않는다.
- 이름 변경 복제·서로 다른 합성 시나리오도 같은 키이면 독립 표본으로 더하지 않는다. 이 보수적인 비교는 현재 배치 내 경계이며, 배치 사이 영속 중복 방지/전 세계 사건 식별은 아직 없다.

| 제안 결과 | 조건과 내용 |
| --- | --- |
| `SYNTHETIC_INPUT_ELIGIBLE` | 위 계약 전체 통과. 원자료에서 재구축한 RVOL·당시 문맥·확정 결과 및 근거/coverage 제공 |
| `HOLD` | 구조·신뢰 검증은 통과했으나 청산/마감/시점/원자료/중복 등 적격 조건 부족. 이유 코드와 검증된 진단만 제공, `trainingLabel:null` |
| 입력 거절 예외 | 잘못된 형식·한도·anchor·해시·위조 보고·명령 재생 불일치. 부분 적격 결과를 반환하지 않음 |

모든 결과에는 `purpose:TEST_ONLY`, `populationQualified:false`, `performanceQualified:false`, `learningAllowed:false`, `modelRegistrationAllowed:false`, `modelPromotionAllowed:false`, `orderSubmissionAllowed:false`, `liveEnabled:false`, `newSpendingAllowed:false`, `automaticResumeAllowed:false`를 둔다. 반환 배열/객체는 원자료와 분리한다. 이유 코드는 정렬·중복 제거하며 결과 해시는 결정론적으로 만든다. D4/V4 원본 보고의 status/HOLD/권한은 수정하지 않는다.

`HOLD`는 이번 읽기 결과의 상태이지 원장에 새 사건을 쓰거나 금융 writer를 멈추는 명령이 아니다. 학습 진단이 손절/취소 루프를 기다리게 해서는 안 된다. 현재 검증기는 오프라인 일괄 호출용이고 장중 tick 안에 넣지 않는다.

## 🧪 S10-B 인수 행렬 — 아직 미실행

아래16개는 인수 그룹이며 자동시험 개수나 통과 기록이 아니다. 새 구현은 양성과 음성을 함께 통과해야 한다. 정상 경로는 실제 기존 B/P 신호→S9-B→D8 근거를 사용하고 손익 기대값은 독립 BigInt/명세 계산으로 대조한다.

| ID | 구성 | 반드시 관찰할 결과 |
| --- | --- | --- |
| LI-01 | B/P 각각 원자료·명시20일 이력·부분 체결·현재 비용·D8 정상 | 적격1행, RVOL 독립 대조, 비용 원천/추정/배분 구분. 모든 권한 false |
| LI-02 | 기존 합성 2400차익/20거래비/50운영비, 과거10/N3 추정4 | 최종2330. TAX/EXCHANGE 비영 별도 사례에서도 component 합과 feeDelta 일치. 추정/지급 이중 차감 없음 |
| LI-03 | 확정 손실, 위험 중지·운영비 HOLD, 확정 비용 미지급/미수 | 손실 부호 때문에 제외하지 않음. 적격 결과와 pending/HOLD·현금·채무를 함께 보존, 자동 재개 없음 |
| LI-04 | 미래 봉·미래 정정을 크게 변경한 각각의 정당한 합성 실행 및 시점 prefix | 당시 RVOL/해당 프레임 판단 동일, 감사 입력 해시는 다를 수 있음. 고정 anchor만 무시한 변조는 거절 |
| LI-05 | 필요한 봉/벤치마크/기업행동 근거 누락·정정 충돌·가용시각 미래 이동 | 신호 재구성/특징 적격 실패, null 라벨. summary/trace만으로 구제하지 않음 |
| LI-06 | 임의 features/label/verified 주입, 다른 종목/선택/설정/forecast/운영비 근거 교차 결합 | strict 입력 또는 원신호/config/binding 대조에서 거절. 금액만 같아도 불일치 허용 안 함 |
| LI-07 | asOf가 close/label 가용시각 전·같음·후, 나중 export를 이른 asOf에 제공 | 경계전 HOLD, 정확한 경계 이후에만 적격. export/read 시간으로 과거 라벨 생성 금지 |
| LI-08 | D7만 존재, D8 OPEN/RECONCILING, 미배분/null·격리 입력 | 확정 라벨 생성 금지. 조작된 checkpoint는 재생 단계 거절 |
| LI-09 | 예약만/해제/UNKNOWN/부분 매수/부분 매도/열린 주문/무체결 | 진단에 원상태 보존, 0손익 완료나 가짜 표본 없음 |
| LI-10 | 부분 체결·취소/대체·동일 체결 재전송·동일 입력 반복 | 진입 의도 한 행/중복 수. 비용은 누적 amount 아닌 amountDelta 합, 이중 차감 없음 |
| LI-11 | 같은 intent의 새 experiment/run 이름·다른 export판본·상충 결과 | 같은 배치의 그룹 전체 HOLD, 최고/최신 결과 선택 금지. 배치 순열에 같은 정규 결과 |
| LI-12 | 같은 프레임에 신호·무신호·BLOCKED·벤치마크·미선택 후보 | 비벤치마크 전체 분모/사유 보존, 미선택/미평가의 결과 발명 없음, populationQualified false |
| LI-13 | envelope 재봉인 후 명령·비용·영수증·배분/권한 변조, 잘못된 외부 anchor | 기존 전체 재생 실패. 정상 보고만 붙여도 적격 수용 불가 |
| LI-14 | 숫자/지수 금액·비유한값·범위/바이트/깊이/노드/배치 초과·알 수 없는 버전 | 명시 거절/무쓰기, 반올림·부분 수용 없음 |
| LI-15 | 같은 입력 반복/반환값 변조/원 DB 종료 후 검사 | 동일 결과 해시, 원자료·DB/lease·금융 snapshot·권한 불변. 원 DB 없이 검증 가능 |
| LI-16 | 구형 D4/V3/학습 입력·학습 등록기에 새 입력/결과 제공 | 구형 해시·HOLD 보존, 기존 학습 경로는 새 형식을 거절. API/AI/학습/주문 호출0 |

입력 신뢰 오류가 먼저 발생하는 시험을 하위 HOLD 시험 통과로 세지 않는다. 시점/미확정 시험은 정당하게 만들어진 그 상태의 근거로 검사하고, 변조 시험은 외피 해시까지 재계산해 내부 의미 검증을 확인한다. 전 과정은 새 합성 메모리/임시 DB만 사용한다.

## ✅ S10-A에서 실제 확인한 것

Windows·Node24.20.0·기존 설치 환경에서 TypeScript 엔진/시험 빌드 종료0, 기존4파일 중 이름으로 선택한 **31/31 통과**(실패/취소/건너뜀0,53.36초), 원본37/37 일치를 확인했다. D4 전체, 신호 재생, S9-B 비용 후 D8 경로, V4의 D7/D8 구분 시험이다. LI-01~16을 실행한 것은 아니다.

```powershell
node work/cost-learning-input-design/check.mjs tests
```

이 로컬 작업 도구는 엔진 빌드 성공 후 `D4-A|REPLAY-|HA-05/13|OR-03 D7` 이름 패턴으로 해당 네 시험 파일을 실행하고 원본 검사를 한다. 로그는 `work/cost-learning-input-design/{build,boundary,originals}.log`에 남겼다. 반복 검사는 기존 로그를 덮어쓰므로 과거 결과 보존이 필요하면 별도 실행 경로를 쓴다.

문서/보존/표시의 최종 결과는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)를 따른다. 이번에는 제품 코드·시험·원본 정책·사용자 DB/서비스를 변경하지 않았다. 전체 npm test/앱 E2E·새 입력 검증기·LI 행렬·모델/실자료 수익성·최대 입력 성능·독립 외부 검토는 미검증이다. API·키/계좌·외부 자료 전송·유료 AI를 사용하지 않았다.

## ▶️ 다음 한 작업과 완료 기준

다음은 **DEV-D03-S10-B: 새 합성 입력 검증기 구현·인수**다. 새로운 장부나 학습 모델을 만들지 않는다. 공개 validator/입력 생성 helper, 필요한 순수 공용 helper, 관련 시험, 사용법과 PROGRESS까지만 수정한다. 원래 D03-03/04는 이 구현 하나로 자동 완료하지 않고 앱 관통 인수와 원래 잔여 항목을 따로 재평가한다.

```text
docs/COST_LEARNING_INPUT_DESIGN.md, 최신 PROGRESS와 개발 실행 가이드를 읽고 S10-B만 구현·검증해라.
새 TEST_ONLY 입력 봉투와 외부 anchor를 검증하고 기존 신호/운영비 replay를 재사용해라.
판단 시점 RVOL 원자료 재구축·당시 승인 추정 문맥과 D8 확정 비용/라벨 가용시각을 분리해라.
거래소 비용 등 component와 amountDelta를 보존하고 체결 가격의 마찰을 이중 차감하지 마라.
제공 프레임의 전체 후보 진단 및 배치 내 진입 의도 중복/상충을 처리해라.
정상 합성 입력 적격과 손실/미지급 보존, 누출·누락·중복·미확정 거절을 LI-01~16으로 인수해라.
검증은 읽기 전용이고 기존 D4/학습 스키마/V3/V4 해시·HOLD·원본 정책을 보존한다.
학습/모델 등록·승격·새 지출/자동 재개/주문 권한은 모두 false다.
UI·사용자 DB 이관·D9/D10 새 결합·정정/외화·API/키/계좌·외부 AI/전송은 제외한다.
실제 실행한 검사·실패/보완·미검증·변경 범위·다음 한 작업을 기록해라.
D03 2/4·가이드10/40·기존 누적158/167과 미완료9개는 임의 변경하지 마라.
```
