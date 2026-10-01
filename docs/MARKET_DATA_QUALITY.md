# 오프라인 시장 자료 품질 검사

2026-09-13. 시험용 종목과 벤치마크의 지정 시간 구간에 대해 가격·호가·1분봉의 식별, 시점, 정정, 결측과 값의 일관성을 검사한다. **자료 품질 시험이며 종목 추천·전략 평가·모의 주문·실주문 기능이 아니다.** 기존 카탈로그·상품 보강 결과, 실제 시세 CLI, 웹 화면과 자동으로 연결하지 않는다.

후속 연결: [다종목 통합 사전점검](MULTI_PREFLIGHT.md)에서 이 검사기를 원본 시험 입력으로 재실행하고 상품/버전과 대조한다. 개별 `market:quality` CLI가 자동으로 다른 결과 파일을 찾거나 실제 자료·주문에 연결되는 것은 아니다.

## 빠른 실행

기존 의존성이 설치된 프로젝트 루트의 PowerShell에서 실행한다. 설치·환경은 [README](../README.md)를 따른다. 추가 패키지·API 키·웹 서버·DB는 필요하지 않다.

```powershell
npm run build:engine
npm run market:quality -- fixtures/market-quality-v1.json
```

정상 출력은 `OFFLINE_MARKET_QUALITY_COMPLETE`, `status=TEST_WINDOW_VALID`, 대상 4개·정상 4개·보류 0개다. 매번 새 결과를 `data/market-quality-checks/시각-UUID.json`에 저장한다. 입력·이전 결과·사용자 모의매매 DB·일회용 코드를 변경하지 않는다.

[합성 샘플](../fixtures/market-quality-v1.json)은 KR/US 시험 종목 2개와 벤치마크 2개, 각 3분 구간의 1분봉 12개·최근 가격 2개·호가 2개다. 각 대상의 합계 거래량은 3,000이다. 가격·심볼·출처·달력·기업행동 가정은 전부 시험 값이며, 두 시장에 같은 시험 시각을 사용한 것은 실제 동시 개장 시간을 의미하지 않는다. 실제 기업이나 적절한 벤치마크를 조사·선정한 샘플이 아니다.

## 입력 계약

실제 기준은 [실행 스키마](../src/core/market-quality-schema.ts)와 [검사기](../src/core/market-quality.ts)다. 추가 필드를 거절하는 `OFFLINE_MARKET_QUALITY_V1`, `purpose=TEST_ONLY` 객체를 사용한다. REAL_DATA 입력과 실제 토스 응답을 자동 변환하지 않는다.

| 구성 | 필수 내용과 의미 |
| --- | --- |
| `asOf` | 자료를 사용할 수 있었던 기준 시점. UTC로 정규화하는 시간대 포함 ISO 시각 |
| `profile` | `profileId`, `purpose=TEST_ONLY`, `lastPriceMaxAgeMs`, `windowEndMaxAgeMs`. 신선도 두 값은 양의 안전 정수 또는 null이며 기본값 없음 |
| `sources` | 최대 64개 출처 ID와 허용 자료 종류 `BAR`/`PRICE`/`QUOTE`. 중복 ID·중복 종류 거절. 실제 출처 인증이 아님 |
| `assets` | 1~64개 시험 대상. `assetKey`, 식별정보, 역할, 지정 출처, 벤치마크 키, 시험 세션·시간 창·기업행동 가정 |
| `records` | 최대 50,000개 자료. 빈 배열은 형식상 허용하지만 필요한 자료가 없으므로 품질 보류 |

종목 식별은 `instrumentId`, `market=KR/US`, `venue`, `symbol`, `currency=KRW/USD`를 모두 사용한다. 심볼만으로 대체하지 않는다. 시장과 통화가 맞지 않거나 같은 시장의 ID 또는 같은 시장·거래소·심볼이 여러 대상에 등록되면 보류한다. 같은 심볼이라도 시장/거래소가 다른 경우를 무조건 충돌로 처리하지 않는다.

각 대상은 다음을 선언한다.

- `role`: `INSTRUMENT`는 봉·최근 가격·호가와 별도 벤치마크를 요구한다. `BENCHMARK`는 봉만 검사한다. 벤치마크의 선택적 가격·호가는 진단에만 집계하고 품질 근거로 쓰지 않는다.
- `sourceId`: 하나의 지정 시험 출처. null 또는 종류 권한 누락이면 보류한다. 다중 출처 합의나 자동 대체 공급원은 없다.
- `benchmarkKey`: 종목이 참조할 BENCHMARK 대상 키. 없거나 자기/다른 종목을 가리키거나 시간 창이 다르면 보류한다. 벤치마크 자체가 보류되면 참조 종목도 보류한다.
- `session`: `sessionId`, `openAt`, `closeAt`, `availableAt` 또는 null. 해당 대상에 명시한 시험 정규 연속 세션이다. 외부 휴장표 진위·DST·조기 종료 일정을 조사하는 기능이 아니다.
- `windowFrom`, `windowTo`: 시작 포함/끝 제외인 연속 구간. 세션 안에서 개장 기준 1분 경계에 맞고 끝이 `asOf` 이하여야 한다. 모든 대상의 요구 슬롯 합계는 최대 50,000개다. 이는 자원 상한이지 전략에 필요한 이력 길이가 아니다.
- `actionContext`: `status`와 `availableAt` 또는 null. 현재 이용 가능한 `NO_ACTIONS_IN_WINDOW` 시험 가정만 통과한다. `UNKNOWN`, `ADJUSTMENT_REQUIRED`, null, 미래 가정은 보류한다. 이 값은 실제 기업행동 부재 증명이 아니며 입력 시간 창 전체에 대한 시험 전제다.

## 행·시점·정정 계약

모든 행에 `recordId`, `assetKey`, `sourceId`, 전체 `identity`, 양의 안전 정수 `revision`, `observedAt`, `receivedAt`, `availableAt`이 필요하다. `recordId`는 출처 기록 표지이며 그것만으로 중복 제거하지 않는다. 전체 정규화 행 해시를 사용한다.

| 종류 | 추가 필드 | 값 검사 |
| --- | --- | --- |
| `BAR` | `sessionId`, `openAt`, `closeAt`, `basis`, `completed`, `halted`, `o/h/l/c/v` | 원본 기준 1분 길이·세션/정렬·완료·비정지 확인. 가격은 양수, 저가 ≤ 시가/종가 ≤ 고가, 거래량은 0 이상 |
| `PRICE` | `basis`, `price` | 원시 양수 가격과 시험 신선도 |
| `QUOTE` | `basis`, `bid`, `ask`, `bidSize`, `askSize` | 원시 양수 호가/잔량, bid ≤ ask, 원본 호가 신선도 |

가격·수량은 소수 문자열 또는 null이다. 숫자 JSON, 지수 표기, NaN/Infinity를 거절한다. 정수부 최대 18자리·소수부 최대 12자리 형식으로 제한하며 정규화된 소수로 비교/합산한다. 이 자원·표현 계약은 실제 호가 단위나 지표 정밀도 승인 프로필이 아니다. null·음수 등 의미상 나쁜 최신 값은 보류하며 좋은 과거 값으로 되돌리지 않는다.

시각은 최대 밀리초 정밀도만 허용한다. 더 작은 정밀도를 잘라 과거 시각으로 만들지 않는다. `observedAt <= receivedAt <= availableAt`을 강제한다. 봉은 완료된 자료의 관측이므로 관측 시각이 봉 종료보다 빠르면 보류한다.

처리 순서는 다음과 같다.

1. 전체 입력을 검증한다. 미래 행도 형식이 잘못되면 파일 전체를 거절한다.
2. 정규화 행이 완전히 같은 중복은 하나로 처리한다.
3. 이용 가능 시각 또는 봉 종료가 판단 시점 이후인 행은 제외하고 진단 개수를 남긴다. 같은 시각은 포함한다.
4. 요청에 없는 대상, 시간 창 밖의 봉은 현재 판단에 사용하지 않는다. 새로운 대상을 자동으로 추가하지 않는다.
5. 봉은 대상+시작 시각별 최고 revision을 선택한다. 최근 가격/호가는 관측 시각이 가장 최신인 사건을 먼저 고른 뒤 그 사건의 최고 revision을 선택한다. 과거 사건의 높은 revision이 최근 사건을 덮어쓰지 않는다.
6. 최신 동일 revision에 서로 다른 행이 있으면 임의 선택하지 않고 보류한다. 기록 표지나 수신 시각만 달라도 동일 기록이라고 추정하지 않는다. 높은 revision의 명시적 정정으로 해소할 수 있다.
7. 선택한 자료의 출처·식별·RAW 여부·값·시간·연속 구간을 검사한다. 잘못된 최신 자료를 버리고 이전 자료로 통과시키지 않는다. 빠진 슬롯과 비정렬 여분 봉도 보류한다.
8. 개별 봉의 거래량 0은 허용하지만 전체 창 거래량 0은 VWAP 분모로 사용할 수 없어 보류한다. 벤치마크도 동일하게 검사한다.

`basis`는 RAW만 이 경로에서 허용한다. ADJUSTED/UNKNOWN은 보류한다. 원본의 시점별 유효 분할 가격·거래량 조정이나 배당·체결 가격 변환을 여기에서 수행하지 않는다.

## 원본 수치와 시험 가정의 구분

| 항목 | 근거·처리 |
| --- | --- |
| 1분 원천 봉 | 원본 공유 B/P 명세 `input_contract.source_bar_minutes` 재사용 |
| 호가 최대 나이 | 원본 공통 정책 `execution.maximum_quote_age_seconds` = 2초. 관측 시각 기준, 정확히 2초는 포함 |
| 최근 가격 최대 나이 | `profile.lastPriceMaxAgeMs`의 명시적 TEST_ONLY 가정. 종목 역할에서 null이면 보류 |
| 시간 창 종료 최대 나이 | `profile.windowEndMaxAgeMs`의 명시적 TEST_ONLY 가정. `asOf-windowTo`로 검사하며 null이면 보류 |

샘플의 두 신선도 가정은 각각 2,000ms다. 실제 가격/봉 신선도 정책을 새로 확정한 것이 아니다. 수신 시각이 최근이라는 이유로 오래된 관측 가격을 신선하다고 처리하지 않는다. 컴퓨터 시각 오차를 측정하거나 원본의 500ms 시계 조건을 검증하는 기능은 없다.

## 결과와 한계

`TEST_WINDOW_VALID`는 요청한 짧은 TEST_ONLY 구간의 품질 조건 통과다. `BLOCKED`에는 대상별 `reasons`와 한국어 `reasonDescriptions`를 남긴다. `expectedBars`는 요구 슬롯 수, `validBars`는 그 슬롯에서 검사된 유효 봉 수, `totalVolume`은 모든 요구 슬롯이 유효할 때의 합계다. 여분 봉·호가·벤치마크 등의 오류가 별도로 존재할 수 있으므로 개수/합계만으로 전체 품질 통과를 판단하지 않는다.

`selected`에 선택된 원본 행과 그 해시를 보존한다. `decisionHash`는 현재 판단·선택 자료·정렬된 계약·정책/전략 해시를 결합하고, `inputHash`는 정규화된 전체 입력을 결합한다. 미래/무관/대체된 행과 입력 순서·완전 중복은 입력 감사에 영향을 줄 수 있지만 현재 판단이 같으면 판단 해시는 같다. 계약 변경은 판단 해시를 바꾼다. 외부 기관의 전자서명·자료 진위 보증은 아니다.

항상 `sourceAuthentication=UNVERIFIED_TEST_INPUT`, `realDataReady=false`, `strategyReady=false`, `strategyEvaluated=false`, `selectionPerformed=false`, `paperOrdersEnabled=false`, `liveEnabled=false`를 유지한다. 3분 샘플 통과는 원본의 120세션 준비, 지표·벤치마크 검증, 수익성 확인을 대체하지 않는다.

아직 제공하지 않는 범위는 실제 자료 인증/수집·이용 권리/비용 확인, 카탈로그/상품 정보 보강의 자동 연결, 실제 달력·기업행동·벤치마크 매핑 검증, 시점별 분할 조정, 지표 계산·전체 이력 재생, 거래대금/스프레드 투자 필터, 뉴스·후보 선정·전략/주문·웹 UI 연결이다. 과거 이력 전체나 현재 시장 전체가 이 샘플로 검증되지 않는다.

## 실행·검증·보안

`TRADING_MODE`는 미설정 시 PAPER, PAPER/BACKTEST만 허용한다. `LIVE_ENABLED=true`를 거절한다. 새 환경변수·외부 키·.env 자동 로딩은 없다. 로컬 JSON 인자 하나만 받으며 공용 [제한 파일 읽기](../src/server/catalog-file.ts)를 재사용한다. 최대 16 MiB·정상 UTF-8/BOM·일반 파일을 검사하고 직접 URL/UNC/장치 경로를 거절한다. 이 공용 경로의 오류명에는 `CATALOG_` 접두어가 남아 있다.

품질 보류라도 검사를 정상 수행·저장했다면 종료 코드 0이다. 모드/인자/정책/입력/저장 실패는 종료 코드 1이며 원문 오류와 입력 비밀값을 출력하지 않는다. 새 출력에 `wx`/`0600`을 요청하지만 Windows ACL, 연결 지점·네트워크 드라이브 전수 차단, OS 네트워크 격리, 디스크·전원 장애 내구성·암호화·백업을 보장하지 않는다. 신뢰하는 로컬 시험 파일만 사용한다. 입력/결과의 자동 삭제 정책은 없다.

```powershell
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/market-quality.test.js dist/runtime/tests/market-quality-cli.test.js
node work/verify-market-quality.mjs
```

마지막 명령은 타입·린트·형식·엔진/웹 빌드·관련 회귀·원본 보존·샘플 실행을 수행한다. 명령별 진행과 결과를 검증 기록 폴더 (로컬 비공개 기록: `work/market-quality-verification`)에 저장하여 중단을 성공으로 표시하지 않는다. 전체 제품 회귀/E2E·새 설치 검증은 아니며 사용자 일회용 코드에 영향을 주는 종료/인증 시험은 제외한다. 기존 관련 시험 일부는 별도 메모리 DB·임시 폴더·모형 통신을 사용한다. 실제 키·인증된 외부 통신·사용자 DB는 사용하지 않는다.

2026-09-13 실제 실행: 신규 37개와 기존 관련 200개, 총 **237/237 통과**(실패·건너뜀 0). 타입·린트·형식·엔진/웹 빌드 성공, 보존 대상 원본 37/37 일치, 샘플 4개 대상의 예상 결과를 확인했다. 실행 보고서 (로컬 비공개 기록: `work/market-quality-verification/report.json`)에 명령·종료 코드·출력이 있다. 기존 전략·기업행동 검사는 합성 회귀이며 실제 자료 전략 평가나 수익성 시험은 아니다. 로컬 문서 표시 검증은 GitHub 화면·실제 앱 E2E와 구분한다.
