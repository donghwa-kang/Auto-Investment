import { performance } from "node:perf_hooks";
import { hash } from "../core/policy.js";
import { costLoopTickSchema } from "../core/cost-loop-schema.js";
import { costWatchdogNeedsPulse } from "../core/cost-watchdog.js";
import type { CostReservationStore } from "./cost-reservation-store.js";

export interface CostLoopClock {
  wallNow(): number;
  monotonicNow(): number;
}
export interface CostLoopTimer {
  schedule(delayMs: number, callback: () => void): () => void;
}
const realClock: CostLoopClock = {
  wallNow: Date.now,
  monotonicNow: () => performance.now(),
};
const realTimer: CostLoopTimer = {
  schedule(delay, callback) {
    const handle = setTimeout(callback, delay);
    return () => clearTimeout(handle);
  },
};
const owners = new WeakMap<CostReservationStore, CostLoopRuntime>();

// Stop this Store's scheduler before attempting D8. Other Store instances or
// processes remain subject to the DB lease/CAS and persisted closed-state guard.
export function quiesceCostLoopRuntime(store: CostReservationStore) {
  owners.get(store)?.quiesceForFinalization();
}

// Opt-in developer runner, not the app's existing scheduler or a broker client.
// All Store operations are synchronous on one JS lane; at most one wakeup is
// pending. Late callbacks are coalesced, never replayed as a burst of fake ticks.
export class CostLoopRuntime {
  readonly #clock: CostLoopClock;
  readonly #timer: CostLoopTimer;
  readonly #interval: number;
  #cancel: (() => void) | null = null;
  #generation = 0;
  #busy = false;
  #anchor: { wall: number; mono: number } | null = null;
  #lastWall = 0;
  #lastMono = 0;
  #failure: unknown = null;
  #status = {
    phase: "IDLE" as "IDLE" | "RUNNING" | "STOPPED" | "FAULT",
    error: null as string | null,
    lastCheckedAt: null as number | null,
    lastLagMs: 0,
    checks: 0,
    pulses: 0,
    holds: [] as string[],
  };
  constructor(
    private readonly store: CostReservationStore,
    options: {
      clock?: CostLoopClock;
      timer?: CostLoopTimer;
      intervalMs?: number;
    } = {},
  ) {
    this.#clock = options.clock ?? realClock;
    this.#timer = options.timer ?? realTimer;
    this.#interval = options.intervalMs ?? 250;
    if (
      !Number.isInteger(this.#interval) ||
      this.#interval < 100 ||
      this.#interval > 1000
    )
      throw Error("COST_RUNTIME_INTERVAL");
  }
  status() {
    return {
      ...structuredClone(this.#status),
      timerPending: this.#cancel !== null,
    };
  }
  get failure() {
    return this.#failure;
  }
  start() {
    if (this.#status.phase === "RUNNING" || owners.has(this.store))
      throw Error("COST_RUNTIME_ALREADY_RUNNING");
    if (this.#status.phase === "FAULT")
      throw Error("COST_RUNTIME_RECONCILIATION_REQUIRED");
    try {
      if (this.store.read().finalization?.checkpoint)
        throw Error("COST_RUNTIME_FINALIZED");
    } catch (error) {
      this.fail(error);
      throw error;
    }
    owners.set(this.store, this);
    this.#status.phase = "RUNNING";
    this.#anchor = null;
    this.#lastWall = this.#lastMono = 0;
    this.operate(() => this.check(this.now()));
    this.arm();
    return this.status();
  }
  stop() {
    this.disarm();
    if (owners.get(this.store) === this) owners.delete(this.store);
    if (this.#status.phase !== "FAULT") this.#status.phase = "STOPPED";
    // Stopping the runner is not liquidation, cancellation or a HOLD reset.
    return this.status();
  }
  quiesceForFinalization() {
    if (this.#busy) throw Error("COST_RUNTIME_REENTRANT");
    // Stop even if validation/commit subsequently fails. No implicit restart,
    // liquidation, fresh quote or fabricated full-period evidence.
    return this.stop();
  }
  quote(commandId: string, raw: unknown) {
    return this.operate(() => {
      const now = this.now(),
        command = costLoopTickSchema.parse(raw);
      // Never relabel an old/future event as a current quote.
      if (command.at !== now) throw Error("COST_RUNTIME_QUOTE_PROCESSING_TIME");
      this.check(now);
      const result = this.store.tick(commandId, command);
      this.#status.holds = [...result.current.loop!.holds];
      return result;
    });
  }
  private now() {
    const wall = this.#clock.wallNow(),
      mono = this.#clock.monotonicNow();
    if (
      !Number.isSafeInteger(wall) ||
      wall <= 0 ||
      !Number.isFinite(mono) ||
      mono < 0
    )
      throw Error("COST_RUNTIME_INVALID_CLOCK");
    if (this.#anchor && (wall < this.#lastWall || mono < this.#lastMono))
      throw Error("COST_RUNTIME_CLOCK_REGRESSION");
    this.#anchor ??= { wall, mono };
    this.#lastWall = wall;
    this.#lastMono = mono;
    const now = Math.max(
      wall,
      this.#anchor.wall + Math.floor(mono - this.#anchor.mono),
    );
    if (!Number.isSafeInteger(now)) throw Error("COST_RUNTIME_INVALID_CLOCK");
    return now;
  }
  private check(at: number) {
    // Heartbeat cannot revive an expired lease. A fenced/late writer stops.
    this.store.heartbeat();
    let s = this.store.read();
    if (s.finalization?.checkpoint) throw Error("COST_RUNTIME_FINALIZED");
    if (
      !s.loop?.watchdog ||
      !s.loop.config.watchdog ||
      !s.handoff ||
      s.book.sources.length !== 1
    )
      throw Error("COST_WATCHDOG_OPT_IN_REQUIRED");
    const command = {
      kind: "COST_LOOP_PULSE" as const,
      purpose: "TEST_ONLY" as const,
      instrument: s.book.sources[0]!.config.execution.instrument,
      at,
    };
    if (costWatchdogNeedsPulse(s, command)) {
      // Deterministic identity; a committed retry never needs a fresh ID.
      s = this.store.pulse(`watchdog-${hash(command)}`, command).current;
      this.#status.pulses++;
    }
    this.#status.lastCheckedAt = at;
    this.#status.checks++;
    this.#status.holds = [...s.loop!.holds];
    if (at >= s.handoff!.horizonEnd)
      throw Error("COST_RUNTIME_HORIZON_EXHAUSTED");
  }
  private operate<T>(fn: () => T): T {
    if (this.#status.phase !== "RUNNING")
      throw Error("COST_RUNTIME_NOT_RUNNING");
    if (this.#busy) throw Error("COST_RUNTIME_REENTRANT");
    this.#busy = true;
    try {
      return fn();
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      this.#busy = false;
    }
  }
  private fail(error: unknown) {
    this.#failure = error;
    this.#status.error =
      error instanceof Error ? error.message : "COST_RUNTIME_FAILURE";
    this.#status.phase = "FAULT";
    this.disarm();
    if (owners.get(this.store) === this) owners.delete(this.store);
  }
  private disarm() {
    this.#generation++;
    const cancel = this.#cancel;
    this.#cancel = null;
    cancel?.();
  }
  private arm() {
    if (this.#status.phase !== "RUNNING") return;
    try {
      const generation = this.#generation,
        due = this.#clock.monotonicNow() + this.#interval;
      if (!Number.isFinite(due) || due < 0)
        throw Error("COST_RUNTIME_INVALID_CLOCK");
      this.#cancel = this.#timer.schedule(this.#interval, () => {
        if (generation !== this.#generation || this.#status.phase !== "RUNNING")
          return;
        this.#cancel = null;
        try {
          this.operate(() => {
            const now = this.now();
            this.#status.lastLagMs = Math.max(0, this.#lastMono - due);
            this.check(now);
          });
          this.arm();
        } catch (error) {
          this.fail(error);
        }
      });
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }
}
