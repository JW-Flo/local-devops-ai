import { config } from "./config.js";
import type { TaskRequest } from "./task-schema.js";
import { getContextForTask } from "./knowledge/context.js";

export type ModelResponse = {
  model: string;
  output: string;
  tokens: number;
  durationMs: number;
};

// Task-type-specific system prompts for much better output quality
const SYSTEM_PROMPTS: Record<string, string> = {
  plan: `You are a senior infrastructure architect producing implementation plans.
Output a JSON object with: {"plan":"high-level approach","steps":[{"step":1,"action":"what to do","rationale":"why","files":["affected paths"]}],"risks":["potential issues"],"estimate":"time estimate"}
Be specific about file paths, commands, and configurations. No vague suggestions.`,

  code: `You are an expert developer writing production code.
Output a JSON object with: {"plan":"what you're building","files":[{"path":"file path","action":"create|modify|delete","content":"full file content or diff description"}],"tests":["test scenarios to verify"],"commands":["shell commands to run after"]}
Write complete, working code. Include error handling. Follow existing project conventions.`,

  diagnose: `You are a senior SRE diagnosing a production issue.
Output a JSON object with: {"hypothesis":"most likely cause","evidence":["supporting observations"],"investigation":[{"step":1,"command":"diagnostic command","expect":"what to look for"}],"remediation":"fix once confirmed","prevention":"how to prevent recurrence"}
Be systematic. Start with most likely cause. Include specific commands.`,

  review: `You are a principal engineer reviewing code for security, correctness, and maintainability.
Output a JSON object with: {"summary":"overall assessment","findings":[{"severity":"critical|high|medium|low","category":"security|correctness|performance|style","location":"file:line","issue":"description","fix":"suggested fix"}],"approved":true|false}
Focus on bugs, security holes, and architectural issues. Skip nitpicks.`,

  execute: `You are an autonomous DevOps engineer executing approved changes.
Output a JSON object with: {"plan":"execution plan","steps":[{"step":1,"command":"exact command","expected":"expected output","rollback":"undo command"}],"results":[]}
Include rollback commands for every step. Log everything.`,
};

export class ModelRouter {
  selectModel(task: TaskRequest): string {
    if (task.type === "code") return config.codeModel;
    return config.primaryModel;
  }

  buildPrompt(task: TaskRequest, knowledgeContext: string): string {
    const sections: string[] = [];
    sections.push(`OBJECTIVE: ${task.objective}`);

    if (task.tools.length) {
      sections.push(`AVAILABLE TOOLS: ${task.tools.join(", ")}`);
    }
    if (task.contextPaths.length) {
      sections.push(`TARGET FILES: ${task.contextPaths.join(", ")}`);
    }
    if (knowledgeContext) {
      sections.push(`PROJECT CONTEXT:\n${knowledgeContext}`);
    }
    if (task.metadata) {
      // Pass through any tool-specific metadata as context
      const metaKeys = Object.keys(task.metadata).filter((k) => k !== "github");
      if (metaKeys.length) {
        sections.push(`METADATA: ${JSON.stringify(task.metadata, null, 0).slice(0, 300)}`);
      }
    }

    const guardrail = task.dryRun
      ? "MODE: DRY RUN — output plan and commands only, do NOT execute."
      : "MODE: EXECUTE — run approved steps and report results.";
    sections.push(guardrail);

    return sections.join("\n\n");
  }

  async run(task: TaskRequest): Promise<ModelResponse> {
    const model = this.selectModel(task);
    const knowledgeContext = await getContextForTask(task);
    const prompt = this.buildPrompt(task, knowledgeContext);
    const systemPrompt = SYSTEM_PROMPTS[task.type] ?? SYSTEM_PROMPTS.plan;
    const started = performance.now();

    const res = await fetch(`${config.ollamaHost}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        stream: false,
        options: {
          temperature: task.type === "code" ? 0.1 : config.temperature,
          num_ctx: task.type === "code" ? 3072 : config.maxTokens,
          num_gpu: Number(process.env.OLLAMA_NUM_GPU ?? 28),
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama error (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      message: { content: string };
      eval_count?: number;
    };

    return {
      model,
      output: data.message?.content ?? "",
      tokens: data.eval_count ?? 0,
      durationMs: performance.now() - started,
    };
  }
}
