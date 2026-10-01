# 오프라인 수익성 사전진단 사용법

_DEV-D07-P0 · 2026-09-28 · 개발자용 TEST_ONLY 읽기 보고_

---

## 📋 제공 범위

기존 `PAPER_LEARNING_EXPORT_V1` 파일 하나에서 **거래가 안 된 이유와 증거 공백**을 집계한다. 전략·위험 한도를 바꾸거나 거래를 진행하는 기능이 아니다. 수익률·알파·실전 q05를 추정하지 않으며 결과의 모든 주문·학습·승격 권한은 `false`다.

[기존 내보내기 검증기](../src/core/paper-learning-verify.ts)를 재사용해 해시, 판단/주문 연결, 체결·비용·청산 정합성을 확인한다. 추가로 중복 predicate, 선택된 전략과 명시적 FAIL의 충돌, 미평가 표시와 실행 결과의 충돌, 양립 불가능한 거절 사유를 검사한다. 입력을 고쳐 통과시키지 않는다.

해시는 내보내기 내부 일관성 검사이지 전자서명·원천 진위 보증이 아니다. 원본 봉으로 지표 전체를 재계산하거나 SQLite 감사 체인을 직접 재생하지 않는다. DB 검증이 필요하면 기존 [읽기 전용 내보내기](PAPER_LEARNING_BRIDGE.md)를 먼저 사용한다. 이 진단 CLI는 DB를 열지 않는다.

## 🔧 실행 방법

프로젝트 루트의 PowerShell에서 실행한다. 기존 설치 환경이 필요하며 이번 검증 환경은 Windows·Node 24.20.0이다. API 키나 추가 패키지가 필요하지 않다.

```powershell
npm run build:engine
if ($LASTEXITCODE -ne 0) { throw '빌드 실패' }
```

그다음 **이미 존재하는 합성 내보내기 JSON 경로**를 하나 지정한다. 아래 상대 경로는 자신의 파일로 바꾼다. 새 거래 기록을 만들거나 사용자의 실행 DB를 재개할 필요가 없다.

```powershell
$diagnosticExport = 'data/paper-learning-exports/자신의-실행/result.json'
$diagnostic = node dist/runtime/src/server/profitability-diagnostic-cli.js $diagnosticExport | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '사전진단 실패; 원본을 수정하지 마세요' }
$diagnostic.denominators
$diagnostic.reasonCounts
$diagnostic.decisions | Select-Object symbol, strategy, result, zeroSizingRecorded
```

정상 결과는 `schemaVersion=OFFLINE_PROFITABILITY_DIAGNOSTIC_V1`, `status=DIAGNOSTIC_ONLY`이며 기록이 비었으면 `NO_RECORDED_DECISIONS`다. 파일은 자동 저장하지 않고 표준 출력만 쓴다. 프로그램에서 불러올 때는 [순수 함수](../src/core/profitability-diagnostic.ts)의 `diagnoseProfitability(raw)`를 사용한다. 결과 해시에는 현재 시각/무작위 ID를 넣지 않아 같은 입력은 같은 결과를 낸다.

`TRADING_MODE`가 지정되면 PAPER/BACKTEST만 허용하며 `LIVE_ENABLED=true`는 거절한다. URL/UNC, 잘못된 JSON, 16MiB 초과 파일, 잘못된 내보내기는 읽기 경계에서 거절한다. 오류에는 원문 payload를 출력하지 않는다. 이 CLI의 환경 검사나 테스트용 차단기는 OS 격리 검증을 대체하지 않는다.

## 📊 분모와 탈락 수 읽기

| 필드                  | 분모/뜻                                | 혼동하면 안 되는 것                |
| --------------------- | -------------------------------------- | ---------------------------------- |
| `candidateDecisions`  | 파일에 기록된 판단 수                  | 전체 시장 종목/모든 탐색 횟수 아님 |
| `selectedSignals`     | 전략 B/P 하나가 선택된 판단 수         | 주문 승인 수 아님                  |
| `chartPassPaths.B/P`  | 알려진 공통+B / 공통+P trace 전부 PASS | B와 P를 동시에 만족하라는 뜻 아님  |
| `buyIntents`          | 모의 매수 의도 수                      | 체결 이벤트 수 아님                |
| `filledBuyIntents`    | 1주 이상 체결된 매수 의도 수           | 전량 체결만 세는 값 아님           |
| `fillEvents.BUY/SELL` | 개별 부분 체결 사건 수                 | 거래 건수/승률 분모 아님           |
| `closedPositions`     | 확정 청산 기록 수                      | 단순 매도 주문 수 아님             |

`predicateCounts`는 모든 기록 판단을 분모로 각 조건의 관측 결과를 센다. `reasonCounts`는 같은 판단의 같은 사유를 한 번만 센다. 서로 다른 사유는 동시에 셀 수 있으므로 합계가 판단 수를 넘을 수 있다. 보고서는 임의 승률/통과율을 계산하지 않는다.

`funnels`는 공통+B와 공통+P를 **각각** 고정 표시 순서로 읽는다. 해당 단계의 `eligible`은 앞선 단계가 모두 PASS인 판단 수이며 첫 FAIL/UNKNOWN/NOT_EVALUATED에서 순차 분모에서 빠진다. `excludedByEarlierStep`은 앞 단계에서 제외된 수다. 실제 평가기는 여러 조건을 평가하므로 뒷단의 관측 FAIL은 `predicateCounts` 및 판단별 `allFailures`에 그대로 남긴다. 이는 조건별 인과 효과나 필터를 제거했을 때의 성과 예측이 아니다.

`paths.firstBlocker`와 `allFailures`도 구분한다. 먼저 UNKNOWN이 있고 뒤에 FAIL이 있으면 첫 차단은 UNKNOWN, 전체 경로는 FAIL일 수 있다. 버전을 해석할 수 없는 trace는 UNKNOWN, 미지원 predicate는 `unmappedPredicates`에 보존한다. `chartPassPaths`는 알려진 B/P 조건에 한정되므로 미지원 조건을 포함한 전체 전략 통과를 보증하지 않는다.

## 🔍 단계별 증거와 1주 위험

| 상태            | 뜻                                                          |
| --------------- | ----------------------------------------------------------- |
| `PASS`          | 기록 또는 승인 경로에 해당 조건 통과 근거가 있음            |
| `FAIL`          | 기록에 명시된 조건 실패/거절                                |
| `UNKNOWN`       | 자료 누락·미지원 버전·확정 체결/청산 부재 등으로 알 수 없음 |
| `NOT_EVALUATED` | 알려진 실행 경로상 해당 검사가 수행되지 않음                |

판단별 `missingInputPredicates`, `unmappedPredicates`, 전체 `reasons`와 함께 거리·수량·예측·경제성·승인·체결·청산 `stages`를 확인한다. 근거가 없다는 이유로 PASS를 부여하지 않는다. 운영 가드·보유 제한·데이터 품질 등 세부 원인은 전체 사유에 보존하고, 기록만으로 복원할 수 없는 단계에 임의 배분하지 않는다.

- `recordedQuantity=0`만으로 자금 부족을 단정하지 않는다. `NO_FEASIBLE_LOT`가 있어야 `zeroSizingRecorded=true`다. 이 경우에도 어느 세부 한도가 원인인지는 별도 상태 증거 없이는 모른다.
- 예측 프로필이 없으면 예측은 UNKNOWN, 경제성은 NOT_EVALUATED다. 실제 평균/q05 예측이나 비용 0을 채워 넣지 않는다.
- FEATURES 결측 표시가 있으면 현재 평가기가 건너뛴 후속 조건을 NOT_EVALUATED로 표시한다. 표시 자체도 없으면 UNKNOWN이다.
- 미체결 의도가 아직 진행 중이면 체결 UNKNOWN, 체결 없이 취소/거절이 확정됐으면 FAIL이다. 체결됐어도 청산 기록이 없으면 청산 UNKNOWN이다.

1주 계산은 바인딩된 승인 스냅샷에 진입가·손절가·환율·초기 예산이 유효한 소수 문자열로 있는 경우만 수행한다. [기존 `costFor`](../src/core/risk.ts)를 재사용한다.

```text
stopCostKrw = ceil((1주 진입 수수료 + 손절가 기준 매도 수수료 + adverse buffer) × 환율)
oneShareRiskKrw = ceil((진입가 - 손절가) × 환율 + stopCostKrw)
withinRiskBudget = oneShareRiskKrw <= 기록된 initial_budget
```

기존 DECIMAL40_V1 및 원 단위 위험 올림 규칙이다. 이 올림은 장부 금액을 임의 보정하는 조정 사건이 아니다. 결과는 **위험 예산 대조만** 뜻하며 현금·포지션·유동성·경제성 검사 통과를 보증하지 않는다. 승인 기록과 대조 결과가 불일치해도 진단기는 과거 승인/예산을 수정하지 않는다.

거절된 판단에는 가격/손절/환율/예산 스냅샷이 없을 수 있어 `oneShare.status=UNKNOWN` 및 수치 `null`을 유지한다. 현재 장부·오늘 환율·다른 종목의 스냅샷을 가져와 과거 거절의 근거를 만들어내지 않는다. 기존 고정 합성 비용만 지원하며 DEV-D03 비용 코어 통합 완료를 의미하지 않는다.

## ✅ 검사와 오류 대응

```powershell
npm run build:engine
if ($LASTEXITCODE -ne 0) { throw '빌드 실패' }
node --test --test-concurrency=1 dist/runtime/tests/profitability-diagnostic.test.js
```

시험은 새 임시 모의 장부를 사용한다. 정상/0주/예측 부재/자료 결측/빈 기록, 복수 실패와 순차 분모, 중복/상충, 독립 BigInt 1주 검산, 읽기 전후 입력/SQLite 불변, CLI 읽기·외부 접속 차단 검사를 포함한다. 명시적 변조 fixture는 검사기 시험용이며 실제 엔진 생성 결과와 구분한다. 실행한 개수·추가 회귀·초기 실패는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)에 기록한다.

| 오류/증상                                                    | 확인할 점                                                 |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| `DIAGNOSTIC_ARGUMENTS_INVALID`                               | 내보내기 JSON 경로 하나만 지정                            |
| `PAPER_LEARNING_EXPORT_INVALID`                              | 지원 형식·필수 필드·크기 확인                             |
| `PAPER_LEARNING_EVIDENCE_MISMATCH`                           | 원본 내보내기/해시·체결 연결 조사; 임의 재서명 금지       |
| `DIAGNOSTIC_DUPLICATE_PREDICATE`                             | 동일/상충 predicate 중복 모두 원본 조사                   |
| `DIAGNOSTIC_TRACE_CONFLICT` / `DIAGNOSTIC_DECISION_CONFLICT` | 양립 불가 기록 조사; 자동 덮어쓰기 없음                   |
| `UNKNOWN`이 많음                                             | 해당 단계 증거가 부족한 상태; 수치를 채워 통과시키지 않음 |

## 📌 남은 작업

실자료/다일 백테스트, 기준선·시장 국면·공동 충격 비교, 실전 비용/예측 q05, AI 추가 효과, 웹 UI, DEV-D03-03/04 연결과 OC-U05/U07 정책은 미완료다. 기록 시점의 거절 수량/비용/예산을 더 자세히 보존하려면 새 기록 계약이 필요하므로 별도 범위를 정해야 한다. 이 P0는 [실행 가이드](DEVELOPMENT_EXECUTION_GUIDE_v1.md)의 D07 전체 완료나 실거래 준비 승인이 아니다.
