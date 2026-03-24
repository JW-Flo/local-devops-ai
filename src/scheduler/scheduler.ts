import cron from "node-cron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "../config.js";
import type { TaskRequest } from "../task-schema.js";
import { TaskOrchestrator } from "../orchestrator.js";

export type ScheduledTask = {
  id: string;
  cron: string;
  task: TaskRequest;
};

export class Scheduler {
  private readonly filePath: string;
  private readonly jobs = new Map<string, cron.ScheduledTask>();

  constructor(private readonly orchestrator: TaskOrchestrator) {
    const dir = join(config.cacheDir, "state");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.filePath = join(dir, "schedules.json");
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, JSON.stringify({ items: [] }, null, 2));
    }
    this.bootstrap();
  }

  private bootstrap() {
    const schedules = this.list();
    for (const schedule of schedules) {
      this.register(schedule);
    }
  }

  private persist(schedules: ScheduledTask[]) {
    writeFileSync(this.filePath, JSON.stringify({ items: schedules }, null, 2));
  }

  list(): ScheduledTask[] {
    const raw = readFileSync(this.filePath, "utf8");
    return (JSON.parse(raw).items as ScheduledTask[]) ?? [];
  }

  add(cronExpr: string, task: TaskRequest): ScheduledTask {
    const schedule: ScheduledTask = {
      id: crypto.randomUUID(),
      cron: cronExpr,
      task,
    };
    const schedules = this.list();
    schedules.push(schedule);
    this.persist(schedules);
    this.register(schedule);
    return schedule;
  }

  remove(id: string): boolean {
    const schedules = this.list();
    const index = schedules.findIndex((item) => item.id === id);
    if (index === -1) return false;
    schedules.splice(index, 1);
    this.persist(schedules);
    const job = this.jobs.get(id);
    job?.stop();
    this.jobs.delete(id);
    return true;
  }

  private register(schedule: ScheduledTask) {
    const job = cron.schedule(schedule.cron, async () => {
      console.log(`Executing scheduled task ${schedule.id}`);
      await this.orchestrator.submit(schedule.task);
    });
    this.jobs.set(schedule.id, job);
  }
}
