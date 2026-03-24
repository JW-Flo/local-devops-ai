import { LocalRunner } from "../executors/local-runner.js";

export class TerraformTool {
  constructor(private readonly runner = new LocalRunner()) {}

  async init(cwd: string, dryRun = true) {
    return this.runner.run("terraform", ["init"], { cwd, dryRun });
  }

  async plan(cwd: string, outFile = "plan.tfplan", dryRun = true) {
    return this.runner.run("terraform", ["plan", "-out", outFile], { cwd, dryRun });
  }

  async apply(cwd: string, planFile = "plan.tfplan", dryRun = true) {
    return this.runner.run("terraform", ["apply", planFile], { cwd, dryRun });
  }
}
