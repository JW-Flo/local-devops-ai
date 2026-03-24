import { LocalRunner } from "../executors/local-runner.js";

export class KubernetesTool {
  constructor(private readonly runner = new LocalRunner()) {}

  async kubectl(args: string[], kubeconfig?: string, dryRun = true) {
    const finalArgs = kubeconfig ? ["--kubeconfig", kubeconfig, ...args] : args;
    return this.runner.run("kubectl", finalArgs, { dryRun });
  }
}
