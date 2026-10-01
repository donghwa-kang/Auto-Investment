# 분석 실행 준비 — 변경 명세 생성·읽기 전용 재검증

**실제 OS 실행이 없는 개발용 CLI**입니다. [부모 격리 설계](ANALYSIS_OUTER_BOUNDARY.md)의 고정 경로·권한 의도·자원 한도를 명세로 만들고, 별도로 지정한 해시와 현재 코드/더미 입력을 대조합니다. 현재 모의매매 화면·장부·학습 실행과 연결하지 않습니다.

제공 범위는 명세 생성/검증과 실행 요청 거절입니다. 네이티브 LPAC 실행 파일, 프로필/SID 생성, ACL/방화벽/Job 설정, Codex 기동·인증·모델 연결은 없습니다. **검증 성공은 실행 승인이나 실제 접근 차단 성공이 아닙니다.**

## 실행하기

프로젝트 루트에서 기존 [실행 환경](../README.md#실행-환경)을 사용합니다. 이 CLI는 Windows + Node 24.20.0만 허용하며, 기존 의존성과 work 폴더가 필요합니다. 새 패키지·로그인·API 키·서버·SDK 설치는 필요 없습니다.

```powershell
npm run build:engine
node dist/runtime/src/server/analysis-launch-cli.js prepare
```

성공하면 새 `work/analysis-launch-plans/plan-<run-id>/`에 `approved-input.txt`와 `manifest.json` **2개만** 생성합니다. 입력은 이번 도구가 만든 고정 형식의 더미 문자열이며 실제 매매/개인 자료를 읽거나 변환하지 않습니다. 실패한 묶음도 자동 삭제하지 않고, 다음 prepare는 새 ID를 사용합니다.

출력의 `runId`와 `manifestSha256`를 보존한 뒤 다음 형식으로 재검증합니다. 아래 자리표시자는 앞서 출력된 값으로 바꿉니다. 명세 파일에서 방금 다시 계산한 값으로 원래 해시를 대체하면 변경 탐지 목적이 약해집니다.

```powershell
node dist/runtime/src/server/analysis-launch-cli.js check <run-id> <manifestSha256>
```

PowerShell에서 새 준비와 재검증을 이어 실행하려면 다음 실제 명령을 사용할 수 있습니다. 실패했으면 재검증하지 않습니다.

```powershell
$launchPreparation = node dist/runtime/src/server/analysis-launch-cli.js prepare | ConvertFrom-Json
if ($LASTEXITCODE -eq 0) {
    node dist/runtime/src/server/analysis-launch-cli.js check $launchPreparation.runId $launchPreparation.manifestSha256
}
```

CLI는 현재 작업 디렉터리의 임의 프로젝트가 아니라 **실행 파일이 속한 프로젝트**를 기준으로 합니다. 임의 파일/출력 경로·사용자 입력 자료를 받지 않습니다. 준비 결과의 절대 경로는 로컬 표시용이며 외부 전송 기능은 없습니다.

## 정상 결과와 실패

| 결과 | 의미 |
| --- | --- |
| prepare: PREPARED_NOT_EXECUTABLE, exit 0 | 새 명세/더미 생성 후 재검증 성공. 실제 실행 불가 |
| check: PLAN_VALID_EXECUTION_LOCKED, exit 0 | 지정 해시·고정 규칙·현재 코드/더미 대조 성공. 묶음/예정 실행 경로에 쓰지 않음 |
| executionAllowed=false / actualOsTests=NOT_RUN | 명세에 제한 값이 있어도 실제 OS 집행을 수행하지 않음 |
| ANALYSIS_LAUNCH_PREPARATION_REJECTED, exit 1 | 잘못된 인자·환경/자료/경로·권한·누락 등으로 실패. 원문 오류/입력값은 출력하지 않음 |

`execute`, `approve`, `setup`, `--execute`, 추가 인자·임의 경로는 **파일 작업 전에 거절**합니다. 실행을 켜는 옵션이나 승인값 입력 기능은 없습니다. 실패가 자료 변경/누락 때문이면 보존한 값과 설치 상태를 확인하고 새 prepare를 사용하세요. 사용자 파일 권한 변경/전체 접근 모드로 해결하지 않습니다.

## 명세에 들어가는 것

- UUID 기반 새 run 경로와 61자 전용 프로필 이름 제안. 실제 AppContainer 존재/충돌은 조회하지 않아 NOT_RUN입니다.
- bin/input/private/scratch/profile/evidence 6개 하위 경로와 권한 **의도**. 현재 ACL은 null, 실효 권한 확인은 false입니다. 예정 OS 경로는 만들지 않습니다.
- 더미 입력의 길이/해시·형식, 컴파일된 준비 코드 3개와 package-lock.json의 SHA-256, 고정 Node/플랫폼 조건.
- 별도 네이티브 실험의 예정 한도: 프로세스 1개, commit 128MiB, 사용자 CPU 2초, wall-clock 10초, 출력 8KiB, 추가 자식/네트워크 capability 금지. 이 CLI 자체에 Job/CPU 제한을 적용했다는 뜻은 아닙니다.
- 미생성 SID/프로필 저장소·네이티브 실행 파일은 null. 빌드/필수 시스템 읽기·ACL·승인/실제 OS 검사·Codex 설정 호환성 미확정을 명시합니다.

실행 코드/잠금 파일이 바뀌면 기존 명세 재검증이 실패하므로 새 prepare가 필요합니다. 네이티브 실행 파일이나 모든 설치된 의존성의 무결성을 검증하는 기능은 아닙니다. 입력/코드 해시는 승인 서명·사용자 신원·OS 증명도 아닙니다.

## 검증 경계

명세는 최대 32KiB의 UTF-8과 엄격한 필드를 사용합니다. BOM·중복 키·추가 JSON·다른 직렬화/키 순서도 거절하므로 손으로 수정하거나 자동 포맷하지 마세요. 주어진 프로젝트/run-id에서 명세를 독립 재구성해 대상·순서·권한·한도·미확정/잠금 필드까지 대조합니다. 실행 허용으로 수정한 뒤 해시를 다시 계산해도 통과하지 않습니다.

준비 코드 읽기는 파일별 크기를 제한하고 동일한 열린 핸들의 종류/크기/파일 ID·수정 시각을 확인합니다. 관측한 junction/심볼릭 링크·다중 hardlink·정규화되지 않은 경로·UNC/장치/ADS·예약 이름·끝 공백/점·220자 초과 경로는 거절합니다. 준비 폴더에 예상 밖 항목이 있어도 재검증을 거절합니다. 실제 OS 실행 부모가 링크이거나 예정 run이 이미 존재하면 실패하며 삭제/권한 수정을 하지 않습니다.

이 점검은 신뢰하는 로컬 사용자/프로젝트에서의 **준비 도구 방어**입니다. 악성 호스트의 동시 경로 교체·모든 재분석 지점·동일 사용자에 의한 코드와 증거 전체 교체·독립 OS 접근 차단을 보장하지 않습니다. 미래 네이티브 실행기는 실행 직전에 핸들/권한/승인을 다시 확인해야 하고 이 준비 결과만 신뢰해서는 안 됩니다.

## 코드와 검사

구현은 [명세/고정 규칙](../src/core/analysis-launch-plan.ts), [파일 준비/읽기 전용 대조](../src/server/analysis-launch-files.ts), [준비 전용 CLI](../src/server/analysis-launch-cli.ts), [시험](../tests/analysis-launch-plan.test.ts)에 분리했습니다. 기존 모형 실행기/거래 엔진을 바꾸거나 이 코드에서 자식 프로세스를 실행하지 않습니다. 개별 검사는 다음과 같습니다.

```powershell
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/analysis-launch-plan.test.js
```

관련 회귀를 포함한 이번 개발 검사는 `node work/verify-analysis-launch.mjs`입니다. 타입·린트·형식·엔진 빌드, 새 준비 도구 시험과 명시된 기존 분석/더미 회귀, 원본 파일 대조를 수행합니다. 원래 더미 도구의 통상 파일 연산/제한 없는 Node 자식 자기검사도 포함하지만 **LPAC 실행이나 Codex 모델 실행은 아닙니다.** 자동 시험은 자체 생성한 시험 프로젝트 복사본/더미 파일만 사용합니다.

## 빌드 도구와 다음 단계

최신 후속은 [파일 접근 시험기·잠긴 격리 실행 코어](ANALYSIS_FILE_PROBE.md)입니다. 실제 더미 파일 연산과 모형 실행 흐름을 시험하며 준비 명세의 승인/실효 권한/null 값은 변경하지 않습니다. 실제 OS 적용·프로필/ACL 준비는 아직 미완료입니다. 아래는 각 준비 단계 당시의 기록입니다.

이번 읽기 전용 조회에서 Visual Studio 2022 Community의 MSVC 14.39.33519 설치 경로, x64 cl/link 파일, Windows SDK 10.0.22621.0의 userenv.h/Userenv.Lib를 확인했습니다. 특정 설치 파일 5개 크기/해시를 별도 개발 기록에 보존했습니다. **컴파일/링크/네이티브 실행은 하지 않았으며 오프라인 빌드 가능성이 확정된 것은 아닙니다.** 일반 사용자에게 이 도구를 설치하도록 요구하는 기능이 아닙니다.

2026-09-15 후속으로 [네이티브 요청 검증기](ANALYSIS_NATIVE_VALIDATOR.md)의 C++ 소스·오프라인 빌드·실제 stdio 검사를 추가했습니다. 위 도구 조회 기록 이후의 별도 작업이며, prepare/check 자체는 기존처럼 자식 프로세스를 실행하지 않습니다. 새 검증기는 전체 명세/파일을 네이티브로 검증하거나 실제 접근을 시도하는 probe/LPAC 실행기가 아닙니다. 해당 구현과 실제 LPAC 프로필 생성/ACL·Job 설정·파일 접근 시험은 남아 있습니다. 실제 OS 적용은 별도 승인과 구체 변경 목록 확인 뒤에 진행하며 이 준비 명세에서 null로 남긴 SID/저장소/실효 권한을 임의 값으로 채워 실행하지 않습니다.

미검증: 실제 LPAC/파일·네트워크 차단·종료/복구·경합 방어, 새 PC/다른 Node/OS, 전체 제품 회귀/웹 E2E, 실제 Codex 기동·설정·인증/모델/사용량, 실자료/투자 성과. 현재 계좌 연결·실주문·거래 기준 변경은 없습니다. 실제 실행 결과·실패·문서 점검은 [PROGRESS · 공개 요약](PROJECT_STATUS.md)에 구분해 기록합니다.
