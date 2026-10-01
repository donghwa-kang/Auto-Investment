# 1차 정책 대응표

원본 거래 기준을 변경하지 않았다. 현재 실행 상태/시험 가정은 별도 런타임과 `profiles/synthetic-v1.json`에 있다. 아래 ‘구현/시험’은 합성 입력에서 해당 코드 경로를 검사했다는 뜻이며 실제 거래 성과·계좌 자격 증빙이 아니다. 최종 실행 여부는 검증 로그 (로컬 비공개 기록: `work/phase1-verification/report.json`)와 대조한다.

| 요구 ID / 원본 | 구현 | 실행 시험 | 범위·미확정 |
| --- | --- | --- | --- |
| BASE: 구현 프롬프트 2~5절 | policy.ts / 원본 SHA-256 / 별도 프로필 | POLICY-01, verify:originals | 원본 null/미검증 유지, LIVE 어댑터 없음 |
| INPUT: capital, risk_level_contract | configSchema / 서버 재검사 | INPUT-01/02 | 500만 이하 정수, 미선택·알 수 없는 값 거절 |
| MODE: mode_contract, security | Engine 시작/명령 경계 | MODE-01/02, NETWORK-01 | 실계좌/AI 없음. OS 네트워크 격리 제품은 아님 |
| RISK: risk, 가이드 18·29절 | ledger.ts / risk.ts | RISK-01/02, DD-01/02, LEVEL-01 | 36개 자금/단계/수준/낙폭 조합; 하나의 보수적 위험군 |
| SIZE: 가이드 8·9절 | size / costFor / economic | SIZE-01/02, E2E-CORE-01, SUBMIT-01 | 정수 수량·현금·금액·잔여 위험·경제성 동시 검사; 실제 비용 미정 |
| FX/장부: ledger, 17~19절 | 통화별 현금/미결제/비용/NAV | LEDGER-01, COST-01/02, DD-01 | 입출금·배당 등 일부 보조 기능은 도메인 시험용, UI 자금 재초기화 없음 |
| DATA: shared_strategy/input_contract | strategy.ts asOfBars/aggregate | DATA-01/02, PIT-01, CA-01 | 완료 1분봉·수신/정정·분할 시점, 실제 공급 연결 없음 |
| B/P: 공유 명세 1.0 | 동일 indicators/evaluateFeatures | IND-01, SIGNAL-01~04, E2E-CORE-01/03 | ATR/EMA/VWAP/RVOL/ORH/백분위, 기준 외 지표 비활성 |
| CAL: risk_calendar, execution, exit_policy | calendar.ts / events.ts | CAL-01/02, EVENT-01 | 서울 위험일과 거래소 시간 분리, 합성 휴장/조기 종료 |
| SNAP: decision_snapshot v3 | bindSnapshot / submissionReasons / 명령 의도 | SNAP-01, SUBMIT-01/02, COMMAND-03 | 모든 필수 바인딩·접수 직전 변조/기한 재검사, 분할 진행 중 재시도에서도 최초 명령 보존 |
| AI: economic_gate/counter_review | MissingForecast/SyntheticForecast | AI-01, E2E-CORE-02 | 기본 보류, TEST_ONLY 수치 분포는 예측 성능 아님, OFF 유지 |
| THEME: 테마 1.3 및 2026-09-11 사용자 범위 정정 | providers.ts / research-scope.ts / 테마 화면 | THEME-01, SCOPE-01~03, UI-01 | SOXL 검증 후보 포함과 실거래 자격 UNVERIFIED 분리. 원본은 보존하며 실제 시세·주문은 미연결 |
| ORDER: execution, 20~21절 | simulator.ts, Repository | ORDER-01~04, STOP-01 | 접수/체결/취소 확정 분리. UNKNOWN은 증거 없이 해소 불가 |
| EXIT: exit_policy, 20절 | 귀속 수량·지정가/보호·시간 관리 | EXIT-01~03, EVENT-01 | 전체 계좌 청산/시장가 대체 없음; 실제 청산 프로필 미정 |
| OWNER: fencing, reservation | SQLite BEGIN IMMEDIATE / writer epoch | WRITER-01, ORDER-01, RESERVE-02 | 복수 연결 소유권·동일 의도 중복 검사. 실제 결정 함수를 두 독립 후보로 호출하여 두 번째 과다 예약 거절 확인; 앱의 다종목 scanner 구현·대규모 시험은 아님 |
| RECOVERY: 21.3절 | 저장 상태 대조 / 감사 해시 체인 | RECOVERY-01, CRASH-01 | 별도 자식 프로세스 강제 종료를 의도/접수/부분체결 단계에서 수행 |
| FAULT: 구현 프롬프트 11·15절 | 실패 롤백·runtime 차단 | STORAGE-01/02, FAULT-01 | 실제 SQLite lock, 가상 disk-full 예외; 실제 디스크 가득 채움/전원 차단은 미검증 |
| CA: price_data/21.1절 | events.ts / PIT split | CA-LEDGER-01/02, CA-01 | 분할·배당·원천차감·중복 인식; 복잡 기업행동은 대조 차단 |
| WEB: security/구현 15절 | HTTP 세션/Origin/Host/CSRF/크기 제한 | SEC-HTTP-01, SHUTDOWN-01, UI-01/02 | 실제 CLI 자식 프로세스에서 인증 종료·정상 저장·종료 코드 0 확인. 파일 ACL·관리자 위협·다중 사용자 미검증 |
| REPLAY: shared_strategy_contract | 기록된 fixture 출력·정규 해시 | REPLAY-01, PIT-01 | 실제 LLM 재호출 없음, 거래결정/장부/주문 결과 비교 |
| UI: 구현 6·12·14절 | React 5개 화면 | UI-01/02 + 화면 PNG 확인 | 입력→주문/보류→중지→청산→새로고침, 연결 끊김·모바일 확인 |

## 시험 전용 가정

40자리 decimal HALF_EVEN, 합성 호가 KR 1원/US 0.01달러, KRW/USD 1300, 외화 현금 스트레스 100bp, 진입/청산 수수료 각 1bp, 추가 예상 청산 불리함 2bp, 운영비 0원이라는 **명시적 합성 가정**을 사용한다. 실제 비용을 확인하고 0원으로 결정한 것이 아니다. 예측 gross 0.7R/q05 -1.2R도 테스트 입력이다. 모의 지정가 청산 복구 범위 100bp, 최대 대체 2회, 다음 합성 tick 결제는 실제 증권사 계약이 아니다.

기본 세션에는 알려진 합성 무뉴스/빈 이벤트 달력을 선언하고, 이벤트·분할·배당은 별도 함수 시험에서 주입한다. 초기 신호 이후의 합성 호가 경로를 원천 1분봉 범위에도 반영한다. 데이터 생성은 고정된 결정론적 규칙이며 seed는 실험 식별용 고정값이다.

## 후속 작업 (이번 외부 작업 승인 아님)

다종목 시점별 모집단·정렬/선정 성과·실제 상관/ETF 중복, 자료 권리·가격·기업행동 공급 계약, 지출/예측/보정/실체결/청산 프로필, 지연 비용·실시간 정방향 모의, 검증된 위험도별 성과, 감사 보관/암호화/백업, 계좌별 실제 자격을 먼저 확정해야 한다. 테마 연구·AI 의견·합성 시험이 이 조건을 우회하지 않는다.
