import policy from "../../outputs/AI_TRADING_POLICY_v2.3.json" with { type: "json" };

export const minute = 60_000;
const riskDayMilliseconds = 24 * 60 * minute;
const maximumDateMilliseconds = 8_640_000_000_000_000;
export interface CompletedRiskWindow {
  startInclusive: number;
  endExclusive: number;
  riskDayIds: string[];
}

// 정책 v2.3의 직전 완료 20위험일. 거래소 영업일이나 현재 시각 기준 이동 창이 아니다.
export function completedRiskWindow(asOf: number): CompletedRiskWindow {
  const calendar = policy.risk_calendar;
  const days = policy.economic_gate.operating_cost_lookback_risk_days;
  if (
    calendar.timezone !== "Asia/Seoul" ||
    calendar.day_boundary !== "09:00:00" ||
    calendar.shared_across_markets !== true ||
    days !== 20
  )
    throw new Error("UNSUPPORTED_COMPLETED_RISK_WINDOW_POLICY");
  if (!Number.isSafeInteger(asOf) || Math.abs(asOf) > maximumDateMilliseconds)
    throw new RangeError("INVALID_COMPLETED_RISK_WINDOW_AS_OF");

  // KST 09:00 = UTC 00:00인 고정 계약에만 적용한다. 음수 epoch도 내림한다.
  const endExclusive =
    asOf === 0
      ? 0
      : Math.floor(asOf / riskDayMilliseconds) * riskDayMilliseconds;
  const startInclusive = endExclusive - days * riskDayMilliseconds;
  if (
    !Number.isSafeInteger(startInclusive) ||
    startInclusive < -maximumDateMilliseconds
  )
    throw new RangeError("INVALID_COMPLETED_RISK_WINDOW_START");

  return {
    startInclusive,
    endExclusive,
    riskDayIds: Array.from(
      { length: days },
      (_, index) =>
        new Date(startInclusive + index * riskDayMilliseconds)
          .toISOString()
          .split("T")[0]!,
    ),
  };
}

export interface Session {
  id: string;
  open: number;
  close: number;
  market: "KR" | "US";
  version: string;
}
// 서울 09:00은 UTC 00:00. 거래소 현지 날짜와 구분한다.
export function riskKeys(at: number) {
  const date = new Date(at);
  const day = date.toISOString().slice(0, 10);
  const monday = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() - ((date.getUTCDay() + 6) % 7),
    ),
  );
  return {
    day,
    week: monday.toISOString().slice(0, 10),
    month: day.slice(0, 7),
  };
}
export function localTimeToUtc(date: string, time: string, zone: string) {
  let at = Date.parse(`${date}T${time}:00Z`);
  const desired = at;
  for (let n = 0; n < 3; n++) {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const get = (t: string) => p.find((x) => x.type === t)!.value;
    const local = Date.parse(
      `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`,
    );
    at += desired - local;
  }
  return at;
}
export function session(
  date: string,
  market: "KR" | "US",
  early = false,
  closed = false,
): Session | null {
  if (closed) return null;
  const zone = market === "KR" ? "Asia/Seoul" : "America/New_York";
  return {
    id: `${market}:${date}`,
    market,
    open: localTimeToUtc(date, market === "KR" ? "09:00" : "09:30", zone),
    close: localTimeToUtc(
      date,
      early ? "13:00" : market === "KR" ? "15:30" : "16:00",
      zone,
    ),
    version: "SYNTHETIC_CALENDAR_V1",
  };
}
export function entryWindow(
  at: number,
  s: Session,
  start: number,
  end: number,
) {
  return at >= s.open + start * minute && at <= s.close - end * minute;
}
