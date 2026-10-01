# 오프라인 학습 실험실

거래 조건을 바꾸지 않고 **선언된 합성 판단·결과로 로컬 모델을 실제 학습하고 비교하는 연구용 CLI**입니다. 원시 입력·실험 설정·모델 계수·예측·오차·실패 이력을 별도 SQLite에 보존합니다. GPT, 증권 API, 사용자 거래 DB, 실제 계좌·주문과 연결하지 않습니다.

현재 제공: 비용 포함 결과 연결, 시점별 학습 자료 구성, 평균 기준 모델과 ridge 회귀 비교, 순방향 시험, 실험 등록·시험 구간 재사용 차단, 결과 재조회·장애 기록, 명시적 엔진 기록의 RVOL 원본 재계산. **자동 재학습 스케줄, 전체 지표 재구축, 기존 웹 기록의 자동 수집, 모델 교체, 실제 수익성 검증은 아직 없습니다.**

2026-09-14 후속: [모의 기록–학습 연결](PAPER_LEARNING_BRIDGE.md)은 새 다종목 합성 실행에서 명시적으로 켠 판단/체결 기록과 [원본 RVOL 근거](LEARNING_RVOL_SOURCE.md)를 읽기 전용으로 내보내고 `ENGINE_LEARNING_RESEARCH_V2`로 연결합니다. 전체 내보내기 증거·RVOL 독립 계산·파생 행을 등록 시 재대조합니다. 기존 선언형/trace-only V1과 구분하며 웹 자동 수집·전체 지표/실자료 학습은 아닙니다. 아래 96쌍 샘플은 기존 선언형 회귀 시험입니다.

## 실행과 정상 확인

[README 실행 환경](../README.md#실행-환경)의 Windows/Node/npm을 사용합니다. 프로젝트 루트의 기존 의존성에서 실행하며, 의존성이 없다면 `npm ci --ignore-scripts`가 필요합니다. 설치에는 네트워크가 필요하지만 이 CLI의 실행에는 API 키·외부 서비스·웹 서버가 필요하지 않습니다.

```powershell
npm run build:engine
$learningSample = node dist/runtime/src/server/learning-cli.js sample | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '학습 시험 입력 생성 실패' }
npm run learning:register -- $learningSample.inputPath
if ($LASTEXITCODE -ne 0) { throw '실험 등록 실패' }
npm run learning:run -- $learningSample.experimentId
if ($LASTEXITCODE -ne 0) { throw '학습 연구 실행 실패' }
npm run learning:status -- $learningSample.experimentId
```

`sample`은 고정 관계식으로 만든 가상 판단/결과 96쌍과 고유 실험 ID를 생성합니다. 실제 주식 가격·B/P 평가 결과·거래일 달력이 아니며 특정 종목의 수익을 재현하지 않습니다. 2개 합성 특징, 명시적 연구용 lambda=0.1, 학습 최소 24/시험 최소 8행, 경계 간격 5분은 **실험 샘플 설정**이지 원본 전략·통계적 충분성·실전 승인 기준이 아닙니다.

첫 실행의 예상 확인값:

- 등록: `LEARNING_REGISTERED`, 상태 `REGISTERED`. 등록만으로 모델을 학습하지 않습니다.
- 실행: `LEARNING_RESEARCH_COMPLETE`, 보고서 상태 `RESEARCH_EVALUATED`, 적격 96·제외 0·fold 2개.
- 1구간: 학습 40·시험 19행. 2구간: 학습 60·시험 35행. 사이의 2행은 등록된 경계 간격에 위치합니다.
- 상태 조회: 저장 상태 `COMPLETE`. 보고서 생성 완료이지 실거래나 수익성 합격이 아닙니다.
- `forecastValidated`, `profitabilityValidated`, `automaticPromotion`, `paperOrdersEnabled`, `liveEnabled`는 false, `networkRequests=0`입니다.

출력의 `reportPath`에서 상세 JSON을 확인합니다. 같은 ID로 `learning:run`을 다시 실행하면 `reused=true`로 **저장된 결과만 재출력**하고 재학습하지 않습니다. JSON은 새 폴더에 저장됩니다.

샘플을 새 ID로 다시 생성해 같은 시장·시험 구간을 재평가하면 `LEARNING_EVALUATION_WINDOW_USED`가 발생합니다. 앞선 실험 ID로 결과를 다시 조회하세요. 좋은 결과를 얻으려고 등록 DB를 지우거나 시험 날짜만 바꾸지 마세요. 실제 새 연구 구간은 별도 계획과 자료가 필요합니다.

## 데이터·모델 구성

| 구성        | 현재 구현                                                                          | 경계                                              |
| ----------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| 입력 계약   | TEST_ONLY / DECLARED_SYNTHETIC, 원본 정책·전략 해시, 시장·전략·특징 정의·모델·구간 | 합성 선언만 수용하며 원천의 진실성은 미검증       |
| 판단 기록   | ID·종목·시장/통화·B/P/NONE·PAPER_ENTRY/ABSTAIN·시각·특징·근거 해시·위험 단위       | 주문 명령이 아니라 선언된 관측 기록               |
| 결과 연결   | 판단 해시, 종료·사용 가능 시각, 모의 확정/가정/미확정 구분, 손익·비용              | 실제 엔진의 체결/청산을 재검증한 결과가 아님      |
| 기준 모델   | 해당 학습 행의 평균 순 R                                                           | 별도 거래 전략이나 벤치마크 수익률 아님           |
| 후보 모델   | 학습 자료만으로 표준화한 ridge 회귀, 명시 lambda·계수·해시                         | 확률/하방 분위수 교정·실전 예측 프로필 없음       |
| 검증 보고서 | 같은 시험 행의 MAE·RMSE·편향·오차 차이·학습 범위 밖 입력                           | 승률·계좌 수익·낙폭·전략 우월성으로 승격하지 않음 |

형식은 [스키마](../src/core/learning-schema.ts), 완전한 생성 예제는 [합성 샘플](../src/core/learning-sample.ts)에 있습니다. 숫자형 특징은 최대 8개, 각각 DIMENSIONLESS 단위이며 단일 실험의 길이/순서가 고정됩니다. 첫 단계는 파일에 선언된 값을 사용하므로 `featuresRebuiltFromSource=false`입니다. 이름을 추세/거래량으로 붙였다는 이유만으로 실제 지표가 검증되지는 않습니다.

하나의 실험은 KR 또는 US, B 또는 P 하나를 등록합니다. 서로 다른 시장·전략·통화의 결과를 무조건 섞지 않습니다. 날짜는 UTC `Z` 형식, 정밀도는 밀리초까지이며 같은 순간의 `.000Z`/`Z` 표기 차이도 중복 판단 검사에서 구별하지 않습니다.

### 비용과 학습 목표

수수료·세금·슬리피지·환전·운영 비용의 선언값을 Decimal 40자리로 합산한 뒤 다음 연구 목표를 계산합니다.

```text
netR = (grossPnl - commission - tax - slippage - fx - operation) / riskUnit
```

모든 금액은 해당 판단의 통화입니다. R은 입력이 선언한 위험 단위에 대한 비율이며 실제 자금 한도 승인값이 아닙니다. 비용이 불명확하면 0으로 채우지 않고 제외합니다. grossPnl은 위 비용을 차감하기 전 값이어야 합니다. 이미 체결가에 반영된 슬리피지를 또 비용으로 빼지 않도록 향후 체결 프로필과 대조해야 합니다.

현재는 거래별 선언 비용을 반영합니다. 무거래일·거절 후보·전체 연구 비용의 배분, 계좌 일별 손익·환율/결제 대조는 구현하지 않았으므로 `operatingCostAllocationValidated=false`, `accountPerformance=null`입니다. 행별 R을 단순 합산한 것을 계좌 수익률이나 최대 낙폭으로 표시하지 않습니다.

### 제외·상충 처리

- 특징의 원천 시각 ≤ 사용 가능 시각 ≤ 판단 시각을 검사합니다. 판단 시점에 없던 특징을 학습에 사용하지 않습니다.
- `SIMULATED_CLOSED`이고 판단 해시·통화가 맞으며 결과가 확인된 행만 적격입니다. 미거래·다른 전략·COUNTERFACTUAL·UNRESOLVED·미확정 비용은 제외 사유를 남깁니다.
- 동일 종목·시장·전략·판단 순간의 복수 기록은 모두 보류합니다. 동일 결과는 중복 ID 목록으로 보존하고, 내용이 다른 결과는 자동으로 최신 값을 채택하지 않습니다.
- 나중에 도착한 정정은 이전 학습 시점의 결과를 소급 변경하지 않습니다. 보고서에 보이는 현재 결과와 각 fold에서 당시 사용한 자료가 다를 수 있습니다.
- 고아 결과, 부족한 학습/시험 표본 등은 BLOCKED로 표시합니다. 예측 오차 계산이 수치 범위를 넘으면 실패로 남기며 Infinity를 JSON null 또는 정상 지표로 바꾸지 않습니다.

입력 전체는 등록 DB에 보존합니다. 보고서 `outcomeIds`는 그 평가 시점까지 사용 가능했던 결과만 가리킵니다. 해시는 내용 일관성 검사이지 공급자 인증·전자서명이 아닙니다. 파일 내용과 가용 시각의 진실성은 현재 선언에 의존합니다.

## 시간순 검증과 모델 해석

각 fold는 `[trainFrom, trainTo)` 학습 구간과 `[testFrom, testTo)` 시험 구간을 등록합니다. 두 구간 사이에는 명시한 embargo 간격을 두며 시험 구간끼리는 겹칠 수 없습니다. 경계 간격만 검사하는 데 그치지 않고 **라벨의 종료·사용 가능 시각이 모두 trainTo보다 이른지** 확인합니다.

모델 평균·스케일·최솟값/최댓값·계수는 해당 학습 자료만 사용합니다. 두 번째 fold가 이전 시험 기간을 학습에 포함하는 것은 사전에 등록한 순방향 일정에 따른 것이며, 이전 시험 점수로 lambda나 특징을 자동 조정하는 기능은 없습니다.

후보는 다음 목적함수를 사용하는 작은 ridge 모델입니다. 절편은 정규화하지 않습니다.

```text
평균 제곱 오차 + lambda × 계수 제곱합
```

학습 특징을 평균 0·모집단 표준편차 1로 변환하고, 상수 특징은 스케일 1로 처리합니다. Cholesky 분해가 실패하거나 수치가 비정상이면 임의 계수로 대체하지 않습니다. 이는 `JS_FLOAT64_RESEARCH_V1`의 연구 계산이며 기존 금액 장부·지표 정밀도·위험 산식을 바꾸지 않습니다. 단위 테스트는 1/2특징의 해석적 해와 상수·공선성 사례를 대조합니다. 외부 ML 라이브러리와 전수 수치 동등성을 검증한 것은 아닙니다.

`maeImprovementR`는 같은 시험 행에서 기준 MAE - 후보 MAE입니다. 양수이면 그 자료에서 평균 절대 예측 오차가 작다는 뜻일 뿐, 투자 성과가 좋아졌다는 뜻은 아닙니다. 학습 범위를 벗어난 특징은 별도로 표시하며 좋은 행만 골라 오차를 숨기지 않습니다.

`empiricalNetQ05R`는 관측 라벨의 경험적 하위 분위수입니다. **다음 거래의 예측 손실 분위수가 아닙니다.** 개별 예측의 `netPnlQ05=null`, `calibrated=false`, `orderAuthorized=false`를 유지합니다. 기존 정책의 예측·경제성 심사에 이 모델을 바로 연결할 수 없습니다.

## 등록·저장·복구

파일은 다음 위치에 분리합니다.

- `data/learning-inputs/run-*/result.json`: 생성한 합성 입력
- `data/learning-lab/registry.sqlite`: 입력·실험 설정·상태·시험 노출·보고서·감사 해시 체인
- `data/learning-reports/run-*/result.json`: DB에 보존된 보고서의 새 JSON 사본

기존 사용자 앱 DB나 source-ingest 결과를 열어 수정하지 않습니다. 실행/조회는 등록된 DB가 없으면 새 DB를 만들지 않고 실패합니다. 알 수 없는 기존 SQLite 파일은 읽기 전용으로 application_id를 확인한 후 거절합니다.

1. REGISTERED: 입력·설정 해시를 묶어 등록합니다. 같은 ID·같은 입력은 멱등이며 같은 ID의 변경은 거절합니다.
2. RUNNING: SQLite 트랜잭션으로 시험 구간 노출과 실행권을 **계산 전에** 확정합니다. 같은 시장의 겹치는 구간은 기호·모델·실험 ID를 바꿔도 같은 등록 DB에서 재평가할 수 없습니다.
3. COMPLETE: 모델·점수·보고서가 DB에 함께 저장됩니다. 보고서 자체가 BLOCKED일 수도 있습니다. 이 상태는 제품/모델 승인 상태가 아닙니다.
4. FAILED 또는 중단된 RUNNING: 실패/사용한 구간을 남기며 자동 초기화·재학습하지 않습니다. 재개·상태 강제 해제 기능은 없습니다.

보고서 파일 게시가 실패해도 먼저 확정한 DB 결과는 남습니다. 같은 ID의 재실행은 재학습 없이 다시 내보냅니다. 파일은 신규 폴더의 partial에 기록·fsync한 뒤 rename하며, 남은 partial을 자동 삭제하지 않습니다.

최대 입력 16MiB, 판단 5,000개·결과 10,000개·특징 8개·fold 10개, 저장 실험 100개, 입력/보고서 논리적 합계 128MiB, 단일 보고서 64MiB 제한입니다. SQLite 페이지·저널 등을 포함한 OS 디스크 할당량 보증은 아닙니다.

등록은 프로그램 내부 평가보다 먼저 수행하지만, 사용자가 로컬 파일을 미리 보지 않았다는 증거는 아닙니다. 별도 폴더/PC의 등록 DB나 다른 도구에서 수행한 실험을 추적하지 않습니다. DB 전체와 해시 체인을 다시 만드는 관리자까지 막는 인증 장치도 아닙니다. 최종 독립 holdout·다중 실험 통계 보정·외부 감사·실거래 승격은 별도 미완료이며 `finalHoldoutEvaluated=false`입니다.

## 오류 확인

| 코드/상태                       | 의미·다음 확인                                                           |
| ------------------------------- | ------------------------------------------------------------------------ |
| LEARNING_INPUT_INVALID          | 계약·원본 해시·시각·차원·비용·ID·크기 확인. 오류 원문/비밀값 비출력      |
| LEARNING_EXPERIMENT_CONFLICT    | 같은 ID에 다른 입력을 등록하려 함. 기존 기록 보존                        |
| LEARNING_EVALUATION_WINDOW_USED | 같은 등록 DB에서 노출된 시험 구간. 기존 결과 조회 또는 새 연구 설계 필요 |
| LEARNING_REVIEW_REQUIRED        | 실패/중단된 실행. 자동 재시도·초기화 금지                                |
| LEARNING_REGISTRY_INTEGRITY     | 감사 체인·자료/보고서 해시·시험 노출 불일치. 데이터 보존 후 조사 필요    |
| LEARNING_REGISTRY_FULL          | 실험 수/논리적 크기 상한. 평가 기록을 삭제해 우회하지 않음               |
| LEARNING_EXPORT_FAILED          | 파일 내보내기 실패. status로 DB 완료 여부 확인 후 같은 ID 재조회         |
| RESEARCH_EVALUATED              | 연구 계산 완료, 실전 합격 아님                                           |
| BLOCKED                         | 표본/결과 연결 부족 등. fold/dataset 사유 확인                           |

CLI 종료 0은 명령 또는 진단 보고서 생성 성공입니다. BLOCKED 보고서도 정상 저장되면 0이며, 설정/저장/실행 오류는 1입니다. 키/토큰/계좌/유료 AI는 쓰지 않으며 기존 `TRADING_MODE`와 `LIVE_ENABLED`의 오프라인 제한을 유지합니다. 새 비밀 환경변수는 없습니다.

## 실제 검증과 남은 작업

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/learning.test.js dist/runtime/tests/learning-registry.test.js dist/runtime/tests/learning-cli.test.js
npm run verify:originals
```

실제 수행 명령·수치·실패 이력은 [PROGRESS · 공개 요약](PROJECT_STATUS.md)에 기록합니다. 테스트는 독립 임시 폴더/DB를 만들며 사용자의 실행 서버를 종료하거나 거래 DB를 읽지 않습니다. 외부 연결 함수·가짜 키 파일 접근을 막는 자식 프로세스 가드는 OS 전체 네트워크 격리 증명은 아닙니다.

다음은 기존 모의 엔진의 검증 가능한 판단/체결 내보내기와 이 기록의 연결, 원천 시점 자료에서 특징 재구축, 비용/시장별 예측 프로필 정의, 검증된 실제 자료 수용입니다. 실제 자료 비용/권리·보관 조건 확인과 승격 조건은 [준비도 대조](PHASE2_READINESS_AUDIT.md)를 따릅니다. 합성 계산 성공만으로 이 단계를 생략하지 않습니다.

위 문단은 최초 학습 모듈 인계 당시의 순서입니다. 후속 CLI의 명시적 새 실행 내보내기/연결은 추가됐고, 웹 자동 연결·원천 특징 재구축·실자료/예측·성과 검증은 남아 있습니다.

실제 시장 수익성·소액 실체결·장기 운영·일일 자동 학습/모델 교체·UI·실시간 시장/뉴스·GPT 연결·새 설치·실제 전원/디스크/OS ACL/모든 환경·전체 제품 회귀는 이번 검증 범위가 아닙니다. 수익 증가·손실 감소나 상용 제품 대비 우월성을 보장하지 않습니다.
