/** Persistent worker: filesystem scans, parsing and aggregation stay off HTTP's event loop. */
import { parentPort } from "node:worker_threads";
import { createUsageReader, summarizeUsage, type UsageTarget } from "./usage";

const reader = createUsageReader();
parentPort!.on("message", ({ targets, nowMs }: { targets: UsageTarget[]; nowMs: number }) => {
  try {
    parentPort!.postMessage({ report: summarizeUsage(reader.read(targets), nowMs) });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
