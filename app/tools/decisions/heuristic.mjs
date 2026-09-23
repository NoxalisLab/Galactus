// Runs the shipping heuristic, detectTask() from app/src/autotask.ts, on JSON lines from stdin.
// Input line: {"id", "text", "previous"?}; output line: {"id", "task", "confidence", "ms"}.
// Dev tool: builds the --heuristic-json file for `learn.py evaluate --hand-test` (see README).
// autotask.ts is compiled into .build/ with the app's own tsc (not copied, not edited).
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";

const mod = await import(new URL("./.build/autotask.js", import.meta.url));
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  const { id, text, previous } = JSON.parse(line);
  const t0 = performance.now();
  const d = mod.detectTask(text, previous ?? "general");
  const ms = performance.now() - t0;
  process.stdout.write(JSON.stringify({ id, task: d.task, confidence: d.confidence, ms }) + "\n");
}
