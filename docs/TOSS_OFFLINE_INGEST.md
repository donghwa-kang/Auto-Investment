# 토스 REST 모의 응답의 오프라인 형식 변환

토스 REST 응답 형식을 **직접 만든 모의 JSON**으로 검증하는 독립 CLI입니다. 목록·상세·현재가·호가·종목/지표 1분봉·국내/미국 달력을 정규화하고, 누락·미래 자료·상충·페이지 공백을 보고합니다. 실제 API 수집기, 거래 후보 선정기 또는 매매 엔진이 아닙니다. 웹 화면에도 연결하지 않았습니다.

이 모듈의 `MOCK_TRANSFORM_COMPLETE`는 형식 시험 완료만 의미합니다. 정상 결과에서도 `realDataReady`, `strategyReady`, `strategyEvaluated`, `paperOrdersEnabled`, `liveEnabled`는 모두 false입니다. 원본 거래 기준과 기존 TEST_ONLY 입력 계약은 변경하지 않았습니다.

## 실행

[README의 실행 환경](../README.md#실행-환경)을 갖추고 프로젝트 루트에서 실행합니다. 기존 의존성이 없다면 먼저 `npm ci --ignore-scripts`가 필요하며 설치에는 네트워크가 필요합니다. 변환 CLI 자체는 키·웹 서버·계좌·DB·외부 서비스가 필요하지 않습니다.

```powershell
npm run build:engine
npm run source:ingest -- fixtures/source-ingest-v1.json
```

[샘플](../fixtures/source-ingest-v1.json)은 가상 ETF `TEST`, 가상 ISIN·가격·거래량, 형식 시험용 KOSPI 값과 달력입니다. 실종목 사실·당일 시장 시세·공식 달력 복사본이 아닙니다. 고정 `asOf=2026-09-14T13:33:02Z`를 사용하므로 오늘 시세로 해석하지 마세요.

정상 출력:

```json
{
  "result": "OFFLINE_SOURCE_INGEST_COMPLETE",
  "status": "MOCK_TRANSFORM_COMPLETE",
  "counts": {
    "captures": 9,
    "observations": 11,
    "blocked": 0,
    "duplicates": 1,
    "pagePlans": 1
  },
  "networkRequests": 0,
  "realDataReady": false,
  "paperOrdersEnabled": false,
  "liveEnabled": false
}
```

실제 출력에는 `purpose`, `dataOrigin`, `reportHash`, `reportPath`도 포함됩니다. 보고서는 `data/source-ingest-checks/run-*/report.json`에 저장됩니다. 반복 실행은 매번 새 폴더를 만들며 기존 파일·DB를 열어 갱신하지 않습니다. 웹 서버 재시작이나 토스 키 입력은 필요하지 않습니다.

## 입력 계약

[루트 스키마](../src/core/source-ingest-schema.ts)는 다음 고정 표시를 요구합니다. 실제 수신 자료를 MOCK_RESPONSE나 TEST_ONLY로 이름만 바꾸어 넣으면 안 됩니다. 이 단계에는 실제 수신 자료를 승인하는 계약이 없습니다.

```json
{
  "schemaVersion": "OFFLINE_SOURCE_INGEST_V1",
  "purpose": "MOCK_CONTRACT",
  "dataOrigin": "MOCK_RESPONSE",
  "source": "TOSS_REST",
  "sourceSpecVersion": "1.2.17",
  "asOf": "2026-09-14T13:33:02Z",
  "captures": [],
  "pagePlans": []
}
```

위 틀 자체는 자료가 없어 거절됩니다. 둘 중 하나에 캡처/계획이 있어야 합니다. 완전한 예제는 샘플을 사용하세요. JSON에는 API 키·토큰·인증 헤더·계좌 정보가 들어갈 필요가 없습니다.

각 캡처는 `captureId`, 허용된 `request`, `requestedAt`, `receivedAt`, `availableAt`, `outcome`, `httpStatus`, `response`를 가집니다. ID는 전체 입력에서 유일해야 하며 요청 ≤ 수신 ≤ 사용 가능 시각이어야 합니다. `TIMEOUT` 모형은 상태 코드·응답이 둘 다 null이어야 합니다. 비정상 HTTP 상태는 응답 내용을 출력하지 않고 실패 사유·해시만 보존합니다.

| 요청 kind         | 정규화·검사 범위                                                   | 자동으로 증명하지 않는 것                     |
| ----------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| LISTING           | 7개 시장 구분 중 명시한 한 시장의 기호·이름·종류·ISIN              | 시장 전체 완전성, 과거 상장 모집단, 주문 자격 |
| DETAIL            | 요청 대상과 응답 시장/통화 대조, 상장·배수·국내 거래정지 필드 보존 | 기초자산 종류·예탁금·실계좌 거래 가능 여부    |
| PRICES            | 요청 대상·통화·양수 가격·원천 시각                                 | 현재가 신선도 프로필·추천/매매 신호           |
| ORDERBOOK         | 통화·양수 호가/비음수 수량·유효 최우선 호가·교차·기존 2초 상한     | 실제 호가 품질·체결 확률·거래 장소 보증       |
| STOCK_CANDLES     | 원시 1분봉 요청, OHLCV, 종료 시각에서 시작 시각 변환               | 수정·분할 이력과 과거 시점 가용성             |
| INDICATOR_CANDLES | KOSPI/KOSDAQ 1분봉, 시작 시각에서 종료 시각 변환, POINTS           | 전략에 맞는 벤치마크 선정·통화 자산 가격      |
| CALENDAR_KR       | 거래일 관계·세션 순서·동시호가 경계·국내 현지 날짜                 | KRX/NXT 개별 체결 장소, 연속매매 허용 시간    |
| CALENDAR_US       | 거래일 관계·세션 순서·뉴욕 현지 날짜·오프셋 보존                   | 휴일/조기 종료 사실 확인, 전략 세션 승인      |

응답 필드는 [공식 REST 1.2.17 명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)를 바탕으로 수동 정의했습니다. 모든 API를 생성·구현한 SDK가 아니며 실제 응답 호환성 수용시험은 아직 하지 않았습니다. 알 수 없는 필드·숫자 대신 요구되는 십진 문자열 위반은 해당 행/캡처를 보류합니다. 명세 버전 변경 시 별도 검토가 필요합니다.

요청 대상은 KR/KRW 또는 US/USD 조합, 대문자 기호를 사용합니다. DETAIL/PRICES는 최대 200개이며 기호 중복을 허용하지 않습니다. 봉은 `interval=1m`, 종목은 `adjusted=false`만 허용합니다. 일봉·자동 수정주가 대체·임의 URL/헤더/필터 추가는 없습니다.

## 시점·식별·중복·상충

- `sourceTimestampRaw`는 원천 오프셋 문자열, `eventAt`은 UTC입니다. 봉은 `openAt`/`closeAt`과 `timestampConvention`을 함께 보존합니다. 밀리초보다 정밀한 시각은 자르지 않고 거절합니다.
- `receivedAt`과 `availableAt`을 따로 남기고, asOf 이후에 사용 가능한 캡처는 보류합니다. 이를 과거 정상 관측의 변경 증거로 섞지 않습니다. 지금 받은 과거 봉이 당시에도 알려졌다는 증거로 바뀌지 않습니다.
- 공급자의 공개 시각·정정 번호는 없으면 `sourcePublishedAt=null`, `sourceRevision=null`입니다. `localObservationVersion`은 사용 가능 시각 순(동률이면 ID 순)의 로컬 내용 버전이지 공급자 정정 순서가 아닙니다.
- 같은 논리적 키의 같은 값은 삭제하지 않고 `duplicateOf`로 연결합니다. 값이 다르면 두 값 모두 남기고 `SOURCE_REVISION_UNVERIFIED`로 보류합니다. 직접 캡처와 페이지 계획 사이의 상충도 검사합니다. 최신 값을 자동 채택하지 않습니다.
- 원천 시각이 없는 목록/상세는 SNAPSHOT 키를 사용합니다. 다른 시점의 변경도 공식 효력 시각 없이 자동 해소하지 않습니다. 이것은 보수적 형식 시험이지 상품 이력 DB가 아닙니다.
- 응답이 기호/시장/장소를 주지 않는 자료는 요청 문맥을 보존하면서 `REQUEST_CONTEXT_UNVERIFIED`, `executionVenue=null`로 표시합니다. 상세 응답에 시장이 있어도 실제 인증된 사실은 아닙니다.
- 기업행동·기초자산·정지 여부는 해당 자료가 없으면 UNKNOWN/null입니다. 레버리지 배수만으로 SOXL 같은 지수형 상품을 일괄 금지하거나 단일종목 레버리지를 자동 승인하지 않습니다.
- KR integrated 세션은 공급자 구간입니다. 동시호가 경계를 보존하지만 곧바로 전략의 연속매매 시간으로 사용하지 않습니다. 달력의 명시적 null과 누락 필드는 구별합니다. 달력과 모든 봉의 실제 거래 세션 대조는 이 단계에 없습니다.

입력/응답/보고서 해시는 정렬된 JSON 의미값 기준입니다. 원본 파일의 바이트 해시·전자서명·공급자 인증이 아닙니다. 입력 파일을 수정하지 않으며 원시 응답 전체를 결과에 복사하지 않습니다. 검증된 필드와 원천 시각을 보존하고, 알 수 없는 행은 `data=null`과 사유/해시만 남깁니다.

## 모의 페이지 계획

`pagePlans`는 봉 요청, `windowFrom`/`windowTo`의 완료된 연속 분 구간, `maxPages`, 미리 입력한 `replies`로 구성됩니다. 함수는 이 배열만 소비합니다. 네트워크 요청·자동 대기·재시도·인증은 없습니다.

1. 요청 기호·시장·통화·봉 종류·count·before가 계획과 같은지, 이전 수신 이후에 다음 요청을 했는지 대조합니다.
2. 공급자의 `nextBefore`만 다음 before로 사용합니다. inclusive 경계의 같은 봉은 중복으로 연결합니다. 커서 누락/반복/미래 이동·비내림차순·새 봉 없는 반복을 보류합니다.
3. HTTP 실패·timeout·잘못된 응답도 시도 수에 남기고 중단합니다. 예산을 다 써도 추가 응답을 소비하지 않습니다.
4. `nextBefore=null`의 빈 페이지는 공급원 종료 표시이고, 커서 누락/비어 있지 않은 커서의 빈 페이지는 미해결입니다. 어느 경우에도 요청 창의 빠진 분을 채우지 않습니다.
5. `MOCK_WINDOW_COVERED`는 지정한 연속 모의 분 구간이 차 있다는 뜻입니다. `SOURCE_EXHAUSTED`는 모형 응답의 종료 표시이지 실제 가장 오래된 제공 이력의 증명이 아닙니다.

예제는 3분을 2페이지로 읽고 경계 1봉이 겹칩니다. 120세션/36개월 수집·주말/휴일을 제외하는 장기 스케줄러가 아닙니다. 페이지별 관측 수는 로컬 계산이며 전역 상충이 생기면 상태가 INCOMPLETE로 내려갑니다.

자원 상한은 16MiB UTF-8 로컬 JSON, 전체 응답 10,000행, 직접 캡처 100개, 계획 5개, 계획당 50페이지/10,000분, 페이지당 200봉입니다. 전체 행 상한은 아직 소비하지 않은 모의 응답까지 계산합니다. 출력은 최대 64MiB입니다. 이는 구현용 상한이지 원본 거래 기준이나 실제 API 이용 허가량이 아닙니다.

## 저장·오류와 문제 해결

CLI는 로컬 JSON 하나만 받으며 URL/UNC를 거절합니다. PAPER/BACKTEST 외 모드·LIVE 플래그·원본 정책 불일치는 처리 전에 거절합니다. 기존 자격증명 환경변수나 `.env`를 읽어 실제 수집으로 전환하지 않습니다.

저장은 새 폴더에 `report.partial`을 배타적으로 쓰고 파일 fsync 후 `report.json`으로 rename합니다. 완료 표시 전에 저장 해시와 거래 비활성 경계를 다시 대조합니다. 실패한 부분 파일은 자동 삭제하거나 완료 파일처럼 사용하지 않습니다. 새 실행은 다른 폴더를 씁니다. Windows ACL·디렉터리 fsync·전원 손실·심볼릭 링크/재분석 지점 공격에 대한 내구성 보증은 아닙니다.

| 관찰 결과                        | 의미와 확인 방법                                                               |
| -------------------------------- | ------------------------------------------------------------------------------ |
| 종료 0 + MOCK_TRANSFORM_COMPLETE | 형식 진단·저장 완료. 실자료/전략/거래는 계속 비활성                            |
| 종료 0 + HAS_BLOCKS              | 보류 사유를 정상적으로 보고서에 저장. captures/pagePlans의 reasons 확인        |
| 종료 1 + INGEST_INPUT_INVALID    | 입력 목적/버전/요청/시각/크기/인증 필드 확인. 오류에 입력 원문은 출력하지 않음 |
| 종료 1 + INGEST_ROW_LIMIT        | 모의 자료 크기를 줄이거나 독립 창으로 분리. 장기 이력 합격으로 해석하지 않음   |
| 종료 1 + INGEST_SAVE_FAILED      | 전용 출력 경로의 파일 충돌/쓰기 조건 확인. 기존 데이터를 지우는 자동 복구 없음 |
| 종료 1 + 기타 코드               | 인자·로컬 파일·원본 정책·오프라인 환경 조건 확인. 실거래 설정으로 우회 금지    |

금지된 키 이름과 허용 필드만 통과시키는 방식은 오류 본문/인증 필드가 보고서에 복제되는 것을 줄입니다. 이름 같은 일반 필드에 숨긴 모든 비밀값을 탐지한다는 뜻은 아닙니다. 보고서를 외부 공유하기 전 별도 검토가 필요합니다.

## 개발 검사와 남은 단계

프로젝트 루트, 기존 의존성에서 실행합니다.

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/source-ingest.test.js dist/runtime/tests/source-ingest-cli.test.js
npm run verify:originals
```

신규 검사는 정상 8종 변환, 누락/상충/미래/통화/호가 경계, 동시호가/미국 날짜 넘김, 페이지 실패/예산/공백, 네트워크·센티널 키 읽기 금지 자식 CLI, 반복/부분 저장·해시 변조를 다룹니다. 네트워크 가드는 테스트 자식의 fetch/Node 연결 함수와 센티널 파일 접근을 검사하며 OS 전수 격리 증명은 아닙니다. 실제 수행 결과·초기 실패·관련 회귀 범위는 [진행 기록 · 공개 요약](PROJECT_STATUS.md)에 있습니다.

미검증: 인증된 실제 응답·목록 완전성·실제 장기 이력·기업행동·뉴스·벤치마크·선정/예측/체결 프로필·전략 수익성·장기 운영·새 PC 설치·전체 제품/브라우저 회귀. 이번 단계는 사용자 서버/DB·API 키·토큰·계좌·실주문·유료 AI를 사용하지 않습니다.

다음은 이 계약을 실제 수신 자료로 승격하는 별도 수용 계획입니다. 먼저 조회 비용/권리·보관 조건과 필요한 실제 자료 프로필을 확인하고, 승인된 최소 읽기 표본으로 형식·이력·시점을 대조해야 합니다. 확인 전에는 [실자료 준비 대조](TOSS_DATA_CAPABILITY_AUDIT_20260914.md)의 보류를 유지하며 본 CLI를 실제 수집기/거래 엔진에 바로 연결하지 않습니다.
