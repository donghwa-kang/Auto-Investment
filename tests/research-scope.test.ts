import { test } from "node:test";
import assert from "node:assert/strict";
import {
  researchAdmission,
  researchScope,
} from "../src/core/research-scope.js";
import { researchSamples } from "../src/core/providers.js";

test("SCOPE-01 3천만원 단일종목 레버리지와 SOXL 지수형 레버리지 구분", () => {
  assert.equal(
    researchAdmission({
      underlying: "SINGLE_STOCK",
      leveraged: true,
      requiredDepositKrw: 30000000,
    }),
    "EXCLUDED_BY_USER",
  );
  assert.equal(
    researchAdmission({
      underlying: "INDEX",
      leveraged: true,
      requiredDepositKrw: 10000000,
    }),
    "INCLUDED_FOR_VALIDATION",
  );
  assert.equal(
    researchAdmission({
      underlying: "INDEX",
      leveraged: true,
      requiredDepositKrw: null,
    }),
    "INCLUDED_FOR_VALIDATION",
  );
});

test("SCOPE-02 알 수 없는 상품 분류·단일종목 자격·잘못된 자료는 보류", () => {
  for (const input of [
    { underlying: "UNKNOWN", leveraged: true, requiredDepositKrw: 30000000 },
    { underlying: "SINGLE_STOCK", leveraged: true, requiredDepositKrw: null },
    { underlying: "INDEX", leveraged: true, requiredDepositKrw: -1 },
    { underlying: "INDEX", leveraged: "false", requiredDepositKrw: 10000000 },
    {},
  ])
    assert.equal(researchAdmission(input), "CLASSIFICATION_REQUIRED");
});

test("SCOPE-03 후보 포함이 실거래·시장 자료·예측 검증을 켜지 않음", () => {
  assert.equal(researchScope.blanket_leverage_ban, false);
  assert.equal(researchScope.live_enabled, false);
  assert.equal(researchScope.real_market_feed_connected, false);
  assert.equal(researchScope.live_eligibility, "UNVERIFIED");
  const soxl = researchSamples(Date.now()).find((x) => x.id === "SOXL")!;
  assert.equal(soxl.validationCandidate, "INCLUDED_FOR_VALIDATION");
  assert.equal(soxl.tradePermission, "UNVERIFIED");
  assert.equal(soxl.reviewedAt, null);
});
