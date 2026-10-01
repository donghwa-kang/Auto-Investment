# Markdown 파일명 검토와 변경 대조표

_2026-09-29 · 문서 탐색성 정리 · 제품 기능·거래 정책 변경 없음_

---

## 📋 판단과 범위

루트의 README/PROGRESS, `docs/`, `outputs/`에 있는 Markdown 93개를 제목·주요 절과 대조했다. 이름 변경 후보10개는 본문까지 확인했다. 대부분의 이름은 내용을 설명하지만, 일부는 공급원·모형 여부·준비 단계 또는 계산과 저장의 차이를 드러내지 못한다. 해당10개만 같은 폴더 안에서 이름을 구체화했다. 전체 금융 명세의 정확성을 새로 감사하거나 과거 검증을 다시 실행한 작업은 아니다.

기존 대문자·밑줄 관례를 유지한다. 모든 문서에 단계 번호를 붙이거나 한글 이름으로 바꾸지 않는다. 기존 이름으로도 내용이 분명하거나 코드 모듈과의 대응에 도움이 되는 이름은 그대로 둔다. 아래 표의 새 이름은 현재 파일로 연결된다.

## 🔍 이전 이름과 새 이름

아래 파일은 `docs/`에 있으며, 마지막 두 파일만 `docs/investment-data-contract-v1/`에 있다.

| 이전 이름 | 새 이름 | 변경 이유 |
| --- | --- | --- |
| `SOURCE_INGEST.md` | [TOSS_OFFLINE_INGEST.md](TOSS_OFFLINE_INGEST.md) | 모든 공급원용 수집기가 아니라 토스 REST 모의 응답 변환기다. 키움 문서와 구별한다. |
| `REAL_DATA_CAPABILITY_AUDIT.md` | [TOSS_DATA_CAPABILITY_AUDIT_20260914.md](TOSS_DATA_CAPABILITY_AUDIT_20260914.md) | 전체 공급원에 대한 최신 감사가 아니라 토스 명세·구현을 대조한 당시 기록이다. |
| `EXECUTION_EVIDENCE.md` | [EXECUTION_CALIBRATION_DIAGNOSTIC.md](EXECUTION_CALIBRATION_DIAGNOSTIC.md) | 실제 체결 증명이나 보정 완료가 아닌 모의 호가 진단·보정 준비 자료다. |
| `ANALYSIS_ISOLATION.md` | [ANALYSIS_ISOLATION_READINESS.md](ANALYSIS_ISOLATION_READINESS.md) | 실제 OS 격리 적용이 아니라 읽기 전용 환경 조사와 준비도 진단이다. |
| `ANALYSIS_PROCESS.md` | [ANALYSIS_MOCK_PROCESS.md](ANALYSIS_MOCK_PROCESS.md) | 실제 AI가 아니라 고정 모형을 별도 프로세스로 실행한다. |
| `ANALYSIS_PROVISION.md` | [ANALYSIS_PERMISSION_PREPARATION.md](ANALYSIS_PERMISSION_PREPARATION.md) | 일반 자원 배포가 아니라 격리 권한 검토 명세·메모리 검사·복구 판단이다. |
| `COST_OPERATING_CLOSE.md` | [COST_OPERATING_CLOSE_REPORT.md](COST_OPERATING_CLOSE_REPORT.md) | D7은 읽기 전용 마감 계산·보고이며 D8의 원자 마감 저장과 다르다. |
| `COST_OPERATING_REPORT_CONTRACT.md` | [COST_OPERATING_REPORT_AND_REPLAY.md](COST_OPERATING_REPORT_AND_REPLAY.md) | 현재 API 사용법·예제·DB 독립 재생과 과거 설계 계약을 함께 담는다. |
| `OPERATING_COST_STAGE1.md` | [OPERATING_COST_ESTIMATION_STAGE1.md](investment-data-contract-v1/OPERATING_COST_ESTIMATION_STAGE1.md) | 단계 번호에 후보 운영비 추정·경제성 연결이라는 역할을 더했다. |
| `OPERATING_COST_STAGE2.md` | [OPERATING_COST_SUBLEDGER_ALLOCATION_STAGE2.md](investment-data-contract-v1/OPERATING_COST_SUBLEDGER_ALLOCATION_STAGE2.md) | 단계 번호에 별도 보조장부·보고 배분이라는 역할을 더했다. |

이름과 본문 첫 제목을 맞췄으며 본문의 금융 규칙·지원 범위·과거 결과는 바꾸지 않았다. `PROGRESS.md`는 통상적인 파일명을 유지하고, 첫 제목만 ETF 기준 명세에서 현재 범위인 **AI 자동매매 개발·검증 진행 기록**으로 수정했다.

## 📚 유지한 이름과 이유

| 문서군 | 판단 |
| --- | --- |
| [README](../README.md), [PROGRESS · 공개 요약](PROJECT_STATUS.md) | 실행 안내·진행 기록의 표준 진입점이므로 유지한다. |
| [개발 실행 가이드](DEVELOPMENT_EXECUTION_GUIDE_v1.md), [D03 인수 지도](D03_INTEGRATION_ACCEPTANCE.md) | 실행 지침과 해당 단계 인수 조건이라는 내용에 맞는다. 기존 버전·단계 의미를 유지한다. |
| `COST_*`, `KIWOOM_*`, `CATALOG_*`, `LEARNING_*`의 나머지 안내 | 비용·공급원·종목 목록·학습 기능 및 코드와의 대응이 충분히 명확하다. 모든 이름을 길게 늘리지 않는다. |
| `*_PLAN`, `*_CONTRACT`, `*_REVIEW_날짜` | 계획·계약·시점별 검토라는 문서 역할을 설명한다. 과거 기록을 최신 구현으로 바꾸지 않는다. |
| `outputs/`의 정책·가이드·개정 검토13개 | 원본 버전과 내용이 대응하며 고정 해시 검증 대상이다. 파일명·내용·검증 기준을 보존한다. |

## 🔗 참조와 과거 자료의 경계

현재 README/PROGRESS와 `docs/`의 링크·명시 파일 경로를 새 이름으로 갱신했다. `src/`, `tests/`, `scripts/`의 코드·시험·실행 파일명, npm 명령과 데이터 형식은 바꾸지 않는다. 파일을 다른 폴더로 옮기지 않았으므로 본문의 소스·시험 자료 상대 경로도 유지된다.

`work/`의 과거 검사기·사본·해시·로그와 `graphify-out/`의 자동 생성물은 수정하지 않았다. 일부 과거 검사기는 당시 문서 이름과 해시에 고정돼 있으므로 현재 상태의 인수 검사기로 그대로 재실행할 수 있다고 보장하지 않는다. 그 기록을 맞추려고 과거 기준 해시를 갱신하거나 성공 결과를 새로 만들지 않았다. 현재 명명 변경의 검사기는 `work/document-names/audit.mjs`다.

과거 대화·외부 제미나이 첨부·사용자 북마크의 경로는 자동으로 바뀌지 않는다. 예전 이름은 위 표로 찾는다. 내용이 같은 사본이나 이전 이름의 별칭 파일을 추가하지 않아, 수정해야 할 원본 문서는 하나로 유지한다.

## ✅ 검사와 남은 작업

이번 점검은 다음 범위로 한정한다. 실행 결과는 [최신 진행 기록 · 공개 요약](PROJECT_STATUS.md)과 `work/document-names/result.json`에서 구분한다.

- 수정 전529파일 기준으로 문서 이름·첫 제목·파일명 참조 외 변경이 없는지 대조한다. README 안내 한 문단과 이번 PROGRESS 기록은 별도 추가분이다.
- 로컬 Markdown 파일 링크와 변경된 문서의 앵커, 옛 이름의 현재 문서 참조 누락을 검사한다. 외부 웹 URL의 최신성·접속 가능성은 이번에 재검증하지 않는다.
- 제품 소스·시험·설정·자동 생성물 보존과 `npm run verify:originals`의 원본37개를 확인한다.
- 기존 실행 가이드40개 체크 항목·PROGRESS 미완료9개를 보존한다. 문서 정리 진행률은 거래 개발 진행률에 합산하지 않는다.
- 새 대조표와 변경된 첫 제목을 로컬 Markdown 미리보기에서 확인한다. 실제 앱·GitHub·Codex 렌더러나 스크린리더 검증과는 구분한다.

파일명 정리는 신규 기능 구현·실제 API/계좌/AI 연결을 승인하지 않는다. 거래 개발의 다음 작업은 기존 **DEV-D03-S9-A** 그대로다.
