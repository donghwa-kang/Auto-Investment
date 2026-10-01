import { parentPort, workerData } from "node:worker_threads";
import {
  verifyCostLearningInput,
  type CostLearningInputAnchor,
} from "./cost-learning-input.js";
// No Repository, writer, DB path, account credential or provider client.
const input = workerData as { text: string; anchor: CostLearningInputAnchor };
try {
  const result = verifyCostLearningInput(input.text, input.anchor);
  const envelope = JSON.parse(input.text) as { operatingEvidenceText: string };
  parentPort!.postMessage({
    result,
    downloads: {
      input: input.text,
      financial: envelope.operatingEvidenceText,
      anchor: JSON.stringify(input.anchor),
      result: JSON.stringify(result),
    },
  });
} catch (e) {
  parentPort!.postMessage({
    error:
      e instanceof Error && /^[A-Z_0-9]+$/.test(e.message)
        ? e.message
        : "COST_APP_VERIFY_FAILED",
  });
} finally {
  parentPort!.close();
}
