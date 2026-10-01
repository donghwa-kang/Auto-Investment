import {
  labWithSell,
  request,
} from "../dist/runtime/tests/broker-control-helpers.js";
const [path, status] = process.argv.slice(2);
if (!path || !["UNKNOWN", "CANCEL_UNKNOWN"].includes(status))
  throw Error("OWNED_TEST_ARGUMENTS_REQUIRED");
const lab = labWithSell(status, path, true);
const at = lab.state().clock;
lab.command("us-enqueue", {
  kind: "CONTROL",
  command: {
    kind: "ENQUEUE",
    at,
    request: request("us-stall", "MONITOR", at, {
      routeId: "sim-us-read",
      timeoutMs: 100,
    }),
  },
});
lab.command("us-dispatch", {
  kind: "CONTROL",
  command: { kind: "DISPATCH", at, worker: "sim-us-worker" },
});
let dropped = 0;
for (let i = 0; i < 30; i++) {
  try {
    lab.command(`scan-${i}`, {
      kind: "CONTROL",
      command: {
        kind: "ENQUEUE",
        at,
        request: request(`scan-${i}`, "SCAN", at),
      },
    });
  } catch (error) {
    if (!/CONTROL_QUEUE_CAPACITY/.test(String(error))) throw error;
    dropped++;
  }
}
lab.command("safety-enqueue", {
  kind: "CONTROL",
  command: {
    kind: "ENQUEUE",
    at,
    request: request("kr-safety", "ORDER_QUERY", at, {
      caseId: "sim-case",
      timeoutMs: 100,
    }),
  },
});
lab.command("safety-dispatch", {
  kind: "CONTROL",
  command: { kind: "DISPATCH", at, worker: "sim-kr-worker" },
});
lab.command("timeout", {
  kind: "CONTROL",
  command: { kind: "ADVANCE", at: at + 100 },
});
process.send?.({ state: lab.state(), dropped });
setInterval(() => lab.repo.heartbeat(), 1000);
