import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash, policyHash } from "../src/core/policy.js";
import {
  OperatingJournalError,
  replayOperatingJournal,
  verifyOperatingJournalView,
  type OperatingJournal,
} from "../src/core/operating-journal.js";

const base = 1_789_344_000_000;
function input(events: OperatingJournal["events"] = []): OperatingJournal {
  return {
    schemaVersion: "OPERATING_JOURNAL_TEST_V1",
    purpose: "TEST_ONLY",
    provenance: "SYNTHETIC_FIXTURE",
    liveEnabled: false,
    runHash: hash("TEST_RUN"),
    policyHash,
    startedAt: base,
    asOf: base + 100_000,
    openingCashKrw: "1000",
    startsEmpty: true,
    complete: true,
    events,
  };
}
const common = (eventId: string, sequence: number) => ({
  eventId,
  sequence,
  occurredAt: base + sequence * 1000,
  availableAt: base + sequence * 1000,
});
const reserve = (
  eventId: string,
  sequence: number,
  obligationId: string,
  amountKrw = "50",
): OperatingJournal["events"][number] => ({
  ...common(eventId, sequence),
  kind: "RESERVE",
  obligationId,
  amountKrw,
});
const recognize = (
  eventId: string,
  sequence: number,
  obligationId: string,
  reservationId: string | null = null,
  amountKrw = "50",
): OperatingJournal["events"][number] => ({
  ...common(eventId, sequence),
  kind: "RECOGNIZE",
  obligationId,
  reservationId,
  amountKrw,
});
const pay = (
  eventId: string,
  sequence: number,
  obligationId: string,
  amountKrw = "50",
): OperatingJournal["events"][number] => ({
  ...common(eventId, sequence),
  kind: "PAY",
  obligationId,
  amountKrw,
});
const release = (
  eventId: string,
  sequence: number,
  reservationId: string,
): OperatingJournal["events"][number] => ({
  ...common(eventId, sequence),
  kind: "RELEASE",
  reservationId,
});
const reject = (raw: unknown, code: string) =>
  assert.throws(
    () => replayOperatingJournal(raw),
    (e) => e instanceof OperatingJournalError && e.code === code,
  );

test("OP-JOURNAL-01 발생과 지급의 순자산 불변·중복 지급 재수신 무효과", () => {
  const recognition = recognize("cost-a", 1, "a");
  const unpaid = replayOperatingJournal(input([recognition]));
  assert.equal(unpaid.cashKrw, "1000");
  assert.equal(unpaid.payableKrw, "50");
  assert.equal(unpaid.netEquityKrw, "950");
  const payment = pay("paid-a", 2, "a");
  const paid = replayOperatingJournal(input([recognition, payment, payment]));
  assert.equal(paid.cashKrw, "950");
  assert.equal(paid.payableKrw, "0");
  assert.equal(paid.netEquityKrw, "950");
  assert.equal(paid.incurredKrw, "50");
  assert.equal(paid.paidKrw, "50");
  assert.equal(paid.obligations[0]!.paymentId, "paid-a");
});

test("OP-JOURNAL-02 A+B 예약에서 A만 의무로 전환", () => {
  const r = replayOperatingJournal(
    input([
      reserve("ra", 1, "a"),
      reserve("rb", 2, "b"),
      recognize("ca", 3, "a", "ra"),
    ]),
  );
  assert.equal(r.reservedKrw, "50");
  assert.equal(r.payableKrw, "50");
  assert.equal(r.netEquityKrw, "950");
  assert.equal(r.availableAfterReservationsKrw, "900");
  assert.deepEqual(
    r.reservations.map((x) => [x.id, x.state]),
    [
      ["ra", "CONVERTED"],
      ["rb", "RESERVED"],
    ],
  );
});

test("OP-JOURNAL-03 동일 ID 재수신·배열 순서 차이는 결과/근거 해시 불변", () => {
  const a = input([
    reserve("ra", 1, "a"),
    recognize("ca", 2, "a", "ra"),
    pay("pa", 3, "a"),
  ]);
  const b = structuredClone(a);
  b.events.push(...structuredClone(b.events));
  b.events.reverse();
  assert.deepEqual(replayOperatingJournal(a), replayOperatingJournal(b));
});

test("OP-JOURNAL-04 동일 비용 ID의 금액/시각/내용 충돌 거절", () => {
  const first = recognize("ca", 1, "a");
  for (const change of [
    { amountKrw: "51" },
    { availableAt: base + 2000 },
    { obligationId: "b" },
    { sequence: 2 },
  ])
    reject(
      input([first, { ...first, ...change }]),
      "OPERATING_JOURNAL_EVENT_CONFLICT",
    );
});

test("OP-JOURNAL-05 별도 이벤트 ID로 같은 의무 두 번 인식 거절", () => {
  reject(
    input([recognize("ca", 1, "a"), recognize("cb", 2, "a")]),
    "OPERATING_JOURNAL_DUPLICATE_OBLIGATION",
  );
});

test("OP-JOURNAL-06 빈틈·중복 sequence는 불완전/상충 기록으로 거절", () => {
  for (const events of [
    [recognize("ca", 2, "a")],
    [recognize("ca", 1, "a"), recognize("cb", 1, "b")],
  ])
    reject(input(events), "OPERATING_JOURNAL_SEQUENCE_INVALID");
});

test("OP-JOURNAL-07 미래·발생 전 가용·초기 이전·소급 이벤트 거절", () => {
  for (const change of [
    { occurredAt: base - 1 },
    { availableAt: base },
    { availableAt: base + 200_000 },
  ])
    reject(
      input([{ ...recognize("ca", 1, "a"), ...change }]),
      "OPERATING_JOURNAL_TIME_OR_LATE_EVENT_UNSUPPORTED",
    );
  reject(
    input([
      recognize("ca", 1, "a"),
      { ...recognize("cb", 2, "b"), occurredAt: base },
    ]),
    "OPERATING_JOURNAL_TIME_OR_LATE_EVENT_UNSUPPORTED",
  );
  reject({ ...input(), asOf: base - 1 }, "OPERATING_JOURNAL_TIME_INVALID");
  reject(
    input([
      { ...recognize("ca", 1, "a"), availableAt: base + 5000 },
      { ...recognize("cb", 2, "b"), availableAt: base + 4000 },
    ]),
    "OPERATING_JOURNAL_TIME_OR_LATE_EVENT_UNSUPPORTED",
  );
});

test("OP-JOURNAL-08 예약 ID·의무·금액 불일치와 누락된 연결 거절", () => {
  for (const cost of [
    recognize("ca", 2, "b", "ra"),
    recognize("ca", 2, "a", "unknown"),
    recognize("ca", 2, "a", "ra", "49"),
  ])
    reject(
      input([reserve("ra", 1, "a"), cost]),
      "OPERATING_JOURNAL_RESERVATION_MISMATCH",
    );
  reject(
    input([reserve("ra", 1, "a"), recognize("ca", 2, "a")]),
    "OPERATING_JOURNAL_RESERVATION_LINK_REQUIRED",
  );
});

test("OP-JOURNAL-09 한 의무의 중복 예약·발생 뒤 예약 거절", () => {
  reject(
    input([reserve("ra", 1, "a"), reserve("rb", 2, "a")]),
    "OPERATING_JOURNAL_OBLIGATION_ALREADY_LINKED",
  );
  reject(
    input([recognize("ca", 1, "a"), reserve("ra", 2, "a")]),
    "OPERATING_JOURNAL_OBLIGATION_ALREADY_LINKED",
  );
});

test("OP-JOURNAL-10 미확인 의무·다른 지급 ID 중복·분할 지급 거절", () => {
  reject(input([pay("pa", 1, "a")]), "OPERATING_JOURNAL_PAYMENT_MISMATCH");
  reject(
    input([recognize("ca", 1, "a"), pay("pa", 2, "a"), pay("pb", 3, "a")]),
    "OPERATING_JOURNAL_PAYMENT_MISMATCH",
  );
  reject(
    input([recognize("ca", 1, "a"), pay("pa", 2, "a", "49")]),
    "OPERATING_JOURNAL_PAYMENT_MISMATCH",
  );
});

test("OP-JOURNAL-11 지급 현금 부족 거절·발생한 채무는 자산 초과여도 숨기지 않음", () => {
  const r = input([recognize("ca", 1, "a", null, "1001")]);
  assert.equal(replayOperatingJournal(r).netEquityKrw, "-1");
  r.events.push(pay("pa", 2, "a", "1001"));
  reject(r, "OPERATING_JOURNAL_INSUFFICIENT_CASH");
});

test("OP-JOURNAL-12 발생 전 예약 해제는 비용/현금 변화 없음", () => {
  const released = replayOperatingJournal(
    input([reserve("ra", 1, "a"), release("xa", 2, "ra")]),
  );
  assert.equal(released.reservedKrw, "0");
  assert.equal(released.incurredKrw, "0");
  assert.equal(released.netEquityKrw, "1000");
  for (const events of [
    [release("xa", 1, "missing")],
    [
      reserve("ra", 1, "a"),
      recognize("ca", 2, "a", "ra"),
      release("xa", 3, "ra"),
    ],
    [reserve("ra", 1, "a"), release("xa", 2, "ra"), release("xb", 3, "ra")],
  ])
    reject(input(events), "OPERATING_JOURNAL_RELEASE_MISMATCH");
});

test("OP-JOURNAL-13 30자리 정수 누적·지급은 부동소수점 반올림 없음", () => {
  const n = "999999999999999999999999999999";
  const r = replayOperatingJournal({
    ...input([
      recognize("ca", 1, "a", null, n),
      recognize("cb", 2, "b", null, n),
      pay("pa", 3, "a", n),
    ]),
    openingCashKrw: n,
  });
  assert.equal(r.incurredKrw, "1999999999999999999999999999998");
  assert.equal(r.cashKrw, "0");
  assert.equal(r.payableKrw, n);
  assert.equal(r.netEquityKrw, `-${n}`);
});

test("OP-JOURNAL-14 외화·환불·정정·레거시·불완전·실사용 표식은 미지원", () => {
  for (const change of [
    { purpose: "LIVE" },
    { liveEnabled: true },
    { startsEmpty: false },
    { complete: false },
    { currency: "USD" },
    { openingCashKrw: "0.5" },
    { schemaVersion: "V1" },
  ])
    reject({ ...input(), ...change }, "OPERATING_JOURNAL_INVALID");
  for (const amountKrw of ["-1", "NaN", "01", "1e3", "1.1", "9".repeat(31)])
    reject(
      input([recognize("ca", 1, "a", null, amountKrw)]),
      "OPERATING_JOURNAL_INVALID",
    );
  reject(
    { ...input(), events: [{ ...recognize("ca", 1, "a"), kind: "REFUND" }] },
    "OPERATING_JOURNAL_INVALID",
  );
  reject(
    { ...input(), policyHash: "0".repeat(64) },
    "OPERATING_JOURNAL_POLICY_MISMATCH",
  );
});

test("OP-JOURNAL-15 성공·실패 모두 호출자 원자료 불변", () => {
  const original = input([recognize("ca", 1, "a")]);
  const before = structuredClone(original);
  const view = replayOperatingJournal(original);
  view.obligations[0]!.amountKrw = "999";
  assert.deepEqual(original, before);
  const invalid = input([recognize("ca", 1, "a"), pay("pa", 2, "a", "2")]);
  const invalidBefore = structuredClone(invalid);
  reject(invalid, "OPERATING_JOURNAL_PAYMENT_MISMATCH");
  assert.deepEqual(invalid, invalidBefore);
});

test("OP-JOURNAL-16 저장된 잔액·ID·근거·지출 승인 표식 변조 독립 재계산으로 거절", () => {
  const raw = input([recognize("ca", 1, "a")]),
    view = replayOperatingJournal(raw);
  assert.deepEqual(verifyOperatingJournalView(raw, view), view);
  for (const change of [
    { cashKrw: "999" },
    { incurredKrw: "0" },
    { sourceHash: "0".repeat(64) },
    { obligations: [] },
    { newSpendingApproved: true },
    { extra: true },
  ])
    assert.throws(
      () => verifyOperatingJournalView(raw, { ...view, ...change }),
      /OPERATING_JOURNAL_VIEW_MISMATCH/,
    );
});

test("OP-JOURNAL-17 새 임시 파일 저장·재읽기·전체 재생 일치, 잘린 자료 거절", () => {
  const dir = mkdtempSync(join(tmpdir(), "operating-journal-test-"));
  const raw = input([
    reserve("ra", 1, "a"),
    recognize("ca", 2, "a", "ra"),
    pay("pa", 3, "a"),
  ]);
  const view = replayOperatingJournal(raw);
  const path = join(dir, "TEST_ONLY.json");
  writeFileSync(path, JSON.stringify({ raw, view }), { flag: "wx" });
  const bytes = readFileSync(path, "utf8"),
    saved = JSON.parse(bytes);
  assert.deepEqual(verifyOperatingJournalView(saved.raw, saved.view), view);
  assert.throws(() => JSON.parse(bytes.slice(0, -7)));
  // 유효한 JSON의 마지막 사건 누락도 원래 확정한 뷰와 맞지 않는다.
  const missingPayment = { ...raw, events: raw.events.slice(0, -1) };
  assert.equal(replayOperatingJournal(missingPayment).payableKrw, "50");
  assert.throws(
    () => verifyOperatingJournalView(missingPayment, saved.view),
    /OPERATING_JOURNAL_VIEW_MISMATCH/,
  );
  assert.equal(readFileSync(path, "utf8"), bytes);
});

test("OP-JOURNAL-18 알려진 무사건/0원과 불명확을 구분하고 지출 승인하지 않음", () => {
  const empty = replayOperatingJournal(input());
  assert.equal(empty.incurredKrw, "0");
  assert.equal(empty.newSpendingApproved, false);
  const zero = replayOperatingJournal(
    input([recognize("ca", 1, "a", null, "0"), pay("pa", 2, "a", "0")]),
  );
  assert.equal(zero.obligations.length, 1);
  assert.equal(zero.obligations[0]!.paid, true);
  reject({ ...input(), complete: undefined }, "OPERATING_JOURNAL_INVALID");
});
