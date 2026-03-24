import { LocalRunner } from "../executors/local-runner.js";

export type OpenClawOptions = {
  agent?: string;
  deliver?: boolean;
  dryRun?: boolean;
};

export class OpenClawTool {
  constructor(private readonly runner = new LocalRunner()) {}

  async agentMessage(message: string, options?: OpenClawOptions) {
    const args = ["agent", "--message", message, "--json"];
    if (options?.agent) {
      args.push("--agent", options.agent);
    }
    if (options?.deliver) {
      args.push("--deliver");
    }
    return this.runner.run("openclaw", args, { dryRun: options?.dryRun });
  }
}
