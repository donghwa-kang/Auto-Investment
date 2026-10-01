# 공급원 후보와 권리 확인 원장

_실자료 연동 계약 v1 · 2026-09-17 공개 문서 조회 기준 · 실행 승인 아님_

2026-09-21 후속: [키움 전환·공급원 결정 기록](KIWOOM_SOURCE_PLAN.md)에 신규 우선 후보와 최신 확인 근거를 별도로 연결했다. 아래 S-001–S-015와 `sources.json`은 당시 기록으로 유지한다. 키움 기능·저장/비용·필수 주문 검증은 새 기록을 함께 보며, 후보 변경으로 기존 HOLD를 해제하지 않는다.

---

## 📋 범위와 읽는 방법

이 원장은 국내·미국 주식/ETF의 시세·공시·상품 자료 공급원을 검토하기 위한 명세다. **문서에 기능이 있음**, **이 용도로 사용할 권리가 확인됨**, **실제 자료가 검증됨**은 서로 다르다. 현재 모든 신규 수집·보관·AI 전송·학습의 운영 승인은 `HOLD`다. 기존 승인 범위나 합성 앱을 이 문서가 변경하지 않는다.

공개 문서·명세·약관 화면만 확인했다. 인증·가입·키/계좌 조회·시세/공시 API 호출·첨부 데이터 다운로드·거래는 하지 않았다. 법적 이용 허가, 무료 이용, 품질이나 수익을 보장하는 문서가 아니다.

- [계약 개요](README.md): 전체 범위와 필드 요구사항
- [수용검증 계획](ACCEPTANCE_PLAN.md): 자료·시점·품질의 검증 조건
- [운영비 연결 명세](OPERATING_COST_SPEC.md): 비용 계산과 코드 차이의 후속 수정 조건
- [기계 판독 출처 원장](sources.json): 15개 출처의 URL·날짜 종류·주장·한계

`CONFIRMED`는 문서 사실, `CONDITIONAL`은 명시된 조건의 검토 필요, `RESTRICTED`는 관련 제한 조항 확인, `UNKNOWN`은 이번 출처에서 미확인이다. `UNKNOWN`을 금지·부재 또는 허용으로 바꾸지 않는다. 아래 권리 판단은 확인 절차를 위한 분류이며 법률 해석의 확정이 아니다.

## 🌐 공급 범위와 시점

| 후보 | 확인된 범위 | 과거·정정·시점 한계 | 근거 |
| --- | --- | --- | --- |
| 토스 REST | 시세·봉·종목·달력·참고 FX·KR 수급 | 전용 뉴스/공시/actions 경로 미확인; 전체 제품 부재 뜻 아님 | S-001[^S-001] |
| DART 검색·원문 | 회사/종목·접수번호·보고서·정정/철회 표시·ZIP 원문 | 접수일은 날짜뿐; 당시 장중 가용시각/vintage 미확인 | S-004~005[^S-004][^S-005] |
| SEC EDGAR | CIK별 제출 이력·추가 과거 파일·XBRL | 시세 피드 아님; 현재 집계가 당시 vintage는 아님 | S-007~008[^S-007][^S-008] |
| KRX Open API | 주식/ETF/지수 일별 자료·종목 기본정보 | 서비스별 시작일 상이; 분봉/실시간·PIT 모집단 미확인 | S-009[^S-009] |
| KRX 별도 시세 분배 | 실시간/지연시세 수신 안내 | 공개 API와 별도 계약·수신 조건 | S-011[^S-011] |
| KIND | 거래정지/해제·경고/위험 등 시장조치 검색 | 자동수집 규격·SLA·과거 완전성 미확인 | S-012[^S-012] |
| Direxion SOXL | 일일 목표·구조·보수·지수/펀드 보유 링크 | 지수 구성과 펀드 보유 구별; 항목별 기준일 상이 | S-013[^S-013] |
| iShares SOXX | 상품/구성·보수·평가 자료·CSV 링크 | 구성 변경·벤더/평가가격 차이; 과거 보유 vintage 미확인 | S-014[^S-014] |

DART의 `rcept_dt`는 `YYYYMMDD`다. 정정보고서를 포함하는 조회와 비고의 정정·철회 표시를 사용할 수 있지만, 이를 최초 공개 시각이나 완전한 정정 연결키로 취급하지 않는다. SEC는 접수 후 삭제·정정을 허용하며 과거 daily 색인과 주간 재작성 색인의 반영 방식도 다르다.[^S-004][^S-008]

설계 요구: 원천 사건일, 발표시각과 그 정밀도, 공급자 기준시각, 실제 이용가능시각의 증거, 로컬 수신시각, 정정 유효시각을 구별한다. 날짜만 있으면 시간은 `UNKNOWN`으로 둔다. 지금 받은 과거 자료를 당시에 이미 받았다고 소급하지 않는다. 원문 버전·해시 보관도 아래 권리 확인을 먼저 거친다.

## 🔐 목적별 권리 매트릭스

### 수신과 보관

열의 `실시간`·`과거`는 기술적 존재가 아니라 **우리 용도에 대한 권리 확인 상태**다. 기능이 없는 것으로 읽지 않는다. 확인된 일반 조건이 있어도 사용자별 승인·요금·보관 범위가 남으면 수집을 시작하지 않는다.

| 후보 | 실시간 수신 | 과거 자료 수신 | 로컬 보관 | 근거 |
| --- | --- | --- | --- | --- |
| 토스 | CONDITIONAL | CONDITIONAL | UNKNOWN | S-001~003[^S-001][^S-002][^S-003] |
| DART | CONDITIONAL | CONDITIONAL | UNKNOWN | S-004~006[^S-004][^S-005][^S-006] |
| SEC | CONDITIONAL | CONDITIONAL | CONDITIONAL | S-007~008[^S-007][^S-008] |
| KRX Open API | UNKNOWN | CONDITIONAL | RESTRICTED | S-009~010[^S-009][^S-010] |
| KRX 시세 분배 | CONDITIONAL | UNKNOWN | UNKNOWN | S-011[^S-011] |
| KIND | UNKNOWN | UNKNOWN | UNKNOWN | S-012[^S-012] |
| Direxion / iShares | UNKNOWN | UNKNOWN | UNKNOWN | S-013~014[^S-013][^S-014] |

SEC의 `CONDITIONAL`은 필요한 파일 다운로드·보관을 전제로 한 접근 안내가 있다는 뜻일 뿐 무제한 보관·삭제된 민감정보 유지 허가가 아니다. DART의 원문 다운로드 규격 역시 보관 기간 전체를 정하지 않는다. 토스 약관의 회사 측 10년 보관을 사용자 무제한 보관 허가로 바꾸지 않는다.[^S-002][^S-005][^S-008]

### AI 전달·재배포·학습

| 후보 | 외부 AI 전송 | 제3자 재배포 | 모델 학습 | 판단 근거 |
| --- | --- | --- | --- | --- |
| 토스 | UNKNOWN | RESTRICTED | UNKNOWN | 목적·제3자 제공 제한[^S-002] |
| DART | UNKNOWN | UNKNOWN | UNKNOWN | 비용과 저작권 조항 분리[^S-006] |
| SEC | UNKNOWN | UNKNOWN | UNKNOWN | 접근 안내는 포괄 이용권 아님[^S-007][^S-008] |
| KRX Open API | RESTRICTED | RESTRICTED | UNKNOWN | 제3자 제공·종료 후 이용 제한[^S-010] |
| KRX 시세 분배 | UNKNOWN | CONDITIONAL | UNKNOWN | 용도별 별도 계약 문의[^S-011] |
| KIND | UNKNOWN | UNKNOWN | UNKNOWN | 검색 UI만 확인[^S-012] |
| Direxion / iShares | UNKNOWN | UNKNOWN | UNKNOWN | 상품자료만 확인[^S-013][^S-014] |

`RESTRICTED`는 해당 이용에 관련된 제한이 있다는 뜻이며 공급자의 별도 계약 가능성까지 부정하지 않는다. 외부 AI 전송은 재배포 허가와 별개로 대상 자료·목적·수신자·보관/학습 옵션을 확인한다. 토스의 AI 활용 소개만으로 모든 데이터 전송권이 확인되는 것은 아니다.[^S-003] 로컬 모델 학습과 외부 서비스 전송도 서로 다른 목적이다.

## 💰 비용과 요청 정책

| 후보 | 문서에서 확인한 비용/제한 | 아직 확인할 사항 | 근거 |
| --- | --- | --- | --- |
| 토스 | 체결 수수료·시장별 세금/제비용·FX 별도; 한도 하향 가능 | 별도 API 조회요금·현재 허용량·사용자 적용 조건 | S-002~003[^S-002][^S-003] |
| DART | 원칙 무료이나 일부 유료 가능; 호출량 변경/접속 제한 | 실제 키 한도·기간 경계·현재 고지 | S-005~006[^S-005][^S-006] |
| SEC | 10요청/초 안내·User-Agent·효율적 요청 | 변경 정책·우리 호출 예산·포괄 재이용권 | S-008[^S-008] |
| KRX Open API | 1키/일 10,000회 이하·이용 1년 및 연장 | 요금·보관 종료 처리·개인 용도 적격성 | S-010[^S-010] |
| KRX 시세 분배 | 수신업체 정책상 유료 가능·별도 계약 | 계약 견적·수신/저장/전송 범위 | S-011[^S-011] |
| KIND·운용사 | 이번 페이지에 데이터 요금/호출 규정 미확인 | 자동수집 방식·비용·허용 빈도 | S-012~014[^S-012][^S-013][^S-014] |

DART의 오류 안내에 있는 “일반적으로 20,000건”을 확정 일일 예산으로 쓰지 않는다.[^S-005] 문서 최대량은 권장 수집량이 아니다. 향후 수집기는 승인된 더 작은 예산·캐시·재시도 상한을 두고 정책 변경이나 제한 응답을 보존해야 한다. 펀드 보수율은 데이터 이용료가 아니며 거래비·FX·운영비의 인식은 [별도 명세](OPERATING_COST_SPEC.md)에서 다룬다.

## ⚠️ 미결정 사항과 해제 증거

아래 `소유자`는 **후속 확인 책임 역할**이지 공급원에 문의를 보냈거나 담당자가 확정됐다는 뜻이 아니다. 현재 모두 `HOLD`다. 해제는 해당 작업 범위에만 적용하며 실주문 승인이나 기존 정책 문턱 변경을 포함하지 않는다.

| ID | 결정할 범위 | 확인 책임 역할 | 해제에 필요한 증거 |
| --- | --- | --- | --- |
| U01 | 토스 개인 조회·저장·요금·AI 용도 | 사용자: 실제 이용 조건 확인; 개발 담당: 범위 대조 | 적용 약관/공급자 답변과 사용 목적·보관 기간·요금·호출 예산의 사용자 승인 |
| U02 | DART·SEC 공시 수신·원문 이용 | 사용자: 용도 확인; 개발 담당: 접근 정책·형식 검증 | 제한 수집에 필요한 접근·원문 보관 권리/비용·대상·호출 예산 승인; 수집 후 날짜 정밀도·정정 연결 수용은 U05 |
| U03 | KRX 공개 API와 별도 분배 계약 | 사용자: 해당 계약 확인; 개발 담당: 분리 구현 | 개인 분석 적격성·비상업 범위·제3자 제공/종료 후 처리·표시·요금의 근거 |
| U04 | KIND·운용사 수집·역사 자료 | 사용자: 사용 범위 확인; 개발 담당: 후보 평가 | 허용 수집 방식·빈도·보관/AI 범위와 과거 구성·정정 가용성; 불가능하면 미지원 유지 |
| U05 | 실자료 품질·현실 프로필 | 개발 담당: 검사; 사용자: 수용 범위 승인 | 원천/종목/시각/정정/달력 대조와 실제·합성 분리, 부재 시 보류 결과; 상세는 수용검증 계획 |
| U06 | 테마·후보 선정·모델 입력 | 개발 담당: 추적·검증; 사용자: 연구 범위 승인 | 자료 권리·특징 출처·후보 탈락 이력·모델 유효기간·자동 승격 금지; 투자 검증은 별도 |
| U07 | 운영비 정의와 경제성 연결 | 개발 담당: 명세/시험; 사용자: 예산 확인 | 완료 위험일·0이 아닌 비용·무거래일·이중 차감 방지의 시험 및 비용 명세 수용 |

U01~U04의 자료 권리는 공급자 문서·답변 등 외부 근거가 필요하다. 개발자가 임의로 `UNKNOWN`을 `CONFIRMED`로 바꾸거나 사용자의 일반적인 “진행”만으로 공급자의 이용권을 생성하지 않는다. U05~U07은 구현/수용 조건도 필요하다. 어떤 하나의 해제로 모든 수집·AI·거래 기능을 한꺼번에 열지 않는다.

해제는 목적과 단계로 나눈다. **G1 제한 수집 승인**은 그 수집·보관에 필요한 권리/비용·접근 조건·대상/기간·호출 예산·사용자 승인을 확인하는 단계다. 아직 수집하지 않은 실자료의 수용 결과를 G1의 조건으로 요구하지 않는다. **G2 자료 수용**은 G1 범위에서 받은 자료의 형식·시점·정정·coverage를 U05 시험으로 확인하는 단계다. AI 전송·학습·재배포는 각각 별도 용도이며 사용하지 않는 용도의 권리 미확인은 로컬 제한 수집의 선결조건이 아니다. 현재는 G1/G2와 별도 용도 모두 미승인이다.

## 🔍 기록·정정과 검증 한계

[sources.json](sources.json)의 `publication_date`는 `date_kind`와 함께 읽는다. 시행일·마지막 검토일·논문 버전일은 최초 발행일과 다르다. 날짜가 없으면 `not-stated`로 남기고 검색엔진 수집일이나 표의 가격 기준일로 대체하지 않는다.

이번 SEC API 본문에서 마지막 검토/수정일은 **2025-04-08**로 관측했다.[^S-007] [이전 투자 감사](../INVESTMENT_CAPABILITY_REVIEW_20260917.md)에 기록된 날짜와 다른 관측이며, 그 문서를 조용히 덮어쓰지 않는다. KRX 약관의 2025-12-26과 DART 약관의 2020-01-21은 각각 **시행일**이다.[^S-010][^S-006]

이 파일은 공개 안내의 주장 원장이지 실제 데이터 적격성 증명서가 아니다. 원장 형식·참조 검사는 외부 권리·정확성·수익성을 자동 인증하지 않는다. 실제 표본·다운로드 파일·서버 지연·최신성·누락률·계좌별 비용은 미검증이며 [수용검증 계획](ACCEPTANCE_PLAN.md)에서 후속 확인한다.

## 📚 출처와 방법론

시장조사 스킬의 출처/주장 분리, 불확실성·권리·시점 기록 절차를 적용했다. 방법론 귀속은 Kassis 외의 *Scientific Agent Skills* v2이며 투자 성능이나 데이터 이용권의 근거가 아니다.[^S-015] 아래 15개 항목은 모두 2026-09-17 조회했다. 요약·링크만 기록하며 원문 전체나 데이터 첨부파일을 복제하지 않았다.

[^S-001]: 토스증권, [REST OpenAPI 명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json). 조회 버전 1.2.17; 발행일 not-stated.
[^S-002]: 토스증권, [Open API 서비스 이용약관](https://corp.tossinvest.com/ko/terms/v2?id=752). 선택한 개정·시행본 2026-08-12; 제5·10·11·13조.
[^S-003]: 토스증권, [Open API 소개·FAQ·투자자 유의사항](https://corp.tossinvest.com/ko/open-api). 발행일 not-stated.
[^S-004]: 금융감독원, [OpenDART 공시검색](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019001). 발행일 not-stated.
[^S-005]: 금융감독원, [OpenDART 공시서류원본파일](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019003). 발행일 not-stated.
[^S-006]: 금융감독원, [OpenDART 이용약관](https://opendart.fss.or.kr/intro/terms.do). 시행 2020-01-21; 발행·수정일 not-stated.
[^S-007]: SEC, [EDGAR Application Programming Interfaces](https://www.sec.gov/search-filings/edgar-application-programming-interfaces). 마지막 검토/수정 2025-04-08.
[^S-008]: SEC, [Accessing EDGAR Data](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data). 마지막 검토/수정 2024-06-26.
[^S-009]: 한국거래소, [KRX Open API 서비스 목록](https://openapi.krx.co.kr/contents/OPP/INFO/service/OPPINFO004.cmd). 발행일 not-stated.
[^S-010]: 한국거래소, [KRX Open API 국문 이용약관](https://openapi.krx.co.kr/contents/OPP/INFO/OPPINFO002.jsp). 시행 2025-12-26; 발행·수정일 not-stated.
[^S-011]: 한국거래소, [데이터 수신방법](https://openapi.krx.co.kr/contents/OPP/DATA/OPPDATA003.jsp). 발행일 not-stated.
[^S-012]: 한국거래소, [KIND 공시 상세검색](https://kind.krx.co.kr/disclosure/details.do?method=searchDetailsMain). 발행일 not-stated.
[^S-013]: Direxion, [Daily Semiconductor Bull and Bear 3X ETFs](https://www.direxion.com/product/daily-semiconductor-bull-bear-3x-etfs). 페이지 발행일 not-stated; 항목별 기준일 상이.
[^S-014]: iShares / BlackRock, [Semiconductor ETF (SOXX)](https://www.ishares.com/us/products/239705/ishares-phlx-semiconductor-etf). 페이지 발행일 not-stated; 항목별 기준일 상이.
[^S-015]: Timothy Kassis, Vinayak Agarwal, Yuhuan He, Darshil Patel, Aubrey M. Brueckner (2026), [Scientific Agent Skills: A Library of Procedural Knowledge for Research Agents](https://arxiv.org/abs/2609.00065). v2 2026-09-02; 방법론 귀속.
