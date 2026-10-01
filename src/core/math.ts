import Decimal from "decimal.js";
// 운영 확정값이 아닌 TEST_ONLY 정밀도 계약. 표시값을 판정에 재사용하지 않는다.
Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -30,
  toExpPos: 40,
});
export { Decimal };
export type Money = string;
export const d = (v: Decimal.Value) => {
  const n = new Decimal(v);
  if (!n.isFinite()) throw new Error("NON_FINITE");
  return n;
};
export const sum = (values: Decimal.Value[]) =>
  values.reduce<Decimal>((a, v) => a.plus(v), d(0));
export const min = (...values: Decimal.Value[]) => Decimal.min(...values);
export const max = (...values: Decimal.Value[]) => Decimal.max(...values);
export const floor = (v: Decimal.Value) => d(v).floor().toFixed(0);
export const ceil = (v: Decimal.Value) => d(v).ceil().toFixed(0);
export const tick = (price: Decimal.Value, unit: Decimal.Value, up = false) =>
  d(price).div(unit)[up ? "ceil" : "floor"]().mul(unit).toString();
export function median(values: Decimal.Value[]) {
  if (!values.length) throw new Error("MISSING_MEDIAN");
  const a = values.map(d).sort((x, y) => x.cmp(y));
  const i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i]! : a[i - 1]!.plus(a[i]!).div(2);
}
export function percentile(values: Decimal.Value[], p: string) {
  if (!values.length) throw new Error("MISSING_PERCENTILE");
  const a = values.map(d).sort((x, y) => x.cmp(y));
  return a[d(p).mul(a.length).ceil().toNumber() - 1]!;
}
