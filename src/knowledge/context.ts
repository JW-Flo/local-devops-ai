import type { TaskRequest } from "../task-schema.js";
import { knowledgeStore } from "./store.js";

export async function getContextForTask(task: TaskRequest): Promise<string> {
  try {
    const snippets = await knowledgeStore.query(task.objective, 4);
    if (!snippets.length) {
      return "";
    }
    return snippets
      .map((snippet, idx) => `Context #${idx + 1}:\n${snippet.trim()}`)
      .join("\n---\n");
  } catch (err) {
    console.warn("Knowledge retrieval failed", err);
    return "";
  }
}
