import type { Config, Level } from "./policy.js";
export type Currency = "KRW" | "USD";
export type EngineStatus =
  | "STOPPED"
  | "RUNNING"
  | "ENTRY_PAUSED"
  | "RECONCILING"
  | "REDUCTION_PENDING"
  | "EXIT_BLOCKED"
  | "HALTED";
export type OrderStatus =
  | "INTENT_SAVED"
  | "WORKING"
  | "PARTIAL"
  | "CANCEL_PENDING"
  | "CANCEL_UNKNOWN"
  | "UNKNOWN"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED";
export type Protection =
  | "REGISTERED_PENDING_VERIFY"
  | "WATCHING"
  | "TRIGGER_SUSPECTED"
  | "TRIGGERED"
  | "CHILD_PENDING"
  | "EXIT_WORKING"
  | "EXIT_PARTIAL"
  | "CANCEL_UNKNOWN"
  | "RECOVERY_READY"
  | "EXIT_BLOCKED"
  | "CLOSED_RECONCILED"
  | "PROTECTION_SUBMIT_UNKNOWN";
export interface Wallet {
  cash: string;
  receivable: string;
  payable: string;
  unpaidFees: string;
}
export interface Position {
  id: string;
  intentId: string;
  symbol: string;
  currency: Currency;
  market: "KR" | "US";
  owner: "BOT" | "MANUAL";
  quantity: number;
  buyQuantity: number;
  buyValue: string;
  entryFees: string;
  exitValue: string;
  exitFees: string;
  stop: string;
  target: string;
  bid: string;
  firstFillAt: number;
  deadline: number;
  protection: Protection;
  protectedQuantity: number;
  initialBudget: string;
  exitReason?: string;
  exitReferenceBid?: string;
  exitOrderId?: string;
  replacements: number;
  closedAt?: number;
  netPnl?: string;
}
export interface Order {
  id: string;
  intentId: string;
  positionId: string;
  side: "BUY" | "SELL";
  quantity: number;
  filled: number;
  value: string;
  limit: string;
  currency: Currency;
  status: OrderStatus;
  version: number;
  submittedAt: number;
  cancelAt?: number;
  cancelFinalAt?: number;
  lastProgressAt: number;
  reservationRisk: string;
  reservationCash: string;
  snapshot?: Record<string, unknown>;
  snapshotHash?: string;
  epoch: number;
  eventIds: string[];
  replaces?: string;
}
export interface Decision {
  id: string;
  at: number;
  symbol: string;
  strategy: "B" | "P" | null;
  result: "APPROVED" | "ABSTAIN";
  reasons: string[];
  trace: Trace[];
  quantity: number;
  snapshotHash?: string;
}
export interface Trace {
  predicate_id: string;
  input_values: Record<string, string | number | boolean | null>;
  threshold: string;
  operator: string;
  result: "PASS" | "FAIL" | "MISSING" | "NOT_APPLICABLE";
  reason: string;
  strategy_version: string;
  indicator_version: string;
  data_version: string;
  as_of: number;
  risk_level?: Level;
  effective_caps_hash?: string;
}
export interface Period {
  startEquity: string;
  flows: string;
  key: string;
}
export interface CostEvent {
  id: string;
  amount: string;
  at: number;
  paid: boolean;
}
export interface Ledger {
  wallets: Record<Currency, Wallet>;
  fx: string;
  fxAt: number;
  accountAt: number;
  units: string;
  highNav: string;
  drawdownReduced: boolean;
  halts: string[];
  periods: { day: Period; week: Period; month: Period };
  costs: CostEvent[];
  operationsReserved: string;
  entries: number;
  intents: number;
  symbolEntries: Record<string, number>;
  lossStreak: number;
  cooldowns: Record<string, number>;
}
export interface State {
  version: 1;
  revision: number;
  config: Config | null;
  status: EngineStatus;
  clock: number;
  sessionOpen: number;
  sessionClose: number;
  cursor: number;
  epoch: number;
  pendingLevel: Level | null;
  ledger: Ledger;
  positions: Position[];
  orders: Order[];
  decisions: Decision[];
  notices: string[];
  lastSignalAt: number;
  manifest: Record<string, unknown> | null;
  manifestHistory: Record<string, unknown>[];
  fault: string | null;
  cleanShutdown: boolean;
}
export interface Quote {
  bid: string;
  ask: string;
  bidSize: number;
  askSize: number;
  lastMinuteVolume: number;
  at: number;
  halted: boolean;
}
export const terminal = (o: Order) =>
  ["FILLED", "CANCELLED", "REJECTED"].includes(o.status);
