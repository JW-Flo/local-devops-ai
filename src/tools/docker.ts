import { LocalRunner } from "../executors/local-runner.js";

export class DockerTool {
  constructor(private readonly runner = new LocalRunner()) {}

  async compose(args: string[], cwd?: string, dryRun = true) {
    return this.runner.run("docker", ["compose", ...args], { cwd, dryRun });
  }

  async docker(args: string[], dryRun = true) {
    return this.runner.run("docker", args, { dryRun });
  }
}
