import { d, tick } from "./math.js";
import { policy } from "./policy.js";

// Both legacy paper execution and the opt-in cost loop use the same 2R rule.
export function exitTarget(vwap: string, stop: string, unit: string) {
  const price = d(vwap);
  return tick(
    price.plus(
      price
        .minus(stop)
        .mul(policy.exit_policy.target_initial_price_risk_multiple),
    ),
    unit,
    true,
  );
}
