import { LocalRunner } from "../executors/local-runner.js";
import { config } from "../config.js";

export type FluxReconcileOptions = {
  kind: "kustomization" | "helmrelease" | "alert" | "receiver";
  name: string;
  namespace?: string;
  kubeconfig?: string;
  dryRun?: boolean;
};

export class FluxTool {
  constructor(private readonly runner = new LocalRunner()) {}

  async reconcile(options: FluxReconcileOptions) {
    const args = ["reconcile", options.kind, options.name];
    if (options.namespace) {
      args.push("--namespace", options.namespace);
    }
    const kubeconfig = options.kubeconfig ?? config.kubeconfigPath;
    if (kubeconfig) {
      args.push("--kubeconfig", kubeconfig);
    }
    if (options.dryRun ?? true) {
      args.push("--dry-run");
    }
    return this.runner.run("flux", args, { dryRun: options.dryRun });
  }
}
