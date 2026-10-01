# 잠긴 Windows 권한 어댑터와 영속 시험 기록

기존 [권한 검토 명세](ANALYSIS_PERMISSION_PREPARATION.md)를 보존하면서, **실제 Win32 ACL 적용/원복 코드의 빌드**와 **새 모형 기록의 디스크 저장·비정상 종료 보류**를 추가한 개발용 도구입니다. Windows 권한은 변경하지 않습니다. 웹 앱·계좌·실제 AI·거래에는 연결되지 않습니다.

2026-09-16 후속: [네이티브 모형–기록 연결](ANALYSIS_PERMISSION_BRIDGE.md)을 별도 도구로 추가했습니다. 새 파일의 실제 소유자/ID 관측과 네이티브 모형 제어기의 디스크 기록 연결을 검사합니다. 아래의 기존 sample/자기검사 범위는 그대로이며, **실제 Win32 변경 포트–기록 연결과 ACL 수용은 여전히 미완료**입니다.

## 현재 상태

| 구성 | 제공하는 것 | 제공하지 않는 것 |
| --- | --- | --- |
| Win32 ACL 어댑터 | 고정 16대상, 핸들/파일 ID, 기존 권한 확인, SetSecurityInfo 적용/원복 코드와 빌드 | 공개 실행 경로, 실제 ACL 변경/복구 성공 |
| 네이티브 제어기 | 사전 관측 → 사전 기록 확인 → 변경 → 사후 관측/기록의 모형 검사 | 실제 디스크 저널 연결, OS 프로세스 종료 증명 |
| 디스크 저널 | 새 기록 파일, 동기화, 순서·해시·중복·신원 검사, 재시작 보류 | 실제 OS 변경의 증거, 자동 원복/재실행/잠금 해제 |
| CLI | 지정 검토 묶음의 고정 모형 sample, 외부 해시를 지정한 check | 임의 파일/명령, apply·restore·approve·실제 분석 |

**두 구현을 실제 OS 실행 경로로 연결하지 않았습니다.** TypeScript 저널은 `MODEL_ONLY`이고 네이티브 사전 기록 인터페이스와 직렬화 방식도 다릅니다. 모형 기록을 이름만 바꿔 OS 실행 증거로 사용할 수 없습니다. 실제 연결에는 별도 계약·승인·사전 기록 동기화 확인·독립 재관측과 장애 검사가 필요합니다.

이전 검토 명세의 `osMutationBackend=ABSENT` 등은 당시 버전의 계약으로 유지했습니다. 새 어댑터 빌드의 `COMPILED_LOCKED`를 이전 명세의 실행 승인으로 해석하면 안 됩니다. 기존 검토 묶음을 덮어쓰거나 원본 거래 기준을 변경하지 않습니다.

## 실행 환경과 사용법

프로젝트 루트의 PowerShell에서 실행합니다. [기존 설치 안내](../README.md#빠른-시작)와 [권한 검토 빠른 시작](ANALYSIS_PERMISSION_PREPARATION.md#실행-환경과-빠른-시작)을 먼저 완료해 `$provisionReview`를 얻으세요. Windows x64, Node 24.20.0, MSVC 14.39.33519, Windows SDK 10.0.22621.0을 대상으로 합니다. 다른 버전은 자동 다운로드/설치하지 않습니다.

```powershell
npm run build:engine
if ($LASTEXITCODE -ne 0) { throw '엔진 빌드 실패' }

$permissionBuild = node scripts/build-analysis-permission.mjs | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '권한 어댑터 빌드 실패' }

node scripts/test-analysis-permission.mjs $permissionBuild.buildId $permissionBuild.buildSha256
if ($LASTEXITCODE -ne 0) { throw '네이티브 모형 검사 실패' }

$journalSample = node dist/runtime/src/server/analysis-permission-cli.js sample $provisionReview.runId $provisionReview.manifestSha256 | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '모형 기록 생성 실패' }

node dist/runtime/src/server/analysis-permission-cli.js check $journalSample.labId $journalSample.bindingSha256 $journalSample.head
if ($LASTEXITCODE -ne 0) { throw '기록 대조 실패 또는 복구 보류' }
```

`sample`은 메모리상 16대상의 적용과 역순 원복을 기록합니다. 디스크에 남는 BEFORE/AFTER 64건, `appliedCount=0`, `MODEL_RECORDS_VERIFIED`, 종료 0이 정상입니다. `executionAllowed`, `osChangesApplied`, `osRecoveryVerified`는 모두 false입니다. 모형의 권한 해시 대조이지 실제 파일 ACL 판정이 아닙니다.

`check`는 lab ID·binding 해시·마지막 head 해시를 필수로 받습니다. 위 PowerShell 변수는 창을 닫으면 사라지므로 `$journalSample`의 `labId`, `bindingSha256`, `head`를 기록 파일과 별도로 보관하세요. 보류/오류는 종료 2입니다. 형식 오류는 `PERMISSION_HOLD`, 유효한 기록의 진행 중/남은 잠금은 `RECOVERY_HOLD`입니다. 해시가 없는 내부 관측도 항상 보류하며, 검증 성공을 자동 재개로 연결하지 않습니다.

## 디스크 기록과 복구 보류

`work/analysis-recovery-lab/lab-<UUID>/`에 `binding.json`, `events.ndjson`를 새로 만듭니다. 기존 파일을 재사용하지 않습니다. 쓰는 동안에만 `writer.lock`을 독점 생성하며, 정상 종료 시 본인이 만든 잠금 파일만 제거합니다. 실제 기록은 삭제/회전/수정하지 않습니다. 비정상 종료로 남은 잠금은 자동 해제하지 마세요.

각 BEFORE에는 고유 작업 ID, 대상 순서, 적용/원복 방향, 모형 객체 ID, 기존/목표 권한 해시가 들어갑니다. 모든 바이트를 쓴 뒤 `fsyncSync` 성공을 확인해야 사전 기록 영수증을 반환합니다. AFTER는 같은 작업의 목표 상태 확인 또는 불명확 결과를 남깁니다. 파일 신원/길이·링크·정확한 파일 목록과 외부 head도 대조합니다.

재관측 결과가 있어도 미완료 BEFORE, 불명확 결과, 잘린 마지막 행, 해시/순서 불일치, 외부 head 불일치, 남은 writer 잠금은 보류합니다. 잘린 기록을 자동 보정하거나 오래된 프로세스 ID만 보고 잠금을 지우지 않습니다. 운영자 복구 도구는 아직 없으며, 기록을 보존하고 독립 재관측·소유 증명·프로세스 종료 확인을 구현해야 합니다.

해시 체인은 서명이 아닙니다. 유효한 앞부분만 남긴 절단은 **외부에 보관한 최신 head**가 있어야 검출할 수 있습니다. 공격자가 기록·코드·외부 head까지 함께 바꾸는 상황이나 악성 동일 사용자와의 경합을 방어하는 OS 보안 경계가 아닙니다.

동기화는 프로세스 종료 시험의 근거이며 정전 내구성을 보증하지 않습니다. Windows 디렉터리 생성/잠금 삭제의 영속성, 디스크 캐시·컨트롤러·파일 시스템 장애를 따로 검증하지 않았습니다. Node의 파일 동기화 API를 사용하며 하드웨어별 보장은 추가 검증 대상입니다. [Node fsyncSync](https://nodejs.org/api/fs.html#fsfsyncsyncfd).

## 실제 ACL 코드의 잠금과 제약

네이티브 공개 프로그램은 `--self-test`만 받습니다. Win32 포트를 선택하면 첫 관측 전에 `Locked`로 종료하며 인자·환경변수·가짜 영수증으로 풀리지 않습니다. 자기검사는 Win32 객체를 생성만 하고 그 객체의 파일/권한 메서드는 호출하지 않습니다.

컴파일된 어댑터는 지정 run 경로와 고정 상대 경로만 처리하도록 작성했습니다. 상위 디렉터리와 대상 핸들을 유지하고 reparse/hardlink·최종 경로·파일 ID·현재 실행자/예정 프로필 SID를 대조합니다. 기존 권한과 목표 권한은 이전 5개 고정 템플릿만 허용합니다. 적용 실패/사후 불일치는 불명확으로 분류하며 자동 재시도하지 않습니다. 일반 사용자 파일의 임의 ACL을 저장/복원하는 도구가 아닙니다.

**SACL 보호를 생략하지 않습니다.** 전체 SACL 조회/설정과 보호에는 `ACCESS_SYSTEM_SECURITY` 및 이미 활성화된 해당 권한이 필요할 수 있습니다. 코드가 SeSecurityPrivilege를 활성화하거나 관리자 권한을 요청하지 않으며 부족하면 실패합니다. `LABEL_SECURITY_INFORMATION`만 쓰는 것과 SACL 보호를 설정하는 것은 요구 권한이 다릅니다. [Microsoft 권한 플래그](https://learn.microsoft.com/en-us/windows/win32/secauthz/security-information), [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo), [SetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo).

실제 연결 전에 다음이 남아 있습니다.

- 새 객체 생성 증명 발급, 실제 초기 보안 설명자와 파일 ID 수집, run/승인/빌드/디스크 영수증의 네이티브 결합.
- 프로필 신규 생성·충돌·사용자별 저장소/레지스트리 영향·소유 확인·잔류 정리. 프로필 생성/삭제 어댑터는 이번 구현 대상이 아닙니다.
- 종료/열린 핸들 독립 확인, 실제 SACL/그룹/제어 플래그의 OS 표현, 권한 부족·외부 ACL 경합·부분 변경 후 재관측과 원복.
- 구체적 대상/권한/부작용을 제시한 별도 OS 변경 승인과 실제 LPAC 파일 접근 양성/음성 시험.

빌드·검토 자료는 `work/analysis-permission-build/`와 별도 `analysis-permission-build-temp/`에 남습니다. 도구 3개·소스 8개·실행 파일/PE 근거를 해시로 결합하지만 SDK 헤더/라이브러리·종속 DLL 전체 무결성, 빌드 도구 내부 통신을 보증하지 않습니다. 관리자 권한으로 실행하면 안전하다는 안내가 아닙니다.

## 검사와 구현 위치

```powershell
node --test --test-concurrency=1 dist/runtime/tests/analysis-permission-journal.test.js
```

새 디스크 기록, 정상 재개, 중복·신원/순서·불완전/변조·동시 writer와 별도 시험 프로세스 강제 종료를 검사합니다. 종료 시험은 잠금 생성 직후, BEFORE 동기화 후, 별도 모형 효과 파일 동기화 후, AFTER 동기화 후의 네 지점입니다. 새 시험 프로세스만 종료하며 사용자 앱/서버를 종료하지 않습니다. `work/permission-model-effect-<lab-id>.json`과 손상/링크 시험 파일은 재생성 가능한 시험 자료로 남습니다.

현재 검사는 실제 OS ACL/격리 효과·정전·계좌/AI·거래 수익성·전체 웹 UI/E2E 검사가 아닙니다. 기본 웹 앱의 동작/필수 설정을 바꾸지 않으며 외부 API 비용도 발생시키지 않습니다.

구현: [기록 계약](../src/core/analysis-permission-journal.ts), [디스크 writer](../src/server/analysis-permission-journal-files.ts), [CLI](../src/server/analysis-permission-cli.ts), [네이티브 제어기](../src/native/permission-mutation.hpp), [Win32 어댑터](../src/native/permission-win32.cpp). 기록은 128행/128 KiB로 제한하고 작은 개발 실험에 동기식 I/O를 사용합니다. 웹 요청이나 거래 루프에 연결하지 않으며 추후 성능 측정 없이 동기화를 생략하지 않습니다.
