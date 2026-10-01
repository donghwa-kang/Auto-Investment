import { readFileSync } from "node:fs";

// Owned test-only process. The parent supplies the compiled module directory
// and persists the original request before dispatch; no API/account access.
const [path, stage, modules] = process.argv.slice(2);
if (
  !process.send ||
  !path ||
  !modules ||
  !["STATE", "COMMITTED"].includes(stage)
)
  throw Error("LOOP_CLOSE_TEST_ARGUMENTS");
const { Repository } = await import(new URL("repository.js", modules).href);
const { CostReservationStore } = await import(
  new URL("cost-reservation-store.js", modules).href
);
const intent = JSON.parse(readFileSync(`${path}.intent.json`, "utf8"));
const repo = new Repository(path, () => 20000);
repo.acquire();
const store = new CostReservationStore(repo, intent.config, {
  testStage: (point) => {
    if (point === stage) {
      process.send({ stage });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  },
});
store.finalizeOperating(
  intent.commandId,
  intent.closeId,
  intent.request,
  intent.expected,
);
if (stage === "COMMITTED")
  process.send({ stage }, () =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0),
  );
