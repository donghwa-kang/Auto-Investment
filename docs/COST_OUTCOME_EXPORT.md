# 비용·학습 보류 근거 내보내기와 재생 검증 — D2

_2026-09-24 · 명시 합성 V3 실행의 개발자용 JSON. 학습 자료 승인·실계좌 성과·서명 인증 기능이 아니다._

---

## 📋 제공 범위

[기존 D1 보고](COST_OUTCOME_REPORT.md)의 근거를 `SYNTHETIC_COST_HOLD_EXPORT_V1` 파일로 보관하고, 원장 DB 없이 같은 명령을 재생해 보고와 일치하는지 검증한다. 초기 설정, 최초 epoch, 전체 확정 명령/영수증, 비용·미결제·미완료·종료 결과, HOLD 사유를 보존한다. 성공 결과도 `HOLD`, 주문/학습/LIVE 허용은 모두 false다. 운영비·학습 라벨·모델 교체·앱 UI·HTTP/CLI 명령은 연결하지 않는다.

V1/V2 원장을 이 형식으로 자동 변환하지 않는다. 기존 `npm run learning:export`/`learning:convert`는 구형 기능이고 D2 명령이 아니다. D2 파일을 구형 학습기에 넣지 않는다.

## 🔍 포착과 검증의 경계

| 단계 | 입력과 검사 | 보장하지 않는 것 |
| --- | --- | --- |
| `store.exportEvidence()` | 기존 Store의 한 BEGIN/COMMIT 안에서 설정·명령·영수증·상태·승인·체결 인덱스·DB 감사를 대조하고 같은 state/records/최초 epoch로 포착 | 임의 사용자 DB를 여는 전체 과정의 무변경 |
| `saveCostOutcomeExport(value, anchor, base)` | 재생 검증 후 새 로컬 하위 디렉터리에 JSON 저장 | 외부 업로드·암호화·백업·공격자에 대한 OS 격리 |
| `verifyCostOutcomeExportFile(path, anchor)` | 제한 크기 UTF-8 JSON을 읽고 독립 기준과 명령 재생·D1 보고를 비교 | 서명·브로커 원본 인증·실제 시장 이력 완전성·최신성 |

포착은 `read()`와 `report()`를 따로 호출하지 않는다. 기존 `decode()`가 읽은 확정 자료로 보고까지 생성하며 SQL 쓰기·writer lease 갱신은 하지 않는다. `Repository` 생성자의 스키마 준비와 종료 시 lease 해제 쓰기는 별개다. JSON 재검증기는 Repository/SQLite를 열지 않는다.

독립 검증은 **DB와 저장된 파생 보고에 의존하지 않는 재생**이다. 기존 `initialHandoff`/`applyHandoffCommand`와 D1 집계를 재사용하므로 별도 수학 구현으로 금융 모델 자체를 입증한 것은 아니다. DB 감사 원문은 파일에 포함하지 않는다. 포착 시 DB 감사는 검사하지만, 파일 검증에서 DB 감사 사슬을 다시 검사한다고 표현하지 않는다.

검증에는 동일 버전의 실행 코드와 변경되지 않은 원본 정책 파일이 필요하다. JSON 한 개만으로 실행 가능한 독립 프로그램이 아니며 임의 버전 사이의 마이그레이션은 제공하지 않는다.

## 🔐 신뢰 기준과 실패 처리

검증자는 대상 파일과 별개로 신뢰하는 `anchor.config`(원래 `OutcomeConfig`)와 `anchor.exportHash`를 반드시 제공한다. 파일의 설정은 이 신뢰 설정의 해시와 비교만 하고, 재생에는 신뢰 설정을 사용한다. 외부 JSON의 State를 타입 단언으로 신뢰하지 않는다.

`exportHash`는 본문의 정렬 JSON 해시다. 들여쓰기 같은 바이트 차이는 허용하지만 필드·값·순서·명령 수·보고 변경은 대조한다. 명령 ID 중복, 순서 변경, expectedRevision/stateHash 불일치, epoch 역행, 중복 체결, 영수증 불일치는 정렬·보정·제거하여 수용하지 않는다. 외부 report는 반환하지 않고 재생으로 다시 만든 보고만 반환한다. 따라서 같은 합계여도 근거가 다르면 수용하지 않는다.

**대상 파일에서 config와 exportHash를 읽어 그대로 anchor에 넣으면 독립 기준이 아니다.** 신뢰된 Store 포착 시 기준을 별도 보관하고, 재검증 때 신뢰 경로로 전달해야 한다. 현재 자동 기준 저장소·서명·키 관리·최신 체크포인트 서비스는 없다. 파일과 기준 해시를 모두 바꿀 수 있는 공격자는 새 일관된 이력을 만들 수 있다. 과거 자료도 당시 기준을 주면 검증되므로 최신성 보장은 없으며, 최신 기준을 지정했을 때 이전 스냅샷 대체만 거절한다.

파일 경계는 최대 16 MiB, JSON 깊이 64, 노드 500,000개, 명령 5,200개다. 비유한 숫자·지원하지 않는 버전/필드/허용 플래그는 거절한다. 크기는 읽기 전과 읽는 중 모두 제한한다. 금융 규칙의 한도나 TTL을 바꾼 값이 아니라 새 내보내기 계약의 입력 상한이다. 큰 정상 원장도 바이트/노드 한도를 넘으면 저장·파일 검증이 거절될 수 있고, 원장을 지우거나 일부 명령만 잘라서 수용하지 않는다. 이 상한 전부를 동시에 채운 성능·메모리 부하는 미검증이다. 실패는 데이터/경로 원문을 노출하지 않는 코드로 반환하고 원장 복구나 부분 학습을 시도하지 않는다.

## 💾 파일과 개발자 사용

기존 로컬 `base` 아래 `data/cost-hold-exports/run-*/result.json`에 매번 새 파일을 쓴다. 검증 실패 때 디렉터리를 만들지 않으며, 기존 파일을 덮어쓰지 않는다. `result.partial`을 exclusive create 후 flush/close하고 완성 이름으로 바꾼다. 중간 실패/전원 차단 시 빈 디렉터리나 partial이 남을 수 있으며 자동 삭제하지 않는다. 검증기는 partial을 입력으로 받지 않는다. 디렉터리 메타데이터의 전원 차단 내구성까지 보장한 것은 아니다.

일반 로컬 파일/디렉터리만 지원한다. UNC/URL/장치 경로·드라이브 상대 경로·ADS 및 발견된 심볼릭 링크/정션 경로를 거절한다. 쓰기 권한을 가진 별도 프로세스의 동시 디렉터리 치환까지 방어하는 OS 격리 장치는 아니다. 실제 계좌 자료나 키를 이 파일에 넣지 않는다.

프로젝트 루트 PowerShell, 기존 설치/런타임 조건은 [README](../README.md)를 따른다.

```powershell
npm run build:engine
node --test --test-concurrency=1 dist/runtime/tests/cost-outcome-export.test.js
```

아래 JavaScript는 빌드 후 `node --input-type=module` 표준 입력으로 실행한다. 새 메모리 합성 Store와 OS 임시 디렉터리를 쓰며 사용자 DB/계좌에 연결하지 않는다. 예제는 신뢰 기준을 파일에서 읽지 않고 포착 시 메모리에 별도로 보관한다.

```javascript
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openedOutcome, beginTrade, fillTrade, closeTrade } from "./dist/runtime/tests/cost-outcome-helpers.js";
import { saveCostOutcomeExport, verifyCostOutcomeExportFile } from "./dist/runtime/src/server/cost-outcome-file.js";

const { repo, store, c } = openedOutcome();
let artifact;
try {
  const run = beginTrade(store);
  fillTrade(store, run);
  closeTrade(store, run, "10100");
  artifact = store.exportEvidence();
} finally {
  repo.close();
}
const anchor = { config: c, exportHash: artifact.exportHash };
const base = mkdtempSync(join(tmpdir(), "cost-hold-example-"));
const path = saveCostOutcomeExport(artifact, anchor, base);
const checked = verifyCostOutcomeExportFile(path, anchor);
const krw = checked.report.report.currencies.find((v) => v.currency === "KRW");
console.log(krw.closedTradingNetPnlNative, krw.allFillFees,
  checked.status, checked.learningAllowed);
```

기대 출력 `80 20 HOLD false`는 가상 매수 10,000원·매도 10,100원·왕복 비용 20원의 결과이지 실제 기대 수익이 아니다. 종료 뒤에도 임시 예제 파일은 남는다.

## 📌 검사와 남은 작업

[전용 시험](../tests/cost-outcome-export.test.ts)은 KR/US·미완료/미확정/미결제·부분 체결·손실 FX 보류 보존, 원장 읽기 전용, 동시 writer 중 확정 스냅샷, 재취득 epoch, 재생 변조·누락·파일 경계를 검사한다. 실제 실행 횟수/중간 실패/회귀 결과는 [PROGRESS · 공개 요약](PROJECT_STATUS.md)에 구분해 기록한다.

자동 학습·새 학습 입력 변환·미결정 운영비 `OC-U01`~`OC-U08`·기준의 장기 신뢰 보관·공용 앱 활성화는 미완료다. 최대 부하·새 설치·전원 차단·공격적 OS 파일 치환·실제 자료/요율/계좌/수익성은 미검증이다. 후속 [D3 학습 입력 사전 계약](COST_LEARNING_INPUT_CONTRACT.md)은 현재 자료의 공백과 다음 인수 조건을 정리했다. 다음 한 작업은 **DEV-D03 내부 D4 읽기 전용 학습 준비도 진단기**이며 미결정 운영비/라벨을 임의 확정하거나 모델 학습을 켜지 않는다. D2/D3만으로 D03-03/04를 완료 처리하지 않으며 API 키는 필요 없다.
