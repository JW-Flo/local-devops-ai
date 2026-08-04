import { N8nTool } from "../src/tools/n8n.js";
import { config } from "../src/config.js";

async function main() {
  console.log("N8N_BASE_URL:", config.n8nBaseUrl);
  console.log("N8N_API_KEY set:", Boolean(config.n8nApiKey), "len:", config.n8nApiKey?.length ?? 0);

  const tool = new N8nTool();

  const up = await tool.isAvailable();
  console.log("isAvailable:", up);

  const workflows = await tool.listWorkflows();
  console.log("listWorkflows OK — count:", workflows.length);
  console.log("workflows:", JSON.stringify(workflows.map((w) => ({ id: w.id, name: w.name, active: w.active }))));

  const execs = (await tool.listExecutions(5)) as { data?: unknown[] };
  console.log("listExecutions OK — count:", Array.isArray(execs.data) ? execs.data.length : "n/a");

  const dry = await tool.trigger("demo-webhook", { payload: { hello: "world" }, dryRun: true });
  console.log("trigger dryRun:", JSON.stringify(dry));

  console.log("N8N-VERIFY-PASS");
}

main().catch((err) => {
  console.error("N8N-VERIFY-FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
