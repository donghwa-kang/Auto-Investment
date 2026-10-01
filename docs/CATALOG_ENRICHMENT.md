# 오프라인 상품 정보 보강

2026-09-13. 시험용 종목 목록에 필드별 근거를 결합하고, 보강된 정보로 메타데이터 검토 후보·제외·확인 대기를 다시 판정하는 독립 CLI다. **실제 기업 조사, 외부 자료 수집, AI 추천, 매매 기능이 아니다.** 웹 화면이나 주문 엔진에 연결하지 않았다.

후속 연결: [다종목 통합 사전점검](MULTI_PREFLIGHT.md)은 이 검사기를 원본 시험 입력으로 다시 실행하고 시장 품질 검사와 명시적으로 연결한다. 이 개별 CLI의 실행법과 실제 자료/주문 비활성 경계는 유지한다.

## 빠른 실행

기존 의존성이 설치된 프로젝트 루트의 PowerShell에서 실행한다. 공통 환경·설치는 [README](../README.md)를 따른다. 추가 패키지·API 키·웹 서버가 필요하지 않다.

```powershell
npm run build:engine
npm run catalog:enrich -- fixtures/catalog-enrichment-v1.json
```

성공 시 `OFFLINE_CATALOG_ENRICHMENT_COMPLETE`, `purpose=TEST_ONLY`, 아래 집계 및 새 결과 파일 경로가 출력된다. `realMetadataReady=false`, `strategyEvaluated=false`, `ordersEnabled=false`를 유지한다. 제외나 확인 대기가 있다는 이유로 명령 실행이 실패하지는 않는다.

| 합성 샘플 결과 | 수 | 설명 |
| --- | ---: | --- |
| 검토 후보 | 2 | SOXL·SOXX라는 심볼을 사용한 시험 항목 |
| 제외 | 1 | 예탁금 3천만 원 단일종목 레버리지 시험 항목 |
| 확인 대기 | 2 | 예탁금 결측 / 출처 간 기초자산 분류 상충 |
| 보강한 필드 | 10 | 원본 null/UNKNOWN을 유효한 시험 근거로 채운 필드 |

[샘플](../fixtures/catalog-enrichment-v1.json)은 종목 5개·근거 12개·출처 3개다. 출처 ID, 거래소 `TEST-US`, 시각·예탁금·지원 여부와 문서 해시는 합성 값이다. 문서 해시의 0 반복은 실제 원문을 검증한 해시가 아니다. 샘플 분류를 실제 SOXL/SOXX 조사나 계좌 자격 확인으로 사용하지 않는다.

결과는 `data/catalog-enrichments/시각-UUID.json`에 매번 새로 저장한다. 입력·이전 결과·모의매매 DB·일회용 코드를 덮어쓰지 않는다. `items[].fields`에서 원본 값, 최종 값, 선택된 근거와 사유를 볼 수 있다. 자동 삭제/보관 기간 정책은 없다.

## 자료 계약

[실행 스키마](../src/core/catalog-enrichment-schema.ts)와 [보강기](../src/core/catalog-enrichment.ts)는 기존 [오프라인 카탈로그 계약](OFFLINE_CATALOG.md)과 공통 사실 분류기를 재사용한다. 추가 키를 거절하는 `OFFLINE_CATALOG_ENRICHMENT_V1` / `TEST_ONLY` 객체를 입력한다.

| 구성 | 계약 |
| --- | --- |
| `catalog` | 기존 `OFFLINE_CATALOG_V1` / `TEST_ONLY` 전체 입력. 여기의 `asOf`를 공통 판단 시점으로 사용 |
| `sources` | 최대 64개 시험 출처. `sourceId`, `purpose=TEST_ONLY`, `allowedFields`, 양의 안전 정수 `metadataMaxAgeMs` 필수. 출처 ID/허용 필드 중복 거절 |
| `evidence` | 최대 50,000개 필드 근거. 빈 배열 허용 |
| 근거 식별 | `evidenceId`, `sourceId`, `sourceDocumentId`, `sourceDocumentHash` 필수. 문서 해시는 소문자 64자리 16진수 형식 검사만 수행 |
| `subject` | `market`, `instrumentId`, `symbol`, `baseRecordHash` 필수. 시장+ID로 찾고 심볼·정규화한 원본 기록 해시도 일치해야 결합 |
| `field`, `value` | 아래 8개 필드 중 하나와 기존 카탈로그의 동일 타입 값. 숫자·불리언을 문자열로 대체 불가 |
| 시점·정정 | `revision`, `observedAt`, `receivedAt`, `availableAt`, `effectiveAt` 필수. 관측 ≤ 수신 ≤ 이용 가능. UTC 정규화, 밀리초보다 작은 정밀도 거절 |

보강 필드는 `venue`, `currency`, `kind`, `underlying`, `leveraged`, `requiredDepositKrw`, `listingStatus`, `brokerSupported`다. 종목 ID·시장·심볼·원본 시각은 근거로 변경하지 않는다. 통화나 상품 구조를 심볼 이름에서 추측하지 않는다.

`baseRecordHash`는 공용 `hash` 함수로 정규화된 해당 `CatalogRecord` 전체를 해시한 값이다. 심볼 해시나 파일 바이트 해시가 아니다. 원본 기록이 바뀌면 기존 근거의 결합을 다시 확인해야 한다. 실제 공급원 ID 매핑·재상장 계보·ISIN 외부 대조 기능은 없다.

출처의 허용 필드와 유효기간은 **시험에 입력한 가정**이다. ISSUER/BROKER라는 ID 이름 자체가 신뢰나 권한을 부여하지 않는다. 실제 출처 권한·유효기간을 이 값으로 확정하지 않는다. 문서 원문을 열거나 해시를 재계산하지 않으며 `sourceAuthentication=UNVERIFIED_TEST_INPUT`이다.

## 결합·보류 순서

1. 전체 입력 형식과 원본 카탈로그를 검증한다. 잘못된 미래 행도 형식 오류면 파일 전체를 거절한다.
2. `availableAt` 또는 `effectiveAt`이 `asOf` 이후인 근거는 판단에서 제외한다. 현재 원본에 없는 ID·다른 시장의 근거는 신규 종목을 만들거나 심볼만으로 합치지 않고 진단 개수에만 기록한다.
3. 현재 대상의 심볼/원본 기록 해시 불일치, 출처 미등록·필드 사용 범위 미등록은 해당 필드를 보류한다. 잘못 결합된 근거를 버리고 좋은 값만 남기는 방식은 사용하지 않는다.
4. 결합 검사를 통과한 출처+종목+필드별 가장 높은 현재 이용 가능한 revision을 사용한다. 출처 간 revision은 비교하지 않는다. 완전히 동일한 근거만 합치며 최신 동일 revision에 다른 내용이 있으면 보류한다. 문서/근거 식별자만 달라도 동일 기록이라고 가정하지 않는다.
5. 최신 근거가 만료되거나 null/UNKNOWN이면 이전의 좋은 근거나 원본 값으로 복원하지 않는다. 여러 출처의 값이 다르면 다수결·임의 우선순위 없이 보류한다. `asOf-observedAt`이 유효기간과 같으면 포함하고 초과하면 만료다.
6. 원본의 알려진 시험 값과 새 근거가 다르면 덮어쓰지 않고 최종 값을 null/UNKNOWN으로 둔다. 원본 값과 근거는 기록에 남긴다. 명시적인 원본 정정이 필요한 상황이다.
7. 원본의 만료·ID 상충·심볼 충돌은 일부 새 근거로 해제하지 않는다. 보강 후의 충돌도 검사하며 원본 최신 주장과 결합을 통과한 최신 상충 거래소 주장도 보존한다. null 자체를 실제 거래소 주장으로 묶지는 않는다. 미래·대체된 버전·식별/사용 범위 불일치 근거는 다른 종목의 충돌 근거로 추가하지 않는다.
8. 공통 사실 분류기로 다시 판정한다. 미해결 근거 문제나 원본 차단 사유가 있으면 확인 대기다. 검토 후보는 메타데이터 시험 통과일 뿐 거래 승인이 아니다.

원본의 동일 ID 자료가 충돌하면 해당 항목의 `facts=null`, `fields=[]`를 유지하며 어느 버전을 보강 대상으로 임의 선택하지 않는다. 이 경우 근거 상세는 입력과 입력 해시로 대조해야 한다.

## 결과·재현성

| 필드 상태 | 의미 |
| --- | --- |
| `BASE` | 별도 근거 없이 기존 TEST_ONLY 원본 값 유지. 실제 출처 검증이 아님 |
| `MISSING` | 원본도 불명확하고 현재 사용할 근거도 없음 |
| `ENRICHED` | 원본 결측을 근거 값으로 보강 |
| `CORROBORATED` | 근거가 원본 시험 값과 일치 |
| `BLOCKED` | 상충·만료·결합/출처 오류 등으로 최종 값을 불명확 처리 |

필드마다 `baseValue`, `value`, `reasons`, 선택된 `evidence`를 보존한다. 한국어 설명은 `reasonDescriptions`에 있다. 과거 정정·미래·대상 없는 근거 원문 전체를 결과에 복제하지는 않으며 입력은 별도 보존해야 한다.

`decisionHash`는 현재 판단·근거·원본 판단 해시·출처 계약·정책/연구 범위를 결합한다. `inputHash`는 정규화한 전체 입력의 감사 해시다. 유효한 미래 근거·대상 없는 근거·완전 중복·입력 순서 변경은 입력 해시나 진단 개수를 바꿀 수 있지만 현재 판단이 같으면 판단 해시는 같다. 출처 계약 변경은 판단 해시도 바꾼다. 해시는 외부 기관의 전자서명이나 진위 인증이 아니다.

3천만 원 이상 예탁금 단일종목 레버리지 제외와 지수형 레버리지 후보 구분은 기존 [사용자 연구 범위](../profiles/research-scope-v1.json)를 그대로 사용한다. 원본 위험 수치·전략·실거래 잠금은 변경하지 않았다. 실제 계좌 자격은 미확인이다.

## 실행·보안 경계

- `TRADING_MODE`는 미설정 시 PAPER이며 PAPER/BACKTEST만 허용한다. `LIVE_ENABLED=true`는 거절한다. `.env` 자동 로딩·외부 키 설정은 없다.
- 인자 1개만 받는다. 공용 로컬 읽기 경로로 최대 16 MiB, UTF-8/BOM을 처리하고 직접 URL/UNC/장치 경로를 거절한다. 최대 행 수는 투자·감시 목록 한도가 아니라 자원 상한이다.
- 제외/대기는 종료 코드 0일 수 있다. 모드·인자·원본 정책·입력/파일·저장 오류는 종료 코드 1이며 원문 오류·입력 비밀값·키 경로를 로그에 복사하지 않는다.
- [CLI](../src/server/catalog-enrich-cli.ts)는 키·시세·계좌·주문·사용자 DB 모듈을 가져오지 않는다. 실제 토스 스냅샷이나 캐시를 이 TEST_ONLY 입력으로 자동 변환하지 않는다.
- Windows ACL/연결 지점/네트워크 드라이브 전수 차단, 디스크 고장·전원 차단 내구성·암호화·백업 복원은 미검증이다. 신뢰하는 로컬 시험 파일만 사용한다. `0600` 지정은 Windows ACL 보장이 아니다.

## 검증과 다음 단계

```powershell
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/catalog-enrichment.test.js dist/runtime/tests/catalog-enrich-cli.test.js
node work/verify-catalog-enrichment.mjs
```

마지막 명령은 타입·린트·형식·엔진/웹 빌드·원본 보존·관련 기존 검사·샘플 CLI 실행을 수행하고 검증 기록 (로컬 비공개 기록: `work/catalog-enrichment-verification`)에 검사마다 결과를 저장한다. 전체 제품 검사나 웹 E2E는 아니다. 기존 종료/로그인 코드 생성 시험은 사용자 실험에 영향을 주지 않도록 제외했다. 의존성 변경은 없으며 새 설치는 이번에 재현하지 않았다.

2026-09-13 최종 실행에서는 신규 32개와 기존 관련 155개, 총 **187/187 통과**(실패·건너뜀 0), 타입·린트·형식·엔진/웹 빌드 성공, 보존 대상 원본 37/37 일치를 확인했다. 실제 자식 CLI 시험과 별도 샘플 실행의 집계도 위 표와 일치했다. 명령·종료 코드·출력은 최종 실행 보고서 (로컬 비공개 기록: `work/catalog-enrichment-verification/report.json`)에 있다. 개발 중 추가 검사로 발견한 출처 순서 의존·거래소 충돌 누락·null 거래소의 과잉 충돌 처리를 수정했으며 중간 실패 기록은 같은 폴더에 별도 보존했다.

실제 출처·자료 권리/비용·상품 정보의 사실 확인, 실제 수신과의 결합, 뉴스·가격 이력·유동성·선정식, 전략·체결·성과 검증은 남아 있다. 이 기능만으로 전체 시장 자동매매가 완성되거나 실거래로 전환되지는 않는다.
