import { LocalRunner } from "../executors/local-runner.js";

export class GitTool {
  constructor(private readonly runner = new LocalRunner()) {}

  async status(cwd?: string) {
    return this.runner.run("git", ["status", "-sb"], { cwd });
  }

  async applyPatch(patchPath: string, cwd?: string) {
    return this.runner.run("git", ["apply", patchPath], { cwd });
  }

  async commit(message: string, cwd?: string, dryRun = true) {
    return this.runner.run("git", ["commit", "-am", message], { cwd, dryRun });
  }

  async exec(args: string[], cwd?: string, dryRun = true) {
    return this.runner.run("git", args, { cwd, dryRun });
  }
}
