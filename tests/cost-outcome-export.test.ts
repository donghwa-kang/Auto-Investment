import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  openSync,
  ftruncateSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { hash } from "../src/core/policy.js";
import {
  verifyCostOutcomeExport,
  MAX_COST_EXPORT_BYTES,
} from "../src/core/cost-outcome-export.js";
import type { CostOutcomeExport } from "../src/core/cost-outcome-export.js";
import {
  saveCostOutcomeExport,
  verifyCostOutcomeExportFile,
} from "../src/server/cost-outcome-file.js";
import { Repository } from "../src/server/repository.js";
import { CostReservationStore } from "../src/server/cost-reservation-store.js";
import { reservationConfig, proposal } from "./cost-reservation-helpers.js";
import { handoffConfig, dumpHandoff } from "./cost-handoff-helpers.js";
import {
  openedOutcome,
  outcomeConfig,
  beginTrade,
  fillTrade,
  closeTrade,
  sellOrder,
  execute,
  journal,
  cancelOrder,
} from "./cost-outcome-helpers.js";

const fresh = () => mkdtempSync(join(tmpdir(), "cost-export-"));
const encode = (v: unknown) => JSON.stringify(v);
function repin(value: CostOutcomeExport) {
  const { exportHash, ...body } = value;
  assert.equal(typeof exportHash, "string");
  value.exportHash = hash(body);
  return value;
}
function fixture(market: "KR" | "US" = "KR") {
  const o = openedOutcome(outcomeConfig(market));
  const run = beginTrade(o.store);
  fillTrade(o.store, run);
  closeTrade(o.store, run, market === "KR" ? "10100" : "40.3");
  return { ...o, run };
}

for (const market of ["KR", "US"] as const)
  test(`COE-01 ${market} empty/open/closed/settled file replay exactly preserves D1 and HOLD`, () => {
    const { repo, store, c } = openedOutcome(outcomeConfig(market));
    const samples: CostOutcomeExport[] = [];
    const capture = () => {
      const value = store.exportEvidence();
      assert.deepEqual(value.report, store.report());
      samples.push(value);
    };
    try {
      capture();
      const run = beginTrade(store);
      capture();
      fillTrade(store, run);
      capture();
      closeTrade(store, run, market === "KR" ? "10100" : "40.3");
      capture();
      execute(store, run, {
        kind: "SETTLE",
        id: "settle",
        fillIds: journal(store.read(), run).postings.map((p) => p.fill.fillId),
      });
      capture();
    } finally {
      repo.close();
    }
    // Verification after closing the only money DB, with no repository API.
    const base = fresh();
    for (const value of samples) {
      const anchor = { config: c, exportHash: value.exportHash };
      const path = saveCostOutcomeExport(value, anchor, base);
      const verified = verifyCostOutcomeExportFile(path, anchor);
      assert.deepEqual(verified.report, value.report);
      assert.equal(verified.status, "HOLD");
      assert.equal(verified.learningAllowed, false);
      assert.equal(verified.liveEnabled, false);
      assert.equal(verified.orderSubmissionAllowed, false);
      assert.equal(verified.report.learningEvidence.status, "HOLD");
      for (const r of verified.report.learningEvidence.records)
        assert.equal(r.trainingLabel, null);
    }
  });

test("COE-02 query_only capture is deterministic, detached and does not touch tables/lease", () => {
  const { repo, store, c } = fixture();
  try {
    const before = {
      tables: dumpHandoff(repo),
      writer: repo.db.prepare("SELECT * FROM writer").all(),
    };
    repo.db.exec("PRAGMA query_only=ON");
    const first = store.exportEvidence(),
      second = store.exportEvidence();
    assert.deepEqual(first, second);
    assert.equal(first.initialEpoch, c.seed.epoch);
    first.config.seed.clock++;
    first.records[0]!.id = "changed";
    first.report.financialEvidence.accounts[0]!.cash = "0";
    assert.deepEqual(store.exportEvidence(), second);
    assert.deepEqual(
      {
        tables: dumpHandoff(repo),
        writer: repo.db.prepare("SELECT * FROM writer").all(),
      },
      before,
    );
  } finally {
    repo.db.exec("PRAGMA query_only=OFF");
    repo.close();
  }
});

test("COE-03 reserved/released and UNKNOWN evidence is not filtered out", () => {
  const { repo, store, c } = openedOutcome();
  try {
    store.reserve("reserve", store.prepare(proposal(store, "RELEASED")));
    store.release("release", "r-RELEASED", store.read());
    beginTrade(store, "FIRST", 1, "UNKNOWN");
    const v = store.exportEvidence();
    const r = verifyCostOutcomeExport(encode(v), {
      config: c,
      exportHash: v.exportHash,
    }).report;
    assert.deepEqual(r, store.report());
    assert.equal(r.learningEvidence.records.length, 2);
    assert.ok(
      r.learningEvidence.records.every((v) => v.tradingNetPnlNative === null),
    );
    assert.equal(r.financialEvidence.trades[0]!.orders[0]!.status, "UNKNOWN");
  } finally {
    repo.close();
  }
});

test("COE-04 stale FX loss stays pending after export/replay", () => {
  const { repo, store, c } = openedOutcome(outcomeConfig("US"));
  try {
    const run = beginTrade(store);
    fillTrade(store, run);
    sellOrder(store, run, "39.7");
    fillTrade(store, run, "exit", 1, "39.7", store.read().seed.clock + 60001);
    const v = store.exportEvidence();
    const r = verifyCostOutcomeExport(encode(v), {
      config: c,
      exportHash: v.exportHash,
    }).report;
    assert.deepEqual(r, store.report());
    assert.equal(r.learningEvidence.records[0]!.tradingNetPnlKrw, null);
    assert.ok(r.learningEvidence.records[0]!.reasons.length > 2);
    assert.equal(
      r.report.currencies.find((v) => v.currency === "USD")!.closedNetPnlKrw,
      null,
    );
  } finally {
    repo.close();
  }
});

test("COE-05 same-time partial fills preserve financial identity and costs", () => {
  const { repo, store, c } = openedOutcome();
  try {
    const run = beginTrade(store, "FIRST", 3),
      at = store.read().seed.clock + 1;
    fillTrade(store, run, "entry", 1, undefined, at);
    fillTrade(store, run, "entry", 1, undefined, at);
    cancelOrder(store, run);
    closeTrade(store, run, "10100");
    const v = store.exportEvidence();
    const r = verifyCostOutcomeExport(encode(v), {
      config: c,
      exportHash: v.exportHash,
    }).report;
    assert.deepEqual(r, store.report());
    const postings = r.financialEvidence.trades[0]!.postings;
    assert.equal(postings[0]!.fill.at, postings[1]!.fill.at);
    assert.notEqual(postings[0]!.fill.fillId, postings[1]!.fill.fillId);
  } finally {
    repo.close();
  }
});

test("COE-06 old snapshot cannot substitute for the pinned later snapshot", () => {
  const { repo, store, c } = openedOutcome();
  try {
    const old = store.exportEvidence();
    beginTrade(store);
    const latest = store.exportEvidence();
    assert.throws(
      () =>
        verifyCostOutcomeExport(encode(old), {
          config: c,
          exportHash: latest.exportHash,
        }),
      /HASH_MISMATCH/,
    );
    assert.equal(
      verifyCostOutcomeExport(encode(old), {
        config: c,
        exportHash: old.exportHash,
      }).report.source.revision,
      0,
    );
  } finally {
    repo.close();
  }
});

test("COE-07 a changed trusted config and missing pin are rejected", () => {
  const { repo, store, c } = fixture();
  try {
    const v = store.exportEvidence(),
      config = structuredClone(c);
    config.runId = "another";
    assert.throws(
      () =>
        verifyCostOutcomeExport(encode(v), {
          config,
          exportHash: v.exportHash,
        }),
      /CONFIG_MISMATCH/,
    );
    assert.throws(
      () => verifyCostOutcomeExport(encode(v), { config: c, exportHash: "" }),
      /ANCHOR_REQUIRED/,
    );
    v.config.seed.clock++;
    repin(v);
    assert.throws(
      () =>
        verifyCostOutcomeExport(encode(v), {
          config: c,
          exportHash: v.exportHash,
        }),
      /CONFIG_MISMATCH/,
    );
  } finally {
    repo.close();
  }
});

const mutations: [string, (v: CostOutcomeExport) => void, RegExp][] = [
  [
    "receipt",
    (v) => {
      v.records[0]!.receipt.stateHash = "0".repeat(64);
    },
    /RECEIPT_MISMATCH/,
  ],
  [
    "revision",
    (v) => {
      v.records[0]!.input.expectedRevision++;
    },
    /COMMAND_MISMATCH/,
  ],
  [
    "state hash",
    (v) => {
      v.records[0]!.input.expectedStateHash = "0".repeat(64);
    },
    /COMMAND_MISMATCH/,
  ],
  [
    "epoch",
    (v) => {
      v.records[1]!.input.epoch = 0;
    },
    /SCHEMA_INVALID/,
  ],
  [
    "duplicate command ID",
    (v) => {
      v.records[1]!.id = v.records[0]!.id;
    },
    /COMMAND_MISMATCH/,
  ],
  [
    "reorder",
    (v) => {
      [v.records[0], v.records[1]] = [v.records[1]!, v.records[0]!];
    },
    /COMMAND_MISMATCH/,
  ],
  [
    "missing first",
    (v) => {
      v.records.shift();
    },
    /COMMAND_MISMATCH/,
  ],
  [
    "missing last",
    (v) => {
      v.records.pop();
    },
    /REPORT_MISMATCH/,
  ],
  [
    "report money",
    (v) => {
      v.report.financialEvidence.accounts[0]!.cash = "0";
    },
    /REPORT_MISMATCH/,
  ],
  [
    "report label",
    (v) => {
      v.report.learningEvidence.records = [];
    },
    /REPORT_MISMATCH/,
  ],
  [
    "report hash",
    (v) => {
      v.report.reportHash = "0".repeat(64);
    },
    /REPORT_MISMATCH/,
  ],
  [
    "record extra",
    (v) => {
      Object.assign(v.records[0]!, { unexpected: true });
    },
    /SCHEMA_INVALID/,
  ],
  [
    "unsafe flag",
    (v) => {
      Object.assign(v, { learningAllowed: true });
    },
    /SCHEMA_INVALID/,
  ],
  [
    "version",
    (v) => {
      Object.assign(v, { kind: "FUTURE" });
    },
    /SCHEMA_INVALID/,
  ],
  [
    "policy",
    (v) => {
      v.policyHash = "0".repeat(64);
    },
    /SCHEMA_INVALID/,
  ],
];
for (const [name, change, error] of mutations)
  test(`COE-08 ${name} is rejected even with a recomputed envelope hash`, () => {
    const { repo, store, c } = fixture();
    try {
      const v = store.exportEvidence();
      change(v);
      repin(v);
      assert.throws(
        () =>
          verifyCostOutcomeExport(encode(v), {
            config: c,
            exportHash: v.exportHash,
          }),
        error,
      );
    } finally {
      repo.close();
    }
  });

test("COE-09 byte/depth/node/nonfinite limits run before schema/replay", () => {
  const c = outcomeConfig(),
    anchor = { config: c, exportHash: "0".repeat(64) };
  for (const [text, error] of [
    ["{", /JSON_INVALID/],
    [" ".repeat(MAX_COST_EXPORT_BYTES + 1), /SIZE_LIMIT/],
    [
      JSON.stringify("한".repeat(Math.ceil(MAX_COST_EXPORT_BYTES / 3))),
      /SIZE_LIMIT/,
    ],
    ["[".repeat(66) + "0" + "]".repeat(66), /STRUCTURE_LIMIT/],
    ["[" + "0,".repeat(500000) + "0]", /STRUCTURE_LIMIT/],
    ['{"value":1e400}', /NONFINITE_NUMBER/],
  ] as const)
    assert.throws(() => verifyCostOutcomeExport(text, anchor), error);
});

test("COE-10 invalid export does not create directories; repeated saves never overwrite", () => {
  const { repo, store, c } = fixture();
  try {
    const v = store.exportEvidence(),
      anchor = { config: c, exportHash: v.exportHash },
      base = fresh();
    assert.throws(
      () =>
        saveCostOutcomeExport(
          v,
          { ...anchor, exportHash: "0".repeat(64) },
          base,
        ),
      /HASH_MISMATCH/,
    );
    assert.deepEqual(readdirSync(base), []);
    const first = saveCostOutcomeExport(v, anchor, base),
      bytes = readFileSync(first);
    const second = saveCostOutcomeExport(v, anchor, base);
    assert.notEqual(first, second);
    assert.deepEqual(readFileSync(first), bytes);
    assert.deepEqual(readdirSync(dirname(first)), ["result.json"]);
    // Whitespace is not financial evidence; hash is canonical JSON, not bytes.
    writeFileSync(second, JSON.stringify(v, null, 2));
    assert.deepEqual(
      verifyCostOutcomeExportFile(second, anchor).report,
      v.report,
    );
  } finally {
    repo.close();
  }
});

test("COE-11 local file boundary rejects broken UTF8, truncation, oversize, directories and network paths", () => {
  const { repo, store, c } = openedOutcome();
  try {
    const v = store.exportEvidence(),
      anchor = { config: c, exportHash: v.exportHash },
      base = fresh(),
      path = join(base, "bad.json");
    writeFileSync(path, Buffer.from([0xc3, 0x28]));
    assert.throws(
      () => verifyCostOutcomeExportFile(path, anchor),
      /READ_FAILED/,
    );
    writeFileSync(path, encode(v).slice(0, -8));
    assert.throws(
      () => verifyCostOutcomeExportFile(path, anchor),
      /JSON_INVALID/,
    );
    const fd = openSync(path, "w");
    try {
      ftruncateSync(fd, MAX_COST_EXPORT_BYTES + 1);
    } finally {
      closeSync(fd);
    }
    assert.throws(
      () => verifyCostOutcomeExportFile(path, anchor),
      /SIZE_LIMIT/,
    );
    const dir = join(base, "directory.json");
    mkdirSync(dir);
    assert.throws(
      () => verifyCostOutcomeExportFile(dir, anchor),
      /REGULAR_FILE_REQUIRED/,
    );
    for (const p of [
      "https://host/x.json",
      "\\\\host\\x.json",
      "//host/x.json",
      "C:relative.json",
      "a.json:secret",
      "\\\\?\\C:\\x.json",
    ])
      assert.throws(
        () => verifyCostOutcomeExportFile(p, anchor),
        /LOCAL_PATH_REQUIRED/,
      );
    assert.throws(
      () => verifyCostOutcomeExportFile(join(base, "result.partial"), anchor),
      /JSON_FILE_REQUIRED/,
    );
  } finally {
    repo.close();
  }
});

test("COE-12 junction ancestor is rejected on save and read", () => {
  const { repo, store, c } = openedOutcome();
  try {
    const v = store.exportEvidence(),
      anchor = { config: c, exportHash: v.exportHash },
      base = fresh(),
      target = fresh();
    const link = join(base, "alias");
    symlinkSync(target, link, "junction");
    assert.throws(
      () => saveCostOutcomeExport(v, anchor, link),
      /LOCAL_DIRECTORY_REQUIRED/,
    );
    assert.throws(
      () => verifyCostOutcomeExportFile(join(link, "x.json"), anchor),
      /LOCAL_DIRECTORY_REQUIRED/,
    );
    assert.deepEqual(readdirSync(target), []);
  } finally {
    repo.close();
  }
});

test("COE-13 V1/V2 cannot be exported under V3 contract", () => {
  for (const config of [reservationConfig(), handoffConfig()]) {
    const repo = new Repository(":memory:", () => 1000);
    repo.acquire();
    try {
      const store = new CostReservationStore(repo, config, {
        initialize: true,
      });
      const dump = () => ({
        state: store.read(),
        commands: repo.db
          .prepare("SELECT * FROM cost_reservation_commands")
          .all(),
        audits: repo.db.prepare("SELECT * FROM audit").all(),
        writer: repo.db.prepare("SELECT * FROM writer").all(),
      });
      const before = dump();
      assert.throws(() => store.exportEvidence(), /V3_REQUIRED/);
      assert.deepEqual(dump(), before);
    } finally {
      repo.close();
    }
  }
});

test("COE-14 source audit corruption is rejected without repairing the database", () => {
  const { repo, store } = fixture();
  try {
    repo.db
      .prepare(
        "UPDATE audit SET checksum=? WHERE seq=(SELECT MAX(seq) FROM audit)",
      )
      .run("0".repeat(64));
    const before = dumpHandoff(repo);
    assert.throws(() => store.exportEvidence());
    assert.deepEqual(dumpHandoff(repo), before);
    assert.equal(repo.db.prepare("SELECT 1 AS n").get()!.n, 1);
  } finally {
    repo.close();
  }
});

test("COE-15 export across every writer stage contains only a whole committed snapshot", () => {
  const path = join(fresh(), "test.sqlite"),
    { repo, store, c } = openedOutcome(outcomeConfig(), path);
  const run = beginTrade(store);
  fillTrade(store, run);
  sellOrder(store, run, "10100");
  const reader = new Repository(path, () => 1000);
  try {
    reader.db.exec("PRAGMA query_only=ON");
    const view = new CostReservationStore(reader, c),
      before = view.exportEvidence(),
      seen: string[] = [];
    const writer = new CostReservationStore(repo, c, {
      testStage(stage) {
        const value = view.exportEvidence();
        assert.deepEqual(value, before);
        assert.deepEqual(
          verifyCostOutcomeExport(encode(value), {
            config: c,
            exportHash: before.exportHash,
          }).report,
          before.report,
        );
        seen.push(stage);
      },
    });
    fillTrade(writer, run, "exit", 1, "10100");
    assert.deepEqual(seen, [
      "COMMAND",
      "APPROVALS",
      "FILL_INDEX",
      "STATE",
      "AUDIT",
    ]);
    const after = view.exportEvidence();
    assert.notEqual(after.exportHash, before.exportHash);
    assert.deepEqual(after, writer.exportEvidence());
  } finally {
    reader.db.exec("PRAGMA query_only=OFF");
    reader.close();
    repo.close();
  }
});

test("COE-16 reacquired writer keeps original epoch and replay rejects a backwards epoch", () => {
  const path = join(fresh(), "test.sqlite"),
    { repo, store, c } = openedOutcome(outcomeConfig(), path);
  beginTrade(store);
  repo.close();
  const second = new Repository(path, () => 1000);
  second.acquire();
  try {
    const resumed = new CostReservationStore(second, c);
    fillTrade(resumed, resumed.read().handoff!.transfers[0]!.runId);
    closeTrade(resumed, resumed.read().handoff!.transfers[0]!.runId, "10100");
    const value = resumed.exportEvidence(),
      anchor = { config: c, exportHash: value.exportHash };
    assert.equal(value.initialEpoch, 1);
    assert.equal(value.report.source.epoch, 2);
    assert.deepEqual(
      verifyCostOutcomeExport(encode(value), anchor).report,
      resumed.report(),
    );
    value.records.at(-1)!.input.epoch = 1;
    repin(value);
    assert.throws(
      () =>
        verifyCostOutcomeExport(encode(value), {
          ...anchor,
          exportHash: value.exportHash,
        }),
      /COMMAND_MISMATCH/,
    );
  } finally {
    second.close();
  }
});

test("COE-17 appended duplicate fill is rejected, not silently deduplicated", () => {
  const { repo, store, c } = fixture();
  try {
    const value = store.exportEvidence(),
      record = structuredClone(value.records.at(-1)!);
    assert.equal(record.input.command.kind, "EXECUTION");
    record.id = "duplicate-delivery";
    record.input.expectedRevision = value.report.source.revision;
    record.input.expectedStateHash = value.report.source.stateHash;
    value.records.push(record);
    repin(value);
    assert.throws(
      () =>
        verifyCostOutcomeExport(encode(value), {
          config: c,
          exportHash: value.exportHash,
        }),
      /COMMAND_MISMATCH/,
    );
  } finally {
    repo.close();
  }
});

test("COE-18 record count cap and report extra fields are rejected", () => {
  const { repo, store, c } = fixture();
  try {
    const value = store.exportEvidence(),
      extra = structuredClone(value);
    Object.assign(extra.report, { unexpected: "ignored?" });
    repin(extra);
    assert.throws(
      () =>
        verifyCostOutcomeExport(encode(extra), {
          config: c,
          exportHash: extra.exportHash,
        }),
      /REPORT_MISMATCH/,
    );
    value.records = Array.from({ length: 5201 }, () => value.records.at(-1)!);
    repin(value);
    assert.throws(
      () =>
        verifyCostOutcomeExport(encode(value), {
          config: c,
          exportHash: value.exportHash,
        }),
      /SCHEMA_INVALID/,
    );
  } finally {
    repo.close();
  }
});
