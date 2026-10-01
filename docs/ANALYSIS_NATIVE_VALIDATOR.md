# Windows 네이티브 분석 요청 검증기

기존 [실행 준비 명세](ANALYSIS_LAUNCH_PREPARATION.md)를 다시 확인하고, 고정된 요청을 자체 C++ 실행 파일에 전달해 결과를 대조하는 개발용 CLI입니다. **검증기 자체는 실제 실행하지만, 분석 작업·LPAC 샌드박스·Codex·모델·거래는 실행하지 않습니다.** 사용자 앱의 필수 실행 과정이 아닙니다.

2026-09-15 후속: 별도 [파일 접근 시험기·잠긴 격리 실행 코어](ANALYSIS_FILE_PROBE.md)를 추가했습니다. 여기의 요청 검증기는 변경하지 않았고, 후속 도구의 실제 더미 연산·모형 실행 순서 검사와도 구분합니다. 실제 LPAC/Job 적용·프로필/ACL 준비는 여전히 미완료이며 아래 다음 단계 설명은 작성 당시 기록입니다.

## 현재 기능과 경계

| 구성 | 실제 제공 | 제공하지 않는 것 |
| --- | --- | --- |
| TypeScript 호스트 | 기존 명세/더미 자료, 현재 소스·빌드·바이너리 해시 확인, 고정 자식 호출, 결과 바인딩 및 사후 재검증 | 범용 실행 파일/경로/명령 인자, 승인/실행 전환 |
| C++ 검증기 | 고정 300바이트 요청 형식·잠금값 검사, stdio 결과, 잘못된 입력 거절 | 전체 JSON 명세/실제 파일 해시 확인, 대상 파일 접근 probe, OS 제한 실행기 |
| 오프라인 빌드 | 고정 설치 도구로 새 디렉터리에 컴파일·링크, 도구/소스/산출물 해시·PE 검사 자료 저장 | 도구 설치·패키지 다운로드·서명·완전한 빌드 공급망 검증 |

검증기가 해시 문자열을 되돌려주는 것 자체는 파일 무결성 증거가 아닙니다. 실제 파일 해시와 명세를 확인하는 책임은 호스트에 있고, 네이티브 결과는 그 요청에 맞는 **입출력 계약 확인**입니다. 기존 `ANALYSIS_LAUNCH_PLAN_V1`의 `nativeArtifact=null`, `nativeBuild=NOT_VERIFIED`는 아직 없는 **OS 격리 실행기**를 의미하므로 바꾸지 않습니다.

## 실행 환경

현재 검사 대상은 Windows x64, Node **24.20.0**, Visual Studio 2022 Community 설치 폴더의 MSVC **14.39.33519**, Windows SDK **10.0.22621.0**입니다. 실제 cl.exe 파일 버전은 19.39.33523.0, link.exe/dumpbin.exe는 14.39.33523.0입니다. 다른 PC/버전 지원을 확인한 것은 아닙니다.

빌드 스크립트는 이 설치의 절대 경로와 도구 3개 SHA-256을 고정합니다. 도구가 없거나 달라졌다면 실패하며 다른 도구 탐색·설치·다운로드로 전환하지 않습니다. 분석 기능 때문에 Visual Studio를 새로 설치할 필요는 없습니다. 기존 기본 웹 앱은 이 네이티브 바이너리에 의존하지 않습니다.

컴파일에 `/W4 /WX /GS /guard:cf /MT`, 링크에 `/WX /DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT /GUARD:CF`를 사용합니다. 소스는 C++20입니다. [Microsoft CFG 안내](https://learn.microsoft.com/en-us/cpp/build/reference/guard-enable-guard-checks?view=msvc-170)에 따라 컴파일·링크 양쪽에 CFG 옵션을 적용합니다. `/MT`는 [정적 CRT 선택](https://learn.microsoft.com/en-us/cpp/build/reference/md-mt-ld-use-run-time-library?view=msvc-170)이지 파일/통신 격리 기능이 아닙니다.

## 빠른 시작 — 개발자 전용

기존 프로젝트 의존성 설치가 끝난 **프로젝트 루트의 PowerShell**에서 실행합니다. 기본 앱 설치는 [README](../README.md#빠른-시작)를 따릅니다. 아래 절차 자체는 네트워크나 키를 사용하지 않습니다.

```powershell
npm run build:engine
if ($LASTEXITCODE -ne 0) { throw '엔진 빌드 실패' }

$nativeBuild = node scripts/build-analysis-native.mjs | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '네이티브 빌드 실패' }

$nativePlan = node dist/runtime/src/server/analysis-launch-cli.js prepare | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '실행 준비 실패' }

node dist/runtime/src/server/analysis-native-cli.js check $nativeBuild.buildId $nativeBuild.buildSha256 $nativePlan.runId $nativePlan.manifestSha256
if ($LASTEXITCODE -ne 0) { throw '네이티브 검증 실패' }
```

성공 조건은 종료 코드 0과 `status=NATIVE_REQUEST_VALID_EXECUTION_LOCKED`, `nativeValidationExecuted=true`, `executionAllowed=false`, `actualOsTests=NOT_RUN`, `osIsolationVerified=false`, `realCodexEnabled=false`입니다. 명세와 입력의 해시는 따로 결합됩니다. `execute`, `approve`, `setup`, 추가 인자 및 임의 경로는 허용하지 않습니다.

빌드 때마다 `work/analysis-native-build/build-<buildId>/`에 새 파일을 만듭니다. 기존 빌드/명세는 덮어쓰지 않습니다. 검사 CLI는 기존 파일을 읽고 결과 JSON을 stdout으로 반환하며 OS 실행 디렉터리는 만들지 않습니다. 준비 CLI는 별도의 새 더미 묶음을 생성합니다. 성공한 빌드 디렉터리에는 exe·obj·build.json 및 headers/imports/loadconfig/commands.txt가 있습니다. 실패한 컴파일/링크/도구 호출은 별도 failed-build.json에 보존되고 성공 영수증을 발급하지 않습니다.

빌드 후 소스/호스트 컴파일 코드/빌드 스크립트/잠금 파일이 바뀌면 기존 빌드 확인은 거절됩니다. 엔진과 네이티브를 다시 빌드하고 새로 표시된 ID/해시를 사용하세요. 명세를 생성하는 기존 코드가 바뀐 경우에는 준비 묶음도 다시 생성합니다. 해시를 맞추려고 기존 JSON을 직접 편집하지 않습니다.

## 입력·결과 계약과 제한

요청은 LF로 끝나는 ASCII 10행이며 순서는 버전, UUIDv4 run-id, 명세 SHA-256, 더미 입력 SHA-256, `PREPARATION_ONLY`, `CAPABILITIES=NONE`, `CHILD_PROCESSES=DENY`, `LIMITS=1,128,2000,10000,8192`, `EXECUTION=LOCKED`, `END`입니다. UUID·해시 길이는 고정이며 소문자만 받습니다. 임의 뉴스·사용자 파일·명령을 이 프레임에 넣는 기능이 아닙니다.

- 네이티브 입력 버퍼는 최대 384바이트, 반환 버퍼는 512바이트입니다. 현재 정상 입력은 300바이트입니다.
- 표준 입출력 모두 파이프만 받습니다. 정규 파일/콘솔을 직접 연결하는 사용법은 지원하지 않습니다.
- 유효한 앞부분만 받고 성공하지 않도록 EOF까지 기다립니다. 5초 이내 EOF가 오지 않으면 결과 없이 종료합니다. 단일 스레드 파이프 확인은 [PeekNamedPipe](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-peeknamedpipe), 기한은 [GetTickCount64](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-gettickcount64)를 사용합니다.
- 호스트는 고정 exe·`--validate`만 shell 없이 숨김 실행하고 기존 사용자 환경을 넘기지 않습니다. 7초 감시, 512바이트 출력 상한, stderr 발생/비정상 종료 거절을 적용합니다. 매매/LLM 관련 환경변수나 인증 파일은 전달하지 않습니다.
- 프레임의 `LIMITS`는 기존 **향후 OS 실행 한도**의 선언값입니다. 현재 자식에 Job 메모리/CPU/프로세스 수 제한을 적용했다는 뜻이 아닙니다.
- 결과는 원 요청의 ID/해시/잠금값에 대한 정확한 바이트 비교 후에만 반환합니다. 중복 결과·BOM·추가 JSON·승인 주장도 거절합니다.

네이티브 종료 코드는 0=계약 검증 성공(실행 잠금), 2=허용하지 않은 명령, 3=입출력 종류/입력 오류, 4=입력 기한 초과, 5=출력 실패입니다. 실패 시 원문을 출력하지 않습니다. 상위 CLI의 실패는 종료 코드 1과 `ANALYSIS_NATIVE_CHECK_REJECTED`입니다.

## 검사 방법

위 빠른 시작의 빌드 변수가 유지된 PowerShell에서:

```powershell
node --test --test-concurrency=1 dist/runtime/tests/analysis-native.test.js
node scripts/test-analysis-native.mjs $nativeBuild.buildId $nativeBuild.buildSha256
```

첫 명령은 TypeScript 계약·결과·빌드 영수증·PE 표시 검사를 합니다. 두 번째는 실제 컴파일된 검증기의 정상/분할 입력·거절·EOF 기한을 확인하고, 모든 바이트 위치의 NUL 변이 300개 및 별도 시험 복사본의 변조·링크·CLI 결합을 확인합니다. 결과는 새 `work/native-test-*/report.json`에 저장합니다. 시험 중 만드는 파일·링크는 새 시험 복사본 안에 한정하며 원본 빌드/명세는 변경하지 않습니다.

개발 인계용 전체 선택 검사는 `node work/verify-analysis-native.mjs`입니다. 타입·린트·형식·엔진/네이티브 빌드, 새 계약/실행 검사와 기존 준비·더미·분석 회귀, 원본 정책 대조를 기록합니다. 전체 제품 회귀·웹 E2E 검사를 대신하지 않습니다. C++는 MSVC의 경고 오류 처리로 검사하고 TypeScript/JS는 기존 ESLint/Prettier 범위로 검사합니다.

## 보안 한계와 다음 단계

이 도구는 신뢰된 로컬 개발 코드의 점검 도구이며, 악성 호스트·동시 경로 교체에 안전한 OS 보안 경계가 아닙니다. 소스/해시 대조와 링크 거절은 경합 방어의 완성을 뜻하지 않습니다. 빌드 영수증은 서명/인증서가 아니며, 호출자가 지정한 해시와 현재 로컬 코드를 신뢰합니다.

PE에서 x64 콘솔·ASLR/NX/CFG 표시를 검사하고 dumpbin의 CFG 계측/함수 테이블도 시험합니다. 이는 실제 공격 방어·파일/통신 차단 증명이 아닙니다. 정적 CRT를 포함한 산출물의 KERNEL32 imports에는 `CreateFileW`, `LoadLibraryExW`도 있습니다. 소스 본문이 stdio만 다룬다고 전체 런타임의 파일 접근 가능성이 제거된 것은 아닙니다. SDK 헤더/라이브러리·도구 종속 DLL 전체 해시, 실행 중 API 추적, 서명/재현 빌드도 미검증입니다.

다음은 **실제 파일 접근을 시도하는 고정 probe와 LPAC 실행기**의 구현·단계별 검사입니다. 현재 검증기 결과를 실제 접근 거절/허용 결과로 재사용하면 안 됩니다. AppContainer 프로필·SID/OS 저장소·정확한 ACL·Job/핸들·필수 읽기 목록·종료/복구를 해소하고, OS 변경의 대상과 부작용에 대한 별도 승인 후에만 실제 격리 시험을 수행합니다. [외부 경계 설계](ANALYSIS_OUTER_BOUNDARY.md)를 유지합니다.

미검증: 실제 OS 생성/LPAC 파일·통신·자식 차단/복구, 실제 대상 probe, 악성 자식에 대한 호스트 감시 경로의 독립 장애 주입, 실제 Codex 기동·설정·인증·모델/사용량, 다른 PC/런타임, 전체 제품 UI/장기 운영, 실자료/수익성. 계좌/실주문·기존 거래 정책은 연결하거나 변경하지 않습니다. 시험 파일은 자동 삭제하지 않으며 OS 프로필/권한 변경은 없어서 해당 복구 작업도 없습니다.
