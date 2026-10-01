# 분석 격리 권한 준비·복구 판단

파일 전용 격리 시험의 **권한 검토 명세**, Windows 보안 설명자 메모리 검사, 원복 판단·실패 모형을 제공하는 개발용 도구입니다. 이 도구는 실제 프로필 생성·ACL 적용·OS 실행·AI 분석·거래에 연결하지 않습니다. 기본 웹 앱의 필수 구성요소가 아닙니다.

후속 [잠긴 ACL 어댑터·영속 시험 기록](ANALYSIS_PERMISSION_JOURNAL.md)에서 별도 Win32 적용/원복 코드의 빌드와 모형 디스크 저널을 추가했습니다. 실제 OS 연결은 잠겨 있으며 아래는 변경하지 않은 기존 검토 명세/메모리 검사기 계약입니다. 디스크 모형 기록을 이 문서의 실제 복구 증거로 취급하지 않습니다.

기존 [파일 시험기](ANALYSIS_FILE_PROBE.md)의 더미 연산에 적용할 권한을 구체화했습니다. [이름 기반 SID 계산 API](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-deriveappcontainersidfromappcontainername)와 보안 설명자 변환의 성공을 프로필 실재·접근 허용/차단·격리 성공의 증거로 취급하지 않습니다.

## 제공 범위와 한계

| 구성 | 현재 동작 | 아직 하지 않는 것 |
| --- | --- | --- |
| 네이티브 검사기 | 현재 프로세스 사용자 SID 조회, 고유 이름의 AppContainer SID 계산, 보안 설명자 5종 변환·ACE/라벨 구조와 왕복 변환 검사 | 프로필 생성/충돌/저장소 조회, 파일 ACL 조회/적용, LPAC 실행 |
| prepare/check | 빌드·코드·검사 결과·16개 예정 대상을 결합해 새 검토 묶음 저장/읽기 전용 대조 | 실행 승인, 실제 대상 생성, 사용자 파일 변경 |
| 복구 판단 | 모형 생성 증거·객체 식별값·권한 전후 해시·프로세스 종료를 확인해 역순 원복 판단 | 실제 파일/프로필 복구, 디스크 저널, 비정상 종료 후 재개 |
| 실패 모형 | 단계 직전/직후 실패, 불명확 생성/삭제, 외부 변경, 잔류 프로필을 보류 | 실제 OS 장애·권한 경합·원복 성공 검증 |

현재 메모리 검사기는 `CreateAppContainerProfile`, `DeleteAppContainerProfile`, `SetSecurityInfo`를 호출하는 어댑터를 포함하지 않습니다. 실제 적용 코드를 붙이는 후속 구현과 별도 OS 변경 승인 전에는 실행할 수 없습니다. 기존 실행 준비 명세의 null·잠금 값도 바꾸지 않습니다.

## 실행 환경과 빠른 시작

프로젝트 루트의 PowerShell에서 실행합니다. 기존 의존성 설치는 [README](../README.md#빠른-시작)를 따릅니다. 검증 환경은 Windows x64, Node **24.20.0**, 설치된 MSVC **14.39.33519**, Windows SDK **10.0.22621.0**입니다. cl/link/dumpbin의 고정 경로·해시가 다르면 중단하며 자동 설치·다운로드·권한 상승은 없습니다. 다른 PC/도구 버전 지원을 검증하지 않았습니다.

```powershell
npm run build:engine
if ($LASTEXITCODE -ne 0) { throw '엔진 빌드 실패' }

$fileProbeBuild = node scripts/build-analysis-file-probe.mjs | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '파일 시험기 빌드 실패' }

$provisionBuild = node scripts/build-analysis-provision.mjs | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '권한 검사기 빌드 실패' }

$provisionReview = node dist/runtime/src/server/analysis-provision-cli.js prepare $provisionBuild.buildId $provisionBuild.buildSha256 $fileProbeBuild.buildId $fileProbeBuild.buildSha256 | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '권한 검토 명세 생성 실패' }

node dist/runtime/src/server/analysis-provision-cli.js check $provisionReview.runId $provisionReview.manifestSha256
if ($LASTEXITCODE -ne 0) { throw '권한 검토 명세 대조 실패' }
```

이 순서는 파일 시험기 **빌드**까지 사용하며 파일 연산 자기검사나 격리 실행을 시작하지 않습니다. 증권 키·AI 인증·계좌·외부 자료를 입력하지 않습니다.

prepare 정상 상태는 `PROVISION_REVIEW_PREPARED_NOT_APPROVED`, check 정상 상태는 `PROVISION_REVIEW_VALID_EXECUTION_LOCKED`, 종료 코드 0입니다. 대상 수 16, `memoryStructureVerified=true`, `profileExistence=NOT_QUERIED`, `executionAllowed=false`, `osChangesApplied=false`, `osIsolationVerified=false`를 함께 확인하세요. 실제 승인/OS 검증을 마친 상태가 아닙니다.

오류는 원문 정보 대신 `PROVISION_PREPARATION_REJECTED`와 종료 코드 1을 반환합니다. 임의 경로·SDDL·명령, `execute`, `approve`, `setup`, `rollback`, 추가 인자는 파일 작업 전에 거절합니다. 실패한 묶음은 지우거나 고쳐 쓰지 않으며 새 prepare는 새 UUID를 사용합니다.

### 생성되는 로컬 자료

- `work/analysis-provision-build/build-<UUID>/`: 검사기 exe, obj, 빌드 영수증, headers/imports/loadconfig, 명령 결과.
- `work/analysis-provision-build-temp/build-<UUID>/`: 도구 전용 임시 위치. 실행 파일 위치와 분리합니다.
- `work/analysis-provision-plans/plan-<run-id>/`: `inspection.json`과 `manifest.json` 2개만 생성합니다.

예정 `work/analysis-os-lab/run-<run-id>/`는 만들지 않습니다. 이미 있으면 충돌로 중단하고 재사용·삭제·권한 수정하지 않습니다. 외부 AppContainer 저장소 경로와 레지스트리 위치는 아직 null입니다.

검토 묶음에는 **현재 실행자의 Windows SID와 로컬 예정 경로**가 들어갑니다. 인증 토큰은 아니지만 개인 환경 정보이므로 공개 문서·외부 분석에 그대로 첨부하지 마세요. 기본 CLI 요약에는 사용자 SID를 출력하지 않습니다. check는 저장된 관측과 현재 코드/빌드의 일관성을 검사하며 사용자 토큰이나 프로필 상태를 새로 조회하지 않습니다. 실제 적용 직전 재관측을 대신하지 않습니다.

출력된 명세 해시는 파일과 별도로 보존해야 변경 대조에 의미가 있습니다. 해시는 사용자 서명·독립 증명이나, 같은 사용자가 코드/자료/해시를 모두 바꾸는 공격의 방어가 아닙니다. 재서명한 명세라도 고정 대상·권한·실행 잠금 규칙이 달라지면 거절합니다.

## 파일 전용 최소 권한

새 대상은 초기에는 제어기 사용자와 SYSTEM만 모든 권한을 갖는 **보호된 명시 DACL**로 만들도록 계획합니다. 기존 사용자 파일 권한을 이 템플릿으로 바꾸는 기능이 아닙니다. 각 대상의 보안 설명자를 따로 지정하며 상속 ACE, Everyone/ALL APPLICATION PACKAGES 허용, null DACL을 허용하지 않습니다.

| 대상 | 컨테이너에 제안하는 권한 | 무결성 라벨 |
| --- | --- | --- |
| run, bin, input, scratch 디렉터리 | 읽기·탐색만, 파일 생성/삭제 권한 없음 | Medium, no-write-up |
| marker, input/allow.txt | 읽기만 | Medium, no-write-up |
| 고정 bin/analysis-file-probe.exe | 읽기·실행 | Medium, no-write-up |
| scratch/write.txt | 추가 쓰기·속성 읽기·동기화만. 덮어쓰기/읽기/삭제/실행 권한 없음 | Low, no-write-up |
| private, profile, evidence 및 private 4파일·manifest | 컨테이너 허용 ACE 없음 | Medium, no-write-up |

16개 초기 대상 외의 private/create.txt·private/renamed.txt는 존재하지 않아야 합니다. root marker는 기존 네이티브 시험기가 사전 확인하는 자료이므로 읽기를 허용하지만 manifest는 호스트만 다룹니다.

기존 넓은 `scratch/profile` 의도를 **첫 고정 파일 시험에서 필요한 권한으로 한정**한 별도 검토 명세입니다. 현재 probe에는 일반 임시 파일 생성이나 사용자 설정 저장이 필요하지 않아 profile은 호스트 전용으로 유지합니다. 후속 실제 AI 런타임이 추가 쓰기/자식/설정 권한을 필요로 하면 새 설계·검증·승인이 필요하며 이 권한을 자동 확대하지 않습니다. 거래 정책/위험 수치를 변경한 것은 아닙니다.

라벨과 DACL은 별개입니다. DACL에서 쓰기를 허용해도 낮은 무결성 프로세스가 Medium 객체에 쓸 수 있는 것은 아니므로 실제 추가 쓰기 대상만 Low로 계획합니다. 설명자는 Windows API로 변환하고 소유 SID, 보호 플래그, ACE 수·순서·종류·마스크·상속 플래그·라벨을 검사합니다. 실제 파일 접근 효과는 별도 LPAC 양성/음성 시험이 필요합니다. [Microsoft 무결성 제어](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control), [보안 설명자 변환](https://learn.microsoft.com/en-us/windows/win32/api/sddl/nf-sddl-convertstringsecuritydescriptortosecuritydescriptorw).

## 복구 판단과 보류 규칙

복구 모듈은 `MODEL_ONLY` 기록만 받는 순수 함수입니다. OS 핸들·실행 콜백·셸 명령을 받지 않으며, 모형의 객체 ID/권한 해시를 실제 파일 신원/권한 증명으로 사용할 수 없습니다.

1. 명세/run 해시, 순서가 맞는 기록, 중복 없는 객체 식별값과 이번 run 생성 증거를 확인합니다.
2. 프로세스가 시작되지 않았거나 종료 확인됐다는 모형 관측을 요구합니다. 실행 중/미확인은 모든 원복을 보류합니다.
3. 각 대상의 현재 신원·링크 확인과 권한을 대조합니다. 적용했던 권한과 달라졌으면 덮어쓰지 않습니다. 이미 초기 상태면 작업을 생략합니다.
4. 변경된 권한을 역순으로 초기 호스트 전용 상태로 되돌리는 동작을 계획합니다. 새 파일/보고서를 삭제하는 동작은 생성하지 않습니다.
5. 새 프로필 생성 성공 증거·이름/SID/저장소 식별값·핸들 종료가 일치할 때만 마지막에 **모형 프로필** 제거를 계획합니다. 생성/삭제 시작만 기록된 경우, 기존 프로필 충돌, 불명확 실패는 보류합니다.
6. 실패 모형은 부분 결과를 유지합니다. 자동 재시도하지 않으며 별도 모형 재검증/실행으로만 진행합니다. 삭제 반환 성공만으로 완료하지 않고 부재 관측을 요구합니다.

상태 `MODEL_RECOVERED`는 **모형 상태 대조 완료**입니다. 실제 OS 원복·충돌 잠금·디스크 원자성·정전 복구 성공이 아닙니다. 생성 API는 사용자별 폴더/레지스트리를 만들 수 있고, 삭제 API는 없는 프로필에도 성공하며 열린 핸들로 인해 저장소가 남을 수 있으므로 실제 어댑터에는 별도 소유·잔류 확인이 필요합니다. [프로필 생성](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile), [프로필 삭제](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-deleteappcontainerprofile).

## 검사와 다음 단계

빠른 시작의 두 빌드 변수가 유지된 PowerShell에서 실행합니다.

```powershell
node --test --test-concurrency=1 dist/runtime/tests/analysis-provision.test.js
node scripts/test-analysis-provision.mjs $provisionBuild.buildId $provisionBuild.buildSha256 $fileProbeBuild.buildId $fileProbeBuild.buildSha256
```

첫 명령은 권한/명세와 복구 판단·실패 모형입니다. 두 번째는 실제 네이티브 메모리 검사, 입력/EOF·빌드/자료/링크·명령 거절, 새 복사본 CLI prepare/check를 시험합니다. 내부 49개 보안 설명자 사례는 실제 Windows **메모리 구조 검사**이며 파일 ACL 적용이나 접근 판정이 아닙니다. 검사 결과는 새 `work/provision-test-*/report.json`에 저장합니다.

인계용 `node work/verify-analysis-provision.mjs`는 관련 회귀와 원본 대조를 포함합니다. 현재 프로젝트에 보존된 이전 파일 시험기/요청 검증기의 지정 빌드를 요구하므로 새 설치 환경에서 그대로 재현되는 일반 명령은 아닙니다. 기존 회귀 중 더미 파일 시험은 새 시험 파일에만 연산하며 실제 사용자 파일·계좌는 사용하지 않습니다.

구현: [권한 명세](../src/core/analysis-provision.ts), [복구 판단·모형](../src/core/analysis-provision-recovery.ts), [파일/빌드 결합](../src/server/analysis-provision-files.ts), [네이티브 보안 구조 검사](../src/native/provision-security.hpp).

후속 어댑터 빌드/모형 저널 이후에도 **실제 OS–디스크 기록 연결·소유 및 저장소 확인**이 필요합니다. 프로필 저장소의 실제 영향 범위와 실패 잔류 정리 방법을 확정하고, 사용자에게 구체적인 변경 명세를 제시해 별도 승인받은 뒤 실제 OS 파일 시험을 진행합니다. 지금 검토 묶음은 그 승인을 대신하지 않습니다.

미검증: 실제 프로필 생성/충돌/저장소, ACL 적용/읽기/복원·LPAC 효과·상속/경합·부모 종료/자원 한도·네트워크/자식 차단, 실제 OS–영속 저널 연결/정전 복구, 다른 사용자/PC/Windows, 도구·SDK 종속 DLL 전체 무결성/통신, 실제 AI 인증/모델·UI/E2E·실자료 성과. 빌드 임시 파일/도구 통신 추적의 기존 한계도 [파일 시험기 안내](ANALYSIS_FILE_PROBE.md#생성되는-파일)와 같습니다.
