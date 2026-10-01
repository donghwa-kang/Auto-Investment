# 네이티브 파일 접근 시험기·잠긴 격리 실행 코어

새 더미 파일에 실제 읽기·쓰기·생성·삭제·이름 변경을 시도하는 C++ 시험기와, 격리 실행 순서를 확인하는 개발용 도구입니다. **파일 연산은 일반 프로세스에서 실제 시험하지만, LPAC/Job 실행은 아직 잠겨 있습니다.** 실제 사용자 파일·증권 키·계좌·모델·실주문을 사용하지 않습니다. 기본 웹 앱에 연결된 기능이 아닙니다.

기존 [요청 형식 검증기](ANALYSIS_NATIVE_VALIDATOR.md)는 그대로 유지합니다. 이번 도구는 해시를 회신하는 형식 검사에서 더 나아가 실제 더미 파일 연산과 호스트의 전후 자료 비교를 제공합니다. 그 결과를 OS 차단 검증과 혼동하지 않습니다.

## 구현과 미완료 범위

| 구성 | 현재 구현·검사 | 아직 하지 않은 것 |
| --- | --- | --- |
| 파일 접근 시험기 | C++ 빌드·실제 7종 더미 연산·오류/결과 보고 | LPAC 안에서의 실제 접근 허용/거절 |
| TypeScript 호스트 | 코드/빌드/자료 대조, 새 fixture, 고정 자식 실행, 결과/전후 파일 비교 | 실제 OS 승인 해석·프로필/ACL 배치·격리 결과 중계 |
| 실행 순서 코어 | 준비→Job→파이프→시작 속성→정지 생성→신원 확인→재개→통신→종료, 단계별 실패/정리 모형 | 실제 OS 자원으로의 성공·실패·종료 수용검사 |
| Win32 백엔드 | LPAC/Job/stdio/토큰/제한/종료 코드 컴파일·링크 | 해당 백엔드의 실행, 프로필 생성/삭제, ACL 적용·복구 |

Win32 백엔드 코드가 존재한다고 실행 가능한 격리 제품이 완성된 것은 아닙니다. 프로필·권한을 준비하는 단계와 실제 OS 동작 확인이 남아 있습니다. 환경변수·CLI 인자·JSON 승인값으로 이 빌드의 잠금을 해제할 수 없습니다.

## 실행 환경과 빠른 시작

현재 검증 대상은 Windows x64, Node **24.20.0**, 설치된 MSVC 폴더 **14.39.33519**, Windows SDK **10.0.22621.0**입니다. cl.exe 19.39.33523.0, link.exe/dumpbin.exe 14.39.33523.0의 절대 경로·해시를 고정합니다. 다른 PC/도구 버전을 지원한다고 확인한 것은 아닙니다. 설치 도구가 없거나 해시가 다르면 중단하고 자동 설치·다운로드·권한 상승으로 전환하지 않습니다.

기존 프로젝트 의존성 설치를 마친 뒤 **프로젝트 루트의 PowerShell**에서 실행합니다. 기본 앱 설치 방법은 [README](../README.md#빠른-시작)를 따릅니다.

```powershell
npm run build:engine
if ($LASTEXITCODE -ne 0) { throw '엔진 빌드 실패' }

$fileProbeBuild = node scripts/build-analysis-file-probe.mjs | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '파일 시험기 빌드 실패' }

node dist/runtime/src/server/analysis-file-probe-cli.js self-test $fileProbeBuild.buildId $fileProbeBuild.buildSha256
if ($LASTEXITCODE -ne 0) { throw '파일 시험기 자기검사 실패' }
```

정상 출력은 종료 코드 0, `FILE_PROBE_SELF_TEST_PASSED`, `fileCases=7`, `modelCases=23`, `actualOsTests=NOT_RUN`, `osIsolationVerified=false`, `realCodexEnabled=false`, `liveOrdersEnabled=false`입니다. `reportPath`에 세부 결과 파일이 표시됩니다. API 키·인증·인터넷 자료 입력은 필요 없습니다.

준비된 기존 계좌나 웹 실행을 시험하는 명령이 아닙니다. `execute`, `setup`, `approve`, 추가 인자·임의 exe/파일 경로는 거절합니다. `analysis-file-probe.exe`를 사용자 폴더에서 직접 실행하거나 보호 대상 파일을 넣어 시험하지 마세요. 제공 CLI가 생성한 더미 자료만 사용합니다.

### 생성되는 파일

- `work/analysis-file-build/build-<UUID>/`: 고정 exe 2개, obj 3개, 빌드 영수증, PE headers/imports/loadconfig와 빌드 명령 결과.
- `work/analysis-file-build-temp/build-<UUID>/`: 빌드 도구 전용 TEMP/TMP. 실행 파일 보관 위치와 분리합니다.
- `work/analysis-file-lab/run-<UUID>/`: 각 시험에 새로 만든 marker·manifest·input/private/scratch 더미 파일. 한 자기검사는 7개 독립 fixture를 만듭니다.
- `work/analysis-file-checks/check-<UUID>/`: 개별 결과와 집계 report.json. 실패한 시도 경로도 attemptedFixtures에 남습니다.

기존 디렉터리/결과를 덮어쓰지 않습니다. 삭제·이름 변경은 해당 새 fixture의 지정 더미 파일에만 적용하며 폴더 전체를 삭제하지 않습니다. 더미 원문은 고정 생성 함수로 재생성할 수 있고 해시/명세/보고서는 보존됩니다. 별도 정리나 OS 프로필 삭제는 자동 수행하지 않습니다.

빌드 도구가 `Microsoft/VSApplicationInsights` 임시 파일을 생성한 사례를 확인했습니다. 내용은 읽지 않았으며 이런 파일을 실행 파일 폴더의 허용 목록에 추가하지 않았습니다. 도구 임시 위치를 분리했고 예상 밖 빌드 산출물이 있으면 성공 영수증을 만들지 않습니다. 직접 작성한 빌드/시험 코드는 다운로드·서비스 요청을 하지 않지만, 외부 도구 내부의 통신/파일 접근 전체를 추적한 것은 아닙니다. 전역 Visual Studio 설정·방화벽은 변경하지 않습니다.

## 7종 연산과 결과 의미

| 시험 | 고정 대상 | 실제 시도 | 제한 없는 자기검사의 정상 관측 |
| --- | --- | --- | --- |
| ALLOW_READ | input/allow.txt | 읽고 SHA-256 보고 | ALLOW_OBSERVED |
| ALLOW_WRITE | scratch/write.txt | 쓰기 전용 추가 | ALLOW_OBSERVED |
| DENY_READ | private/read.txt | 실제 읽기 | EXPOSURE_DETECTED |
| DENY_APPEND | private/append.txt | 쓰기 전용 추가 | EXPOSURE_DETECTED |
| DENY_CREATE | private/create.txt | CREATE_NEW·고정 더미 쓰기 | EXPOSURE_DETECTED |
| DENY_DELETE | private/delete.txt | DELETE 권한 열기·핸들 기준 삭제 표시 | EXPOSURE_DETECTED |
| DENY_RENAME | private/rename.txt → renamed.txt | 핸들 기준 변경·대상 덮어쓰기 금지 | EXPOSURE_DETECTED |

‘DENY’는 향후 격리에서 금지할 시험 종류입니다. 지금은 ACL/LPAC 제한을 적용하지 않아 성공하면 **노출 감지**가 정상입니다. 실제 OS가 차단했다는 뜻이 아닙니다. 호스트는 결과 주장뿐 아니라 모든 지정 파일의 실제 전후 해시/존재 상태도 비교합니다. 자기검사 통과에는 연산별 예상 변화가 정확히 일치해야 합니다.

쓰기 시험은 대상 내용을 먼저 읽지 않고 `FILE_APPEND_DATA`로 엽니다. 파일 신원 확인용 메타데이터 권한과 데이터 읽기를 구분합니다. 생성은 기존 파일을 덮어쓰지 않고, 삭제/이름 변경은 열린 파일의 위치·종류·재분석 지점·hardlink 수를 확인한 뒤 수행합니다. [파일 권한](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights), [핸들 기준 파일 변경](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle).

`ERROR_ACCESS_DENIED`(5)가 OPEN 또는 IO 단계에서 보고되고 자료가 변하지 않은 경우만 `DENIAL_REPORTED_NOT_OS_ATTESTED`로 분류합니다. 이 분류도 OS 격리 합격이 아닙니다. 파일 없음·공유 충돌·잘못된 marker·링크 방어·크기 초과 등은 접근 거절 합격으로 세지 않습니다. 잘못된 해시·결과 누락·모순·허용 연산 실패는 보류합니다. 부정 시험에서 파일이 바뀌면 거절 주장보다 노출 관측을 우선합니다.

## 고정 입력·자원 한계

시험기 입력은 버전, UUIDv4, 시험 종류, 명세 SHA-256, `GENERATED_DUMMY_ONLY`, `NO_OS_ATTESTATION`, `END`로 구성된 LF 끝 ASCII 7행입니다. 임의 경로·명령·뉴스 원문을 전달하지 않습니다. 실제 명세/자료 진위 확인은 호스트 책임이며 시험기는 접근 가능한 고정 root marker만 확인하고 비허용 대상의 내용을 사전에 읽지 않습니다.

입력은 384바이트 상한·EOF 5초 기한, 결과는 호스트에서 2KiB 상한·7초 감시·stderr/비정상 종료 거절입니다. 읽기 자료는 4KiB 상한입니다. UUID·해시·시험 종류·요청 해시 및 결과 바이트 형식을 대조합니다. 재시도나 실제 모델로의 대체 실행은 없습니다.

네이티브 probe는 0=연산 결과 보고 완료(성공/오류 결과 모두 포함), 2=명령 거절, 3=입출력/요청/EOF 기한 실패, 5=출력 실패, 6=처리 실패입니다. **프로세스 종료 0만으로 연산 성공이나 차단 성공을 판단하지 않습니다.** 상위 CLI는 보고서 집계가 정상일 때만 0, 보류/입력 거절이면 1입니다.

## 격리 실행 코어의 잠금과 미활성 백엔드

`analysis-isolation-controller.exe`는 `--self-test`만 받습니다. Model 백엔드에서 정상 흐름, 9개 단계 각각의 실패 반환/예외, 정리 실패, 미승인 요청, Win32 종류의 잘못된 모형 요청과 실제 링크된 Win32 인스턴스의 실행 잠금을 확인합니다. 총 23개 모형 사례입니다. `win32StepsExecuted=0`은 **격리 백엔드 단계 미실행**을 뜻하며 파일 시험기의 Win32 파일 API까지 미실행이라는 뜻이 아닙니다.

Win32 백엔드에 작성한 내용은 다음과 같습니다. **아래 API를 실제 자원에 적용해 검증하지는 않았습니다.**

- 예정 OS run 경로/고정 probe 해시·핸들 신원 확인, 재분석 지점/다중 링크 거절, 디렉터리 및 실행 파일 핸들 유지. 고유 프로필 이름에서 계산한 SID와 제공 SID 대조. 이 계산은 프로필 실재·소유권·ACL 적합성 검증을 대신하지 않습니다.
- 일회 Job: 활성 프로세스 1, Job commit 128MiB, 사용자 CPU 시간 2초, 마지막 Job 핸들 닫기 시 종료. 설정값 재조회. 현재 일반 자기검사 프로세스에 이 한도를 적용한 것은 아닙니다.
- stdio 3개 핸들만 명시 상속, capability 0개, ALL_APPLICATION_PACKAGES opt-out, 자식 생성 금지, 시작 시 Job 목록 지정.
- 정지 상태 생성 → Job 소속·LPAC/AppContainer SID·capability·낮은 무결성·자식 제한 확인 → 재개. 불일치/미지원 시 약한 격리나 breakaway로 전환하지 않음.
- 고정 환경/실행 파일/인자, 시간 10초·출력 8KiB 감시, stderr·비정상 종료 거절. 소유한 Job/자식만 종료하고 자식 종료·Job 활성 수를 확인한 뒤 핸들을 정리. 정리 실패를 성공으로 처리하지 않음.

구현 근거: [시작 속성/핸들·Job 목록](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), [토큰 정보](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class), [Job 한도](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information). 앞의 제한은 Windows API 코드/설계 내용이지 실제 효력 관측이 아닙니다.

## 검사 명령과 코드 위치

빠른 시작에서 생성한 `$fileProbeBuild` 변수가 유지된 PowerShell에서 실행합니다.

```powershell
node --test --test-concurrency=1 dist/runtime/tests/analysis-file-probe.test.js
node scripts/test-analysis-file-probe.mjs $fileProbeBuild.buildId $fileProbeBuild.buildSha256
```

첫 명령은 입력/영수증·오류 분류·예상 상태·CLI 계약을 검사합니다. 두 번째는 실제 파일 연산, 실행 잠금, 잘못된 입력/EOF 기한, marker/크기/중복 대상·hardlink/junction·소스/빌드/자료 변조 등을 시험합니다. 내부의 23개 실행 흐름 사례는 **모형 검사**이며 실제 토큰/Job 검사가 아닙니다. 세부 결과는 새 `work/fp-test-*/report.json`에 저장합니다.

개발 인계용 `node work/verify-analysis-file-probe.mjs`는 타입·린트·형식·엔진/네이티브 빌드·신규 검사/CLI·기존 관련 회귀·원본 정책 대조를 실행합니다. 이전 네이티브 검증기의 고정 빌드도 현재 소스/해시와 다시 대조해 시험하며, 해당 빌드가 없는 새 환경은 기존 검증기 안내로 별도 준비해야 합니다. 전체 제품 회귀·웹 E2E를 대신하지 않습니다.

구현은 [파일 시험기](../src/native/analysis-file-probe.cpp), [실행 순서 코어](../src/native/isolation-lifecycle.hpp), [미활성 Win32 백엔드](../src/native/isolation-win32.cpp), [호스트 파일/실행 관리](../src/server/analysis-file-probe-files.ts), [계약·결과 분류](../src/core/analysis-file-probe.ts)에 분리했습니다. 기존 거래 엔진·모형 분석·정책 파일은 변경하지 않습니다.

## 다음 단계와 미검증

2026-09-15 후속 [권한 검토·복구 판단](ANALYSIS_PERMISSION_PREPARATION.md)에서 고정 파일 시험용 최소 권한과 16개 예정 대상을 구체화하고 Windows 보안 설명자 메모리 검사·복구 모형을 추가했습니다. 별도 [잠긴 ACL 어댑터·영속 시험 기록](ANALYSIS_PERMISSION_JOURNAL.md)은 적용/원복 코드 빌드와 모형 디스크 기록을 제공합니다. 실제 OS 기록 연결·프로필 저장소 확인 및 적용/복구 수용은 미완료입니다. 아래는 파일 시험기 구현 당시의 다음 단계입니다.

다음은 **프로필·ACL 준비/검증·원복 코드와 실제 적용 승인 명세**입니다. 준비된 SID 문자열만으로 기존 프로필을 재사용하거나, 명세의 null을 임의 값으로 채워 실행하지 않습니다. 정확한 새 대상·프로필 저장소 영향·권한 변경/정리 범위를 해소해 별도 승인을 받은 뒤 실제 파일 전용 OS 시험을 진행합니다. [외부 경계 설계](ANALYSIS_OUTER_BOUNDARY.md)의 조건을 유지합니다.

미검증: 실제 Win32 백엔드의 토큰/Job/상속 핸들·시간/자원 한도·부모 종료/정리, 프로필 생성/ACL 효력/삭제와 잔류 복구, 네트워크/자식 차단, 동시 경로 교체 방어, 기존 Home OS의 LPAC 호환성, SDK/도구 종속 DLL 전체 무결성·공급망/통신 추적, 다른 PC/런타임, 실제 Codex 인증·설정·모델·사용량, 전체 제품 UI·실자료/투자 성과. 입력 경로 점검이나 모형 실패 주입은 이 항목들의 실제 검증을 대신하지 않습니다.
