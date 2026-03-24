import { LocalRunner } from "../executors/local-runner.js";

export class ShellTool {
  constructor(private readonly runner = new LocalRunner()) {}

  async run(command: string, args: string[], options?: { cwd?: string; dryRun?: boolean }) {
    return this.runner.run(command, args, options);
  }
}
