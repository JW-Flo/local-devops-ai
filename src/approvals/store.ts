import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "../config.js";
import type { TaskRequest } from "../task-schema.js";

export type PendingApproval = {
  id: string;
  task: TaskRequest;
  createdAt: string;
};

export class ApprovalStore {
  private readonly filePath: string;

  constructor() {
    const dir = join(config.cacheDir, "state");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.filePath = join(dir, "approvals.json");
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, JSON.stringify({ items: [] }, null, 2));
    }
  }

  private read(): PendingApproval[] {
    const raw = readFileSync(this.filePath, "utf8");
    return (JSON.parse(raw).items as PendingApproval[]) ?? [];
  }

  private write(items: PendingApproval[]) {
    writeFileSync(this.filePath, JSON.stringify({ items }, null, 2));
  }

  add(task: TaskRequest): PendingApproval {
    const item: PendingApproval = {
      id: crypto.randomUUID(),
      task,
      createdAt: new Date().toISOString(),
    };
    const items = this.read();
    items.push(item);
    this.write(items);
    return item;
  }

  list(): PendingApproval[] {
    return this.read();
  }

  pop(id: string): PendingApproval | undefined {
    const items = this.read();
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return undefined;
    const [item] = items.splice(index, 1);
    this.write(items);
    return item;
  }
}
