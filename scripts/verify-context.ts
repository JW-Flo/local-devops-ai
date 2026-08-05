import { getContextForTask } from "../src/knowledge/context.js";
import { TaskSchema } from "../src/task-schema.js";

async function main() {
  const task = TaskSchema.parse({
    type: "plan",
    objective: "key events and causes of the French Revolution",
    tools: [],
    dryRun: true,
  });
  const ctx = await getContextForTask(task);
  console.log("context length:", ctx.length);
  console.log("--- context ---");
  console.log(ctx.slice(0, 600));
  console.log("---");
  console.log(ctx.includes("Wikipedia") ? "CONTEXT-BRIDGE-PASS (Wikipedia augmented)" : "no Wikipedia section (vector had >=2 hits, or kiwix miss)");
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
