# 분석 연결 전 스키마 대조·더미 파일 검사

설치된 Codex의 명세를 로컬에서 추출·대조하고, 새 더미 파일을 검사하는 **개발용 자기검사 도구**를 제공합니다. 실제 Codex 분석 연결이나 OS 격리 시험이 아닙니다. 거래 엔진·원본 기준·기존 서버/장부와 연결하지 않습니다.

## 바로 실행하기

프로젝트 루트, 기존 [Windows/Node 설치 조건](../README.md#실행-환경)을 사용합니다. 이 CLI는 Windows + Node `24.20.0`만 받습니다. 추가 설치·키·로그인·서버가 필요 없고 기존 `work/` 폴더가 있어야 합니다.

```powershell
npm run build:engine
node dist/runtime/src/server/analysis-dummy-cli.js
```

새 `work/analysis-dummy-lab/lab-.../`에 더미 파일 3개, manifest, 검사 결과 `self-test.json`을 남깁니다. 매번 새 폴더를 만들며 기존 결과를 덮어쓰거나 삭제하지 않습니다. 사용자가 지정한 파일 경로나 명령 인자는 받지 않습니다. `--execute` 등 추가 인자는 실행 전에 거절합니다. 웹 화면 기능이 아닙니다.

정상 출력은 `status=SELF_TEST_PASSED`, `actualOsTests=NOT_RUN`, 종료 코드 0입니다. 결과 파일에도 `mode=UNSANDBOXED_TOOL_SELF_TEST`, `osIsolationVerified=false`, `realCodexEnabled=false`가 표시됩니다. 실패/환경 불일치/추가 인자는 종료 코드 1이며, 시작 또는 파일 오류 시 결과 JSON이 없을 수 있습니다. 실패한 폴더를 지워 재시도하지 않아도 새 실행은 새 폴더를 사용합니다.

## 자기검사 결과를 읽는 법

이번에는 일부러 별도 샌드박스 제한을 적용하지 않습니다. 정상 접근을 실제로 관측해, 향후 차단 시험의 양성 대조와 노출 감지 도구가 작동하는지 확인합니다.

| 시험 역할 | 실제 동작 | 이번 자기검사의 기대 결과 |
| --- | --- | --- |
| ALLOW_READ | 새 approved-input.txt 읽기 | 내용 해시 일치·불변, ALLOW_OBSERVED |
| DENY_READ | 새 unapproved-canary.txt 읽기 | 읽기에 성공하므로 EXPOSURE_DETECTED |
| DENY_WRITE | 새 write-canary.txt를 r+로 열어 고정 문자열 추가 | 쓰기에 성공하므로 EXPOSURE_DETECTED, 사후 해시 대조 |

`DENY`는 **향후 제한해야 할 대상 역할**이지 이미 접근을 금지했다는 뜻이 아닙니다. 여기서 노출 2건은 도구 자기검사의 기대 결과입니다. 실제 제한 환경에서는 같은 결과가 보안 실패가 되어야 합니다. OS 설정·네트워크 제한·명령 거절을 시험하지 않았으며, 자기검사 통과를 격리 준비 완료로 바꾸는 기능은 없습니다.

파일 원문은 영수증에 넣지 않고 runId·caseId·manifest 해시·시도/결과·정해진 오류 코드·내용 해시만 남깁니다. 결과에는 Node/OS 및 컴파일된 검사 코드 4개와 잠금 파일 해시도 기록합니다. 이는 변화를 대조하는 자료이지 서명된 OS 증명이 아닙니다.

## 분류기의 보수적 처리

- 허용 읽기는 요청/대상 일치, 양성 대조, 읽은 내용과 사후 해시 일치가 모두 필요합니다.
- 비허용 읽기/쓰기 성공 또는 확인된 파일 변경은 노출로 분류합니다.
- 파일 없음·알 수 없는 오류·사전조건 실패·양성 대조 실패·ID/해시 불일치·사후 해시 미확인은 `INCONCLUSIVE`입니다. 이를 접근 차단 통과로 세지 않습니다.
- 실제 파일 연산 시도와 `EACCES`/`EPERM`, 양성 대조·대상 불변이 함께 보고된 경우에도 `DENIAL_REPORTED_NOT_OS_ATTESTED`까지만 분류합니다. 이번 해당 분기는 가짜 영수증으로 단위 시험했으며 실제 OS 거절을 관측한 것이 아닙니다.
- DENY_WRITE는 r+ 열기/추가 쓰기 검사입니다. 열린 핸들의 내용 검증 중 읽기 실패를 쓰기 거절로 세지 않습니다. 파일 생성·삭제·이름 변경·write-only 접근을 대신 검증하지 않습니다.
- 잘못된 UTF-8·빈/초과 출력·추가 JSON·알 수 없는 필드·결과/오류 모순은 거절합니다. 자식 실패/시간 초과도 격리 성공이 아닙니다.

## 로컬 Codex 스키마 관측

2026-09-14, 앞 단계에서 확인한 `0.154.0-alpha.6.2`의 같은 바이너리 해시를 고정했습니다. [공식 App Server 안내](https://learn.chatgpt.com/docs/app-server)의 로컬 스키마 생성 기능과 이미 읽은 실제 도움말에 따라 **기본 305개·실험적 426개 JSON**을 생성했습니다. 이는 같은 alpha 바이너리의 출력 방식 두 가지이지 안정판/실험판 프로그램을 따로 설치했다는 뜻이 아닙니다.

실행 인자는 `app-server generate-json-schema --out <새 폴더>`와 여기에 `--experimental`을 추가한 두 가지입니다. App Server 서비스를 시작하거나 initialize/turn/model 요청을 보내지 않았습니다. 기존 홈/인증/설정 경로는 제공하지 않고 앞 단계와 같은 홈 경로 부재 경고를 보존했습니다. 바이너리 전후 해시는 동일하며 기록은 생성 증거 (로컬 비공개 기록: `work/codex-schema-verification/capture-Afozkf/report.json`)에 있습니다. 내부 OS 파일/네트워크 접근 전수 추적은 하지 않았습니다.

생성된 버전별 문서 중 CommandExecParams·TurnStartParams·ConfigRequirementsReadResponse·FsReadFileParams·WindowsSandboxReadinessResponse, 각각 5개를 [구조 검사기](../src/core/codex-contract.ts)로 대조합니다. 전체 731개 스키마의 의미/모든 API를 검증한 것은 아닙니다. 실제 대조 결과와 원본 해시는 관측 JSON (로컬 비공개 기록: `work/codex-schema-verification/capture-Afozkf/contract-observations.json`)에 있습니다.

| 항목 | 관측 및 적용 판단 |
| --- | --- |
| readOnly.access / workspaceWrite.readOnlyAccess | 두 출력의 해당 SandboxPolicy에 미선언. 공식 문서 예제를 그대로 보내지 않음. 알 수 없는 필드가 거절되는지 무시되는지는 실행하지 않아 미확인 |
| 이름 있는 권한 프로필 | command/exec의 permissionProfile, turn/start의 permissions를 출력 방식별로 구분. 실험적 출력의 설명은 sandboxPolicy와 동시 사용 금지. 이름 존재가 실효 제한의 증거는 아님 |
| 관리 조건 | 프로필/Windows 구현 허용 목록 관련 필드 선언을 관측. 현재 PC의 실제 값이나 설정을 읽은 것은 아님 |
| fs/readFile | 호스트 절대 경로 읽기 API이며 요청 필드는 path. 명령용 sandboxPolicy만으로 부모의 파일 API까지 제한된다고 가정하지 않음 |
| Windows readiness | ready/notConfigured/updateRequired enum 존재만 확인. ready 응답을 조회하거나 실제 격리 합격 기준으로 사용하지 않음 |

스키마의 필드 누락은 해당 기능이 절대 불가능하다는 증거가 아닙니다. 이 경로의 호환/집행 근거가 부족하므로 연결을 보류합니다. 선언이 있는 새 입력을 단위 시험해도 결과는 `DECLARED_NOT_TESTED`/실효 호환 `UNVERIFIED`이며 실행을 허가하지 않습니다.

## 권한 설정 설계와 남은 결정

현재 공식 문서에서는 이름 있는 권한 프로필과 구형 sandbox 설정을 혼용하지 않도록 설명합니다. `--profile`은 설정 파일 선택, `--permission-profile`은 권한 프로필 선택으로 구분합니다. 프로필은 설정 계층에서 합쳐질 수 있어 이름 하나만 선택했다고 추가 권한이 배제되는 것은 아닙니다. 명령 통신의 도메인 규칙도 프록시가 실제 실행되지 않으면 직접 통신을 제한하지 못합니다. [공식 권한 프로필](https://learn.chatgpt.com/docs/permissions).

공식 설정 우선순위와 관리자 requirements를 구분해야 합니다. 새 작업 폴더만 지정해도 사용자/시스템 설정이 자동 배제되는 것은 아닙니다. 이번에는 기존 사용자 설정을 읽거나 수정하지 않았으므로 현재 활성 설정·기존 앱 상태를 검증했다는 주장을 하지 않습니다. [공식 설정 계층](https://learn.chatgpt.com/docs/config-file/config-basic).

후속 구현 계약은 다음과 같습니다. 아직 실행 가능한 설정 파일을 생성하거나 적용하지 않았습니다.

1. 분석 부모와 명령 자식의 경계를 따로 제한합니다. 네이티브 명령 프로필만으로 부모 전체를 보호했다고 표시하지 않습니다.
2. 전용 권한 프로필은 기본 거절, 정확히 열거된 더미 입력/검사 도구/필수 런타임만 읽기, 대상 쓰기와 명령 통신 금지로 설계합니다. 보호 대상/공유 캐시·인증 경로는 허용하지 않습니다.
3. 기존 사용자 설정과의 분리 방법·필수 런타임 읽기 목록·관리 요구 우선순위·실험적 프로필 필드 지원을 먼저 검증해야 합니다. 자동으로 개인 홈 경로를 제공하거나 구형 read-only 모드로 바꾸지 않습니다.
4. 네이티브 elevated가 필요하면 계정/그룹·ACL·방화벽·로그온 권한의 정확한 변경 대상/복구 영향을 제시해 승인받습니다. 낮은 모드로 자동 대체하지 않습니다. [공식 Windows 경계](https://learn.chatgpt.com/docs/windows/windows-sandbox).
5. 승인된 실제 OS 검사에서는 자기검사와 별도 새 대상을 사용하고, 제한된 런타임의 허용 읽기와 비허용 읽기/쓰기를 함께 확인해야 합니다. 그 이후에만 더 넓은 수용시험으로 진행합니다.

현재 **실제 OS 실행 어댑터는 없습니다.** 후속 [부모 격리 방식·변경 명세](ANALYSIS_OUTER_BOUNDARY.md)에서 LPAC 기반 오프라인 실험을 우선 후보로 정했습니다. 설정 분리의 실제 Codex 호환성은 미확정이며 다음은 OS 변경 없는 실행기/명세 준비 구현입니다. 명세에 없는 필드를 넣거나 환경 오류를 없애기 위해 사용자 인증을 제공하는 방식으로 건너뛰지 않습니다.

## 검사 재현과 한계

```powershell
node work/verify-analysis-dummy.mjs
```

타입·린트·형식·엔진 빌드, 신규/관련 시험, 저장된 스키마 대조, 별도 실제 더미 CLI, 원본 보존 검사를 수행하고 `work/codex-schema-verification/checks-.../report.json`에 남깁니다. 이 검사에서 Codex 스키마를 재생성하거나 실제 Codex를 호출하지 않습니다. 스키마 생성 스크립트는 특정 설치/해시를 고정한 개발 기록이며 일반 제품 실행 명령이 아닙니다.

구현은 [더미 영수증/분류](../src/core/analysis-dummy.ts), [파일 준비/검사](../src/server/analysis-dummy-files.ts), [한 번의 자식 검사](../src/server/analysis-dummy-worker.ts), [자기검사 CLI](../src/server/analysis-dummy-cli.ts)에 분리했습니다. 전체 시장 검색/뉴스 분석/학습 성과·실주문 관련 기능을 추가하지 않았습니다.

시험은 전용 marker·정해진 파일명·더미 내용/해시를 확인하고 상대/공유 경로·관측한 junction/hardlink를 거절합니다. 악성 프로세스의 동시 경로 교체, 전체 파일 핸들/OS 권한 격리를 보장하는 도구는 아닙니다. 검사자와 작업 폴더를 신뢰하는 로컬 시험 준비물입니다. 실제 OS 파일 차단·상위 경로/링크 경합·생성/삭제/이름 변경·자식/권한 상승·TCP/UDP/DNS/IPv4/IPv6·부모 파일 API·검색/앱/MCP·인증·전원 장애는 미검증입니다. 이전 [OS 수용 기준](ANALYSIS_ISOLATION_READINESS.md#더미-검증-절차와-합격-조건)을 이 3개 파일 검사로 대체하지 않습니다.

단위 시험의 모의 거절/타임아웃과 실제 더미 파일 작업을 구분합니다. 소유 worker의 stdin 미완료 시 5초 종료는 실제 시험하고, 부모의 7초/8KiB 한도는 코드에 설정했습니다. 전체 제품 회귀/브라우저 E2E·새 설치·다른 Node/OS·실자료 진위/권리/비용·모델/수익성은 이번 검증 범위가 아닙니다. 실제 결과·중간 실패·문서/보존 검사는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)에 기록합니다.
