import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { Repository } from "./repository.js";
import { hash, policyHash, verifyPolicies } from "../core/policy.js";
import { checkPortfolioInvariants } from "../core/portfolio-invariants.js";
import {
  controlCommandSchema,
  controlConfigSchema,
  controlStateSchema,
  controlStep,
  isWrite,
  newControl,
  recoverControl,
  type ControlConfig,
} from "../core/broker-control.js";
import {
  openReconciliationCase,
  openCaseSchema,
  reconciliationSchema,
  reconciliationCaseSchema,
  reconcileMockOrder,
} from "../core/broker-reconciliation.js";
import type { State } from "../core/types.js";

const kind = "OFFLINE_BROKER_CONTROL_LAB_V1";
const labSchema = z
  .object({
    kind: z.literal(kind),
    policyHash: z.literal(policyHash),
    configHash: z.string(),
    initialHash: z.string(),
    control: controlStateSchema,
    cases: z.array(reconciliationCaseSchema).max(20),
  })
  .strict();
export type BrokerLabData = z.infer<typeof labSchema>;
export function brokerLabData(s: State): BrokerLabData {
  return labSchema.parse(s.manifest?.brokerControlLab);
}

// 기존 사용자 앱 DB는 읽기 전용 확인에서 거절한다. 자동 승격/마이그레이션하지 않는다.
function preflight(path: string, resume: boolean) {
  if (path === ":memory:" || !existsSync(path)) return;
  if (!resume) throw Error("BROKER_LAB_EXISTING_FILE_REQUIRES_RESUME");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT body FROM aggregate WHERE id=1").get();
    if (!row || brokerLabData(JSON.parse(String(row.body))).kind !== kind)
      throw Error();
  } catch {
    throw Error("BROKER_LAB_NOT_A_LAB_DATABASE");
  } finally {
    db.close();
  }
}

export class BrokerControlLab {
  readonly repo: Repository;
  readonly config: ControlConfig;
  #initial: State;
  constructor(
    initial: State,
    rawConfig: unknown,
    path = ":memory:",
    options: { resume?: boolean; now?: () => number } = {},
  ) {
    verifyPolicies();
    this.config = controlConfigSchema.parse(rawConfig);
    this.#initial = structuredClone(initial);
    if (
      initial.config?.mode !== "PAPER" ||
      initial.config.forecast !== "TEST_ONLY" ||
      initial.manifest?.kind !== "OFFLINE_PORTFOLIO_PAPER_V1" ||
      initial.orders.length ||
      initial.positions.length
    )
      throw Error("BROKER_LAB_EMPTY_TEST_INITIAL_REQUIRED");
    preflight(path, options.resume === true);
    this.repo = new Repository(path, options.now);
    try {
      this.repo.acquire();
      this.repo.verifyAudit();
      this.repo.transact(
        `broker-lab-init-${this.repo.epoch}`,
        { kind, configHash: hash(this.config) },
        (previous) => {
          const s = previous ?? structuredClone(initial);
          if (previous) {
            if (!options.resume) throw Error("BROKER_LAB_RESUME_REQUIRED");
            const lab = this.validate(s);
            lab.control = recoverControl(lab.control);
            s.manifest!.brokerControlLab = lab;
          } else
            s.manifest!.brokerControlLab = {
              kind,
              policyHash,
              configHash: hash(this.config),
              initialHash: hash(this.#initial),
              control: newControl(this.config, initial.clock),
              cases: [],
            } satisfies BrokerLabData;
          s.status = "RECONCILING";
          s.epoch = this.repo.epoch;
          s.cleanShutdown = false;
          this.validate(s);
          return s;
        },
      );
    } catch (error) {
      this.repo.close();
      throw error;
    }
  }
  private validate(s: State) {
    const lab = brokerLabData(s);
    if (
      lab.configHash !== hash(this.config) ||
      hash(lab.control.config) !== hash(this.config) ||
      lab.initialHash !== hash(this.#initial) ||
      s.manifest?.runHash !== this.#initial.manifest?.runHash
    )
      throw Error("BROKER_LAB_BINDING_MISMATCH");
    if (
      s.status !== "RECONCILING" ||
      lab.control.now !== s.clock ||
      new Set(lab.control.records.map((r) => r.request.id)).size !==
        lab.control.records.length ||
      new Set(lab.cases.map((c) => c.orderId)).size !== lab.cases.length
    )
      throw Error("BROKER_LAB_STATE_INVALID");
    checkPortfolioInvariants(s, this.#initial);
    return lab;
  }
  state() {
    const s = this.repo.read();
    if (!s) throw Error("BROKER_LAB_STATE_MISSING");
    this.validate(s);
    return s;
  }
  // 작업자는 트랜잭션 안의 최신 상태를 공유하며 오래된 복사본으로 덮어쓰지 않는다.
  command(id: string, raw: unknown) {
    if (!/^[a-zA-Z0-9:._-]{1,180}$/.test(id))
      throw Error("BROKER_LAB_COMMAND_ID");
    verifyPolicies();
    const command = z
      .discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("CONTROL"), command: controlCommandSchema })
          .strict(),
        z
          .object({ kind: z.literal("OPEN_CASE"), case: openCaseSchema })
          .strict(),
        z
          .object({
            kind: z.literal("RECONCILE"),
            evidence: reconciliationSchema,
          })
          .strict(),
      ])
      .parse(raw);
    if (JSON.stringify(command).length > 128_000)
      throw Error("BROKER_LAB_INPUT_LIMIT");
    return this.repo.transact(id, command, (s) => {
      if (!s) throw Error("BROKER_LAB_STATE_MISSING");
      const lab = this.validate(s);
      if (command.kind === "CONTROL") {
        const c = command.command;
        const unresolved =
          lab.cases.some((x) => x.status !== "TERMINAL_CONFIRMED") ||
          s.orders.some((o) =>
            ["UNKNOWN", "CANCEL_UNKNOWN"].includes(o.status),
          );
        if (c.kind === "RESUME" && unresolved)
          throw Error("BROKER_LAB_UNRESOLVED_CASE");
        if (c.kind === "ENQUEUE") {
          if (c.request.reservationFor) {
            const owner = lab.control.records.find(
              (r) => r.request.id === c.request.reservationFor,
            );
            const linked = lab.cases.find((x) => x.id === c.request.caseId);
            if (
              !owner ||
              !linked ||
              owner.request.orderId !== linked.orderId ||
              !linked.requestIds.includes(owner.request.id)
            )
              throw Error("BROKER_LAB_RESERVATION_CASE_MISMATCH");
          }
          if (isWrite(c.request.action)) {
            const order = s.orders.find((o) => o.id === c.request.orderId);
            const route = lab.control.config.routes.find(
              (r) => r.id === c.request.routeId,
            );
            const position = s.positions.find(
              (p) => p.id === order?.positionId,
            );
            if (
              !order ||
              ["FILLED", "CANCELLED", "REJECTED"].includes(order.status) ||
              !route ||
              route.market !== (position?.market ?? order.snapshot?.market) ||
              (c.request.action === "ENTRY" && order.side !== "BUY") ||
              (c.request.action === "EXIT" && order.side !== "SELL")
            )
              throw Error("BROKER_LAB_WRITE_ORDER_BINDING");
          }
          if (
            c.request.caseId &&
            !lab.cases.some((x) => x.id === c.request.caseId)
          )
            throw Error("BROKER_LAB_CASE_UNKNOWN");
          if (
            isWrite(c.request.action) &&
            lab.cases.some((x) => x.status !== "TERMINAL_CONFIRMED")
          )
            throw Error("BROKER_LAB_NO_NEW_OR_REPLACEMENT_ORDER");
        }
        lab.control = controlStep(
          lab.control,
          c,
          unresolved,
          s.orders
            .filter((o) =>
              ["FILLED", "CANCELLED", "REJECTED"].includes(o.status),
            )
            .map((o) => o.id),
        );
        for (const record of lab.control.records) {
          if (record.status !== "UNKNOWN" || !isWrite(record.request.action))
            continue;
          const order = s.orders.find((o) => o.id === record.request.orderId);
          if (
            order &&
            !["FILLED", "CANCELLED", "REJECTED"].includes(order.status)
          )
            order.status =
              record.request.action === "CANCEL" ? "CANCEL_UNKNOWN" : "UNKNOWN";
        }
        s.clock = lab.control.now;
      } else if (command.kind === "OPEN_CASE") {
        const c = openReconciliationCase(s, lab.control, command.case);
        if (
          lab.cases.length >= 20 ||
          lab.cases.some((x) => x.id === c.id || x.orderId === c.orderId)
        )
          throw Error("BROKER_LAB_CASE_DUPLICATE_OR_LIMIT");
        lab.cases.push(c);
        lab.control.mode = "PAUSED";
      } else {
        const caseId = command.evidence.caseId;
        const c = lab.cases.find((c) => c.id === caseId);
        if (!c) throw Error("BROKER_LAB_CASE_UNKNOWN");
        reconcileMockOrder(s, lab.control, c, command.evidence);
      }
      s.manifest!.brokerControlLab = lab;
      this.validate(s);
      return s;
    });
  }
  close() {
    this.repo.close();
  }
}
