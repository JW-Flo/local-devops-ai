import { LocalRunner } from "../executors/local-runner.js";
import { config } from "../config.js";

export type PlaybookOptions = {
  playbook: string;
  inventory?: string;
  extraVars?: Record<string, unknown>;
  cwd?: string;
  dryRun?: boolean;
};

export class AnsibleTool {
  constructor(private readonly runner = new LocalRunner()) {}

  async runPlaybook(options: PlaybookOptions) {
    const args: string[] = [];
    const inventory = options.inventory ?? config.ansibleInventory;
    if (inventory) {
      args.push("-i", inventory);
    }
    if (options.extraVars && Object.keys(options.extraVars).length > 0) {
      args.push("--extra-vars", JSON.stringify(options.extraVars));
    }
    if (options.dryRun ?? true) {
      args.push("--check");
    }
    args.push(options.playbook);

    return this.runner.run("ansible-playbook", args, {
      cwd: options.cwd ?? config.workspaceRoot,
      dryRun: options.dryRun,
    });
  }
}
