import { LocalRunner } from "../executors/local-runner.js";
import { config } from "../config.js";

export type HelmUpgradeOptions = {
  release: string;
  chart: string;
  namespace?: string;
  valuesFiles?: string[];
  set?: Record<string, string>;
  kubeconfig?: string;
  cwd?: string;
  dryRun?: boolean;
};

export class HelmTool {
  constructor(private readonly runner = new LocalRunner()) {}

  async upgradeInstall(options: HelmUpgradeOptions) {
    const args = ["upgrade", options.release, options.chart, "--install"];
    if (options.namespace) {
      args.push("--namespace", options.namespace);
    }
    const kubeconfig = options.kubeconfig ?? config.kubeconfigPath;
    if (kubeconfig) {
      args.push("--kubeconfig", kubeconfig);
    }
    options.valuesFiles?.forEach((file) => {
      args.push("-f", file);
    });
    if (options.set) {
      const setArgs = Object.entries(options.set).map(([key, value]) => `${key}=${value}`);
      if (setArgs.length) {
        args.push("--set", setArgs.join(","));
      }
    }
    if (options.dryRun ?? true) {
      args.push("--dry-run");
    }
    return this.runner.run("helm", args, { cwd: options.cwd, dryRun: options.dryRun });
  }
}
