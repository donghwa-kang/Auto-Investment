# 오프라인 다종목 차트 신호 재생

2026-09-13. 원본 TEST_ONLY 통합 사전점검을 각 시점에 재실행하고, 별도 1분봉 이력을 기존 공용 B/P 평가기에 연결한다. **차트 신호 실험이지 매매 승인·수익성 백테스트가 아니다.** 실제 데이터·API·뉴스·AI·계좌·주문·사용자 웹 서버/DB를 사용하지 않는다.

## 실행

기존 의존성이 설치된 프로젝트 루트의 PowerShell에서 실행한다. 런타임·설치는 [README](../README.md)를 따른다. 새 환경변수나 패키지 설치는 없다.

```powershell
npm run build:engine
$replaySample = node dist/runtime/src/server/signal-replay-sample-cli.js | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '시험 입력 생성 실패' }
npm run replay:signals -- $replaySample.manifestPath
```

`npm run replay:sample`로 생성 결과를 직접 확인해도 된다. 출력의 `manifestPath`가 새 시험 입력이다. 생성기는 기존 합성 공급기의 국내 B/P 종목 2개와 공통 거래량 벤치마크를 사용한다. 각 이력은 120개 완료 세션과 현재 세션, 세션당 390개 1분봉을 가진다. 두 판단 시점은 가상 2026-08-31 개장 45분/60분 후다. 실제 휴장·상품·시세 조사 자료가 아니다.

- 입력: 매번 새 `data/signal-replay-inputs/시각-UUID/`에 매니페스트와 이력 3개를 생성한다. 샘플 생성은 재생을 자동 시작하지 않는다.
- 결과: 매번 새 `data/signal-replay-reports/시각-UUID.json`에 판단·조건별 수치와 근거를 저장한다. 원본 이력/기존 보고서를 덮어쓰지 않는다.
- 정상 출력: `OFFLINE_SIGNAL_REPLAY_COMPLETE`, 시점 2개·종목 판단 4건·평가기 실행 4건·신호 2건·무신호 1건·보류 1건. 보류도 보고서 저장이 완료되면 종료 코드 0이다.
- 개장 45분의 B 표본은 B 신호다. 같은 시점의 P 표본은 B 조건 미충족 및 P의 4개 연속 봉 부족으로 보류된다. 개장 60분에는 B 표본 무신호, P 표본 P 신호다. 신호가 나왔다고 주문을 생성하지 않는다.

## 책임 분리와 원본 대응

| 원본/책임 | 구현과 범위 |
| --- | --- |
| [공용 B/P 정의](../outputs/TRADING_STRATEGY_SPEC_v1.0.json)의 input_contract·indicators·predicates | [기존 전략 평가기](../src/core/strategy.ts)를 그대로 재사용. `indicators`, `dailyTrend`, `evaluateFeatures`, `asOfBars`의 계산 수치를 복사·수정하지 않음 |
| [공통 정책](../outputs/AI_TRADING_POLICY_v2.3.json)의 universe·price_data·lookahead_contract | [이력 준비기](../src/core/signal-history.ts): 전체 이력·120 완료 세션·현재 창 대조·시점별 정정/분할과 보류 |
| 종목/시점 연결 | [재생 조정기](../src/core/signal-replay.ts): 각 원본 [사전점검](MULTI_PREFLIGHT.md) 재실행 → 이력 연결 → 시점당 종목/벤치마크 계산 → 조건별 보고서 |
| 시험 정밀도·범위 | [시험 프로필](../profiles/signal-replay-v1.json): 기존 Decimal 40자리 HALF_EVEN, split-only, 거래량 있는 명시적 시험 벤치마크. 원본 null·검증 플래그는 그대로 유지 |
| 입출력·오류 | [로컬 파일 연결](../src/server/signal-replay-file.ts), [재생 CLI](../src/server/signal-replay-cli.ts), [명시적 샘플 생성](../src/server/signal-replay-sample-cli.ts) |

이번 매니페스트는 차트 하위 단계 전용이다. 원본의 자금·위험도·선정·예측·체결·초기 장부를 포함한 **완전한 매매 실험 등록이나 주문 스냅샷을 대신하지 않는다.** B/P가 동시에 통과하면 둘 다 기록하고 우선순위를 정하지 않는다. 위험도별 수량/한도·경제성·이벤트·뉴스·호가 반올림 후 진입/손절 거리 검사는 다음 매매 통합 단계에 남는다.

## 입력 계약

[스키마](../src/core/signal-replay-schema.ts)는 추가 필드와 실제 자료 purpose를 거절한다. 자원 상한은 시험 처리량 제한이며 투자 한도/감시 목록 선정식이 아니다.

| 입력 | 요구 사항 |
| --- | --- |
| 매니페스트 | `OFFLINE_SIGNAL_REPLAY_MANIFEST_V1`, `purpose=TEST_ONLY`, `experimentId` |
| 버전 연결 | `profileHash`는 시험 프로필의 canonical SHA-256(소문자), `policyHash`와 `strategyDefinitionHash`는 기존 원본 바이트 해시(대문자). null/다른 값이면 평가 보류 |
| `frames` | 1~8개의 원본 사전점검 입력. 각 root/catalog/market의 정규화된 asOf가 같아야 함. 중복 판단 시점은 거절하며 실행은 시간순 |
| `histories` | 최대 8개 `assetKey/file/snapshotHash`. 파일명은 같은 디렉터리의 영숫자로 시작하는 영숫자·밑줄·하이픈 + `.json`만 허용. URL·절대/상위/하위 경로, 중복 파일·자산 키 거절 |
| 파일 읽기 | 매니페스트와 **각 이력 파일마다** 기존 리더의 16 MiB·UTF-8·일반 파일 제한. 이력 해시는 정규화한 전체 이력 객체에 대한 canonical SHA-256이며 바이트 해시가 아님 |
| 이력 자원 | 자산당 최대 260세션·110,000개 행. 프레임당 시장 대상 최대 8개. 전체 선언 세션의 1분 슬롯 수 × 프레임 수 최대 2,000,000 |

순수 함수의 `OFFLINE_SIGNAL_REPLAY_V1` 입력은 이력을 메모리 내 객체로 받으며, CLI만 파일명/해시 연결을 해소한다. 재생 중 결측 이력을 생성기로 대체하지 않는다. 수동 시험 입력 수정 시 해당 이력 스냅샷 연결 해시도 명시적으로 다시 등록해야 한다. 해시를 맞추더라도 종목/출처/시점/가격 대조를 우회할 수 없으며 외부 진위 인증도 아니다.

### 이력 파일

`OFFLINE_SIGNAL_HISTORY_V1`, `purpose=TEST_ONLY`, `datasetId`, `assetKey`, `identity`, `sourceId`, `basis`, `sessions`, `actionCoverage`, `actions`가 필요하다. 컨테이너의 identity/sourceId는 모든 소속 봉에 적용되는 계약이며 외부 공급원 서명이 아니다. 현재 사전점검 대상의 ID·시장·거래소·심볼·통화·출처와 정확히 대조한다. basis는 RAW만 평가 가능하다.

세션마다 `sessionId/openAt/closeAt/availableAt/rows`를 선언한다. 시각은 **UTC Unix 밀리초 정수**다. 행은 `offset`(개장부터 0 기반 분 위치), `observedAt/receivedAt/availableAt`, `revision`, decimal 문자열 또는 null의 `o/h/l/c/v`, `completed`, `halted`다. 원천 봉 길이는 공용 계약의 1분으로 고정되며 다른 주기 봉을 이 형식으로 표시하면 안 된다.

- 형식 오류는 입력 거절이다. 형식상 유효하나 의미상 잘못된 가격/시점/세션은 종목별 보류다.
- 선언한 시작부터 해당 시점까지 완료됐어야 하는 모든 1분봉을 요구한다. 120개 완료 세션이 있어도 그보다 앞서 선언된 이력의 누락을 숨기거나 이동 구간으로 재초기화하지 않는다. 실제 거래소 달력의 완전성을 검증하는 기능은 아니다.
- 정규 세션의 시작·종료·가용 시점·겹침과 현재 세션 대응을 확인한다. 달력은 개장 전까지 알려져 있어야 한다. 아직 공개되지 않은 과거 세션을 생략해 정상 이력으로 취급하지 않는다. 달력 정정은 이 버전에서 자동 처리하지 않는다.
- 봉의 계산상 종료 ≤ observedAt ≤ receivedAt ≤ availableAt ≤ 판단 시점이어야 한다. 미래 수신/아직 종료 전 봉은 계산에서 제외한다. 완료돼야 하는 위치에 그런 봉만 있으면 누락으로 보류한다.
- 같은 세션/offset의 현재 최고 revision을 선택한다. 완전히 같은 행은 중복 제거하고, 동일 최고 버전의 다른 행은 상충 보류한다. 최신 정정이 무효라면 이전 유효 행으로 되돌리지 않는다.
- 현재 사전점검의 선택된 원시 봉과 OHLCV·세션·가용/수신/관측 시점·revision·완료/중단 상태를 대조한다. 기존 짧은 품질 검사 통과만으로 전체 이력을 통과시키지 않는다.

### 기업행동

`actionCoverage`는 `from/to/availableAt/status`이며 선언 이력 시작부터 판단 시점까지 KNOWN이어야 한다. 확인 범위 선언은 시험 가정이지 기업행동을 실제 조사했다는 뜻이 아니다.

각 사건은 `eventId/revision/announcedAt/availableAt/effectiveAt/kind/ratio/cancelled`를 보존한다. 당시 알려진 최신 정정을 선택하고 아직 효력이 없는 사건을 조정에 넣지 않는다. 현재 효력 여부가 상충하면 보류한다. 취소 정정은 반영하되 같은 효력 시각의 별도 사건을 중복 분할로 적용하지 않는다.

지원 범위는 확인된 **세션 개장 시점의 단순 분할/병합**이다. 현재 자료 창의 시작 시점 또는 그 이전 효력만 적용하여 창 내부에서는 RAW 단위가 바뀌지 않게 한다. 과거 가격은 비율로 나누고 거래량은 곱한다. 일봉과 분봉에 같은 split-only 단위를 적용하고 원시 현재 가격은 보존한다. 장중 분할·합병·코드 변경·미지원 사건·상충·누락은 보류한다. 배당의 총수익 조정·보유/주문/단주 정산 기능은 없다.

## 결과 읽기

| 종목 상태 | 의미 |
| --- | --- |
| `CHART_SIGNAL` | 기존 평가기의 차트·시간·추세·기초 유동성 조건상 B/P 신호 있음. 주문 전 가드·호가 반올림 후 거리 검사를 마친 것은 아님 |
| `NO_CHART_SIGNAL` | 지표를 계산했으나 해당 시점의 전략 조건이 충족되지 않음 |
| `BLOCKED` | 사전점검/프로필/이력/벤치마크가 부족하거나 상충함. 또는 신호가 없고 필요한 지표·연속 봉이 부족해 평가를 완결하지 못함 |

`strategyEvaluated`는 평가기 호출 여부다. 일부 조건이 MISSING이면 호출 후 BLOCKED도 가능하므로 evaluated와 blocked 집계는 서로 배타적이지 않다. `evaluation.trace`에 조건 ID, 입력값, 문턱, 연산자와 PASS/FAIL/MISSING이 들어간다. `stops`는 중간 산식 결과이며 매수 승인이나 실행 가능한 손절 주문이 아니다.

한 종목의 잘못된 이력은 그 종목을 보류한다. 공유 벤치마크 이력 오류는 이를 참조하는 모든 종목에 전파한다. 사전점검에서 벤치마크로 분류한 항목은 매매 판단 목록에서 제외한다. 원본 상품 제외/사전점검 실패는 상세 사유를 보존하며 평가로 우회하지 않는다. 참조되지 않은 이력은 입력 감사 해시에는 포함하지만 그 프레임의 신호를 계산하지 않는다.

`historyEvidence`는 시점별로 선택된 봉·세션·적용 분할·확인 범위를 결합한다. `inputHash/historyInputHashes`는 미래 자료를 포함한 전체 정규화 입력의 감사 해시다. 미래 봉의 변조/추가가 과거 유효 입력을 바꾸지 않으면 판단 해시는 같고 전체 입력 해시는 달라진다. 명시적 프로필·세션/기업행동 확인 범위·대상 계약 변경은 새로운 시험 계약이며 같은 판단 해시를 약속하지 않는다.

보고서는 `realDataReady/performanceQualified/selectionPerformed/riskEvaluated/economicEvaluated/paperOrdersEnabled/liveEnabled=false`를 유지한다. 순 기대값 비교·B/P 우선순위·추천 순위는 계산하지 않는다. 기존 평가기의 합성 출처 문자열만 해당 입력 근거 해시로 감싸며 수치·판정 로직은 바꾸지 않는다.

## 검증·보안·성능 한계

```powershell
node --test --test-concurrency=1 dist/runtime/tests/signal-history.test.js dist/runtime/tests/signal-replay.test.js dist/runtime/tests/signal-replay-cli.test.js
node work/verify-signal-replay.mjs
```

첫 명령은 엔진 빌드 후 실행한다. 두 번째 명령은 타입·린트·형식·빌드·관련 회귀·원본 보존·샘플 생성/재생을 수행하고 검사 폴더 (로컬 비공개 기록: `work/signal-replay-verification`)에 로그/종료 코드/실행 시간을 남긴다. 이번 경계 시험의 일부는 처리 시간을 줄이기 위해 **120개 과거 세션 각각을 명시적 가상 60분 세션**으로 선언한다. 120세션 수는 줄이지 않으며 CLI 수용시험/사용자 샘플은 기존 390분 세션 자료를 사용한다.

명시적 함수 호출 시험 외에 자식 CLI의 실제 파일 읽기·저장·LIVE 차단·정책/해시/입력/저장 실패·입력 보존을 검사한다. 관련 과거 전략/이벤트 시험은 합성 회귀이며 실제 시장 성과가 아니다. 결과는 실행 보고서 (로컬 비공개 기록: `work/signal-replay-verification/report.json`)에 기록한다.

2026-09-13 최종 실행: 신규 36개(이력 20·재생 8·자식 CLI 8)와 기존 관련 278개, 총 **314/314 통과**(실패·건너뜀 0). 타입·린트·형식·엔진/웹 빌드·원본 37/37 보존·샘플 생성/재생도 성공했다. 저장 보고서의 종목별 조건·신호/보류·비활성 플래그를 직접 확인했다. 전체 제품 시험이나 실제 시장 성과 검증은 아니다.

계산은 별도 CLI에서 수행하며 앱 보호/청산 경로를 점유하지 않는다. 봉 선택·현재 창 대조에 Map을 쓰고 동일 시점 공유 벤치마크 계산을 재사용한다. 마지막 검사에서 3개 이력 파일(각 47,190개 1분봉), 2개 시점을 읽고 보고서를 저장한 명령은 약 45.3초였다. 이 PC/합성 입력의 단일 실행 관측이며 속도 보장이나 순수 평가기 벤치마크가 아니다. 시점마다 공용 평가기를 전체 재계산하므로 대규모/장기 재생 속도·실시간 신호 기한·SLA는 보장하지 않는다. 이후 증분 계산 도입 시 이 구현을 재생 일치의 비교 기준으로 삼아야 한다.

입력 파일의 URL/직접 경로 탐색은 거절하지만 Windows 연결 지점/심볼릭 링크/네트워크 드라이브·ACL·OS 네트워크 격리를 보장하지 않는다. 신뢰하는 로컬 시험 디렉터리를 사용한다. 출력에는 0600을 요청하지만 실제 Windows ACL 검증은 아니다. 토큰·자격증명을 읽는 경로는 없다. 표준 오류에 원문 JSON/파일 경로/OS 예외를 복사하지 않는다. 실패 후 생성된 부분 샘플을 자동 삭제하거나 완료로 표시하지 않는다.

미검증/후속: 실제 출처·권리/요금·종목/달력/기업행동의 진위, 실제 과거 모집단·벤치마크 적합성, 뉴스/테마/선정/AI·예측·비용·체결/수량/위험·주문·UI 통합, 실제 성과·표본 외/봉인 시험·장기 운영, 전체 제품 회귀/E2E·새 설치·OS 격리·전원/디스크 장애. 원본 승격 기준이나 실거래 플래그를 이 시험으로 완료 처리하지 않는다.
