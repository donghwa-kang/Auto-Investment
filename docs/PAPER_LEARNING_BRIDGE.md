# 모의매매 기록과 학습 연결

새 다종목 **합성 모의 실행**의 판단·체결·비용을 같은 SQLite 트랜잭션에 기록하고, 읽기 전용 내보내기와 원본 대조를 거쳐 기존 학습 실험실에 연결합니다. 실제 데이터·계좌·주문·GPT·유료 AI는 사용하지 않습니다. 기존 위험 한도·매매 기준을 바꾸거나 학습 결과를 자동 적용하지 않습니다.

기록 생성·학습 변환은 명령행(CLI) 경로입니다. 후속 [모의 기록 분석 화면](ANALYSIS_RECORDS.md)은 이 기록 전용 실행을 읽기 전용으로 가져와 로컬 모형 분석에 사용합니다. 기존 4173/4184 웹 실험의 자동 기록 버튼·백그라운드 학습·과거 DB 자동 이관은 없습니다. 기록을 켜지 않은 과거 누적 장부에서 개별 체결 시각을 추정해 만들지 않습니다.

후속 [원본 RVOL 검증](LEARNING_RVOL_SOURCE.md)을 적용한 새 기록은 315개 원본 봉과 당시 세션/정정/분할 근거를 포함합니다. 아래 명령은 동일하며 현재 변환 결과·학습 입력은 V2입니다. 이전 출력/등록 기록은 자동 변경하지 않습니다.

## 실행과 정상 확인

[README 실행 환경](../README.md#실행-환경)의 Windows/Node/npm과 기존 의존성을 사용합니다. 프로젝트 루트에서 실행합니다. API 키·외부 서비스·웹 서버가 필요하지 않습니다. 의존성이 없다면 README의 설치 절차가 먼저 필요합니다.

### 1. 새 기록 전용 모의 실행

```powershell
npm run build:engine
if ($LASTEXITCODE -ne 0) { throw '엔진 빌드 실패' }
$bridgeReplay = node dist/runtime/src/server/signal-replay-sample-cli.js | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '합성 이력 생성 실패' }
$bridgePortfolio = node dist/runtime/src/server/portfolio-sample-cli.js $bridgeReplay.manifestPath | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '모의 실행 계획 생성 실패' }
$bridgeRun = node dist/runtime/src/server/paper-learning-cli.js record $bridgePortfolio.planPath | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '기록 실행 실패; 새 실행 폴더의 DB를 보존하세요' }
$bridgeRun
```

`npm run portfolio:record -- <계획 경로>`도 같은 명령입니다. 위 샘플은 원본 합성 120개 완료 세션과 현재 세션의 봉을 기존 평가기에 연결합니다. 정상 결과는 `PAPER_LEARNING_RECORDED`, 판단 4건(진입 승인 B/P 각 1건), 확정 청산 2건, 여러 개의 1주 부분 체결입니다. 실제 종목·가격·수익성 결과가 아닙니다.

출력에는 새 `databasePath`와 `exportPath`가 있습니다. 원시 이력·계획 파일도 보존하세요. 기록 완료는 주어진 명령 처리 완료이지 실전 승인이나 모든 임의 계획의 청산 보장이 아닙니다.

### 2. 연구 계획을 지정하고 변환

`fixtures/engine-learning-plan-v1.json`은 위 **고정 합성 샘플 날짜 전용** 연구 계획입니다. B 전략만 대상으로 하므로 P 거래를 섞지 않습니다. lambda·최소 학습/시험 행·구간은 연결 진단용 설정이며 원본 정책의 검증 기간이나 승인 문턱을 대체하지 않습니다.

```powershell
$bridgeConverted = node dist/runtime/src/server/paper-learning-cli.js convert $bridgeRun.exportPath fixtures/engine-learning-plan-v1.json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '학습 입력 변환 실패' }
$bridgeConverted
```

정상 출력은 `PAPER_LEARNING_CONVERTED`, `convertedDecisions=1`, `closedOutcomes=1`, 신규 `inputPath`·`reportPath`입니다. 변환 보고서는 **전체 판단 4건의 제외/보류 사유**를 보존합니다. 미거래·다른 시장/전략·특징 누락을 완료 거래로 채우지 않습니다. 변환 가능한 판단이 없으면 `NO_CONVERTIBLE_DECISIONS`, `inputPath=null`이며 학습 등록을 진행하지 않습니다.

### 3. 등록하고 표본 부족 진단 확인

```powershell
if ($null -eq $bridgeConverted.inputPath) { throw '학습 가능한 판단 없음' }
npm run learning:register -- $bridgeConverted.inputPath
if ($LASTEXITCODE -ne 0) { throw '학습 등록 실패' }
npm run learning:run -- $bridgeConverted.experimentId
if ($LASTEXITCODE -ne 0) { throw '학습 연구 실행 실패' }
npm run learning:status -- $bridgeConverted.experimentId
```

**이 샘플의 정상 연구 결과는 `BLOCKED`입니다.** B 진입이 1건뿐이어서 `INSUFFICIENT_TRAIN_ROWS`·`INSUFFICIENT_TEST_ROWS`, 모델/오차는 null입니다. 설정의 최소 표본을 낮춰 성공으로 만들지 않습니다. 연구 DB의 `COMPLETE`는 진단 보고서 저장 완료를 뜻합니다. 거래 승인·예측 검증·수익성 검증·자동 승격 플래그는 모두 false입니다.

같은 실험 ID 재실행은 `reused=true`로 저장된 결과를 재출력합니다. 같은 연구 구간을 다른 ID로 반복 평가하는 것은 기존 등록소가 차단합니다. 이미 샘플을 실행했다면 기존 실험을 조회하세요. DB 삭제나 날짜만 바꾸기로 우회하지 마세요.

### 저장된 기록만 다시 내보내기

```powershell
npm run learning:export -- $bridgeRun.databasePath
```

명시한 기록 DB를 읽기 전용으로 열고 한 읽기 트랜잭션에서 장부·감사 체인·명령 바인딩을 대조합니다. 엔진을 재개하거나 주문을 진행하지 않습니다. 같은 상태라면 내용 해시는 같고 출력 폴더만 새로 만들어집니다. 학습 기록이 없는 DB는 `PAPER_LEARNING_CAPTURE_NOT_ENABLED`로 거절합니다.

## 기록·연결 계약

| 단계               | 저장/검사 내용                                                                                  | 경계                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 엔진 기록          | 원본 판단/trace, 주문 ID, 개별 체결 시각·수량·대금·수수료, 확정 청산 시점·환율                  | 새 실행에서 명시적으로 활성화; 장부 커밋 실패 시 기록도 롤백         |
| 읽기 전용 내보내기 | 누적 장부 해시, 연속 감사 사건·명령 입력 해시·최종 상태 해시, 판단/주문/보유 연결               | 원시 시장 자료 재생이나 외부 공급자 인증은 아님                      |
| 체결 대조          | 주문별 누적 수량/금액, 체결 순서/통화/지정가, 포지션 수량·비용, 모든 관련 주문 종료             | 미청산·취소 불명·일부 체결을 확정 라벨로 바꾸지 않음                 |
| 학습 변환          | 시장·B/P별 분리, 원본 판단·스냅샷 해시, RVOL 1개 특징, 승인 당시 계획 R                         | 미거래/특징 누락은 진단과 원본에 남김; 가짜 특징/위험 단위 없음      |
| 학습 등록          | `ENGINE_LEARNING_RESEARCH_V2`, `ENGINE_RECORDED_SYNTHETIC`, 전체 내보내기 증거·RVOL 재계산·파생 행 대조 | 기존 선언형/trace-only V1과 출처를 구분 |

원본 판단/종목 ID는 길이·콜론 규칙이 다르므로 학습 ID에 전체 원문 해시를 사용합니다. 원래 이름은 `engineSource`의 기록과 변환 보고서에서 찾을 수 있습니다. 원본 기록·파생 행을 임의로 수정하면 해시/수량/비용/시점 대조에서 거절합니다. **로컬 관리자까지 막는 전자서명이나 실행 인증은 아닙니다.** 파일 전체를 일관되게 다시 만드는 관리자, 다른 PC에서 수행한 실험, 원천 자료의 실제 진실성은 이 검증으로 증명하지 못합니다.

## 특징·비용·손익의 정확한 의미

특징은 기존 `B_RVOL` 또는 `P_RVOL`과 원본 봉 재계산이 정확히 일치한 값 1개입니다. 새 입력은 `ENGINE_SOURCE_REBUILT`, 포함된 행의 `featuresRebuiltFromSource=true`입니다. 이는 합성 RVOL 한 개의 대조이며 최적 특징 선정/전체 전략 검증은 아닙니다. 원본 없는 과거 내보내기는 새 변환에서 보류하고, 이미 저장된 trace-only V1 학습 입력은 재계산 false인 이전 계약으로만 지원합니다. [시점·산식·호환성](LEARNING_RVOL_SOURCE.md)을 참고하세요.

```text
계획 riskUnit = (승인 진입가 - 승인 손절가) × 승인 수량  [거래 통화]
grossPnl = 실제 모의 매도 체결대금 합 - 실제 모의 매수 체결대금 합
netR = (grossPnl - 체결 시 인식한 수수료 합) / 계획 riskUnit
```

- 계획 위험은 판단 시 고정됩니다. 이후 부분 체결 수량이나 결과를 보고 분모를 바꾸지 않습니다. 미체결 때문에 실제 사용 금액과 계획 위험이 다를 수 있으며 이를 숨기지 않습니다.
- USD 거래는 USD로 라벨을 계산합니다. 기존 포지션 `netPnl`은 청산 시 환율로 환산한 KRW 값이므로 직접 라벨에 복사하지 않고 별도로 대조합니다. 환율 변동에 따른 전체 계좌 일별 성과는 아닙니다.
- `commission`에는 기존 합성 모형이 실제 장부에 인식한 매수/매도 fee 합만 넣습니다. 이 모형은 세금별 명세를 분리하지 않으므로 실제 세율이나 총비용 검증을 뜻하지 않습니다.
- 매수 ask/매도 bid는 이미 체결대금에 들어 있습니다. `slippage=0`은 **추가 차감 0**이며 스프레드가 없다는 뜻이 아닙니다. 예상 위험용 adverse buffer도 실제 비용으로 재차 빼지 않습니다.
- `tax=0`, `fx=0`은 이 고정 합성 엔진에 별도 세금·환전 비용 사건이 없다는 매핑입니다. 실제 거래에 그대로 적용하지 않습니다.
- `operation=0`은 고정 합성 운영 비용 0이고 장부 비용 사건이 없는 경우에만 적용합니다. 비용 사건이 있으면 배분을 추정하지 않고 전체 해당 라벨을 UNRESOLVED로 둡니다. 거절 후보/무거래일 연구비 배분·실제 총비용은 미검증입니다.
- 금액은 Decimal로 대조합니다. 현재 학습 계약의 8자리 소수 범위에 정확히 담기지 않으면 반올림해 넣지 않고 보류합니다.

라벨은 포지션 수량 0, 관련 주문 최종 상태, `CLOSED_RECONCILED`, 청산 시각·손익 대조가 모두 맞아야 확정됩니다. 미체결/미청산은 `UNRESOLVED`·손익/비용 null입니다. 미거래는 원본·진단에는 있지만 양수 위험 단위가 필요한 학습 진입 행으로 만들지 않습니다.

## 저장·장애·자원 제한

- `data/paper-learning-runs/run-*/paper.sqlite`: 새 기록 전용 모의 장부. 판단·체결 기록은 aggregate의 `manifest.learningJournal`에 함께 저장합니다. 별도 DB 이중 쓰기는 없습니다.
- `data/paper-learning-exports/run-*/result.json`: 내보낸 원본 연결 자료.
- `data/paper-learning-conversions/run-*/result.json`: 전체 판단 변환/제외 진단.
- `data/learning-inputs/run-*/result.json`: 원본 증거를 포함한 학습 입력. 기존 [학습 등록소](LEARNING_LAB.md)를 사용합니다.

판단 최대 500건, 체결 기록 10,000건, 청산 500건, journal JSON 8MiB 상한입니다. 내보내기는 aggregate/입력 16MiB, 감사 11,000건·본문 합 32MiB, 주문 2,000건 등을 제한합니다. 장기 저장 용량·실시간 처리 지연의 보증이 아닙니다.

기록 실패는 해당 명령의 장부·기록을 함께 롤백하며 마지막 확정 DB는 남깁니다. 입력/기록 한도 초과를 자동 삭제로 해결하지 않습니다. 기록 전용 CLI가 실패하면 새 `paper-learning-runs` 폴더의 DB를 보존하고 상태를 조사하세요. 자동 청산·실주문 fallback·실패 DB 삭제는 없습니다.

내보낸 JSON은 새 폴더의 partial 기록→fsync→rename 방식입니다. 파일 게시 실패 시 원본 DB·남은 partial은 유지합니다. 동일 DB의 `learning:export`는 재거래 없이 다시 내보낼 수 있습니다. 입력 저장 후 변환 보고서 게시가 실패하면 먼저 생긴 입력도 남을 수 있으며 명령 성공으로 표시하지 않습니다.

기록 활성 실행을 엔진 API로 재개하면 기록을 이어 보존합니다. 이전 미활성 DB를 소급 활성화하는 것은 쓰기 전 거절합니다. 사용자용 복구 CLI/웹 토글은 이번에 추가하지 않았습니다. SQLite readOnly/query_only는 앱 수준의 읽기 경계이며 Windows ACL·링크 경로 전수 격리·저널 보조 파일·전원 차단 안전성을 모두 증명하는 것은 아닙니다.

## 검증과 남은 범위

```powershell
node work/verify-learning-bridge.mjs
```

실행별 명령·종료 코드·출력은 `work/learning-bridge-verification/<실행 시각>/report.json`, 실제 결과와 초기 실패는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)에 남깁니다. 검사기는 지정한 엔진/학습/웹 서비스 관련 회귀를 실행하며 전체 제품 테스트나 브라우저 E2E는 아닙니다. 새 임시 DB와 소유 자식 프로세스만 사용합니다.

남은 범위는 기존 웹 화면의 명시적 수집/내보내기 연결, 단일 종목 legacy 엔진 기록, 다일/다실험 자료 결합, RVOL 외 특징·전체 원천 이력 독립 대조, 실제 자료/체결·비용 프로필, 독립 최종 holdout·성과·장기 운용 검증입니다. 이 샘플의 연결 성공이나 BLOCKED 진단만으로 수익성·손실 감소·실거래 신뢰성을 주장하지 않습니다.
