import PQueue from "p-queue";
import { ModelRouter } from "./model-router.js";
import { GitTool } from "./tools/git.js";
import { TerraformTool } from "./tools/terraform.js";
import { KubernetesTool } from "./tools/kubernetes.js";
import { DockerTool } from "./tools/docker.js";
import { ShellTool } from "./tools/shell.js";
import { OpenClawTool } from "./tools/openclaw.js";
import { AnsibleTool } from "./tools/ansible.js";
import { HelmTool } from "./tools/helm.js";
import { FluxTool } from "./tools/flux.js";
import { ObservabilityTool } from "./tools/observability.js";
import { githubTool } from "./tools/github.js";
import type { TaskRequest } from "./task-schema.js";
import { ApprovalStore, type PendingApproval } from "./approvals/store.js";
import { memoryStore } from "./memory/store.js";

export type TaskResult = {
  id: string;
  task: TaskRequest;
  llm: {
    model: string;
    output: string;
    tokens: number;
    durationMs: number;
  };
  actions: Array<{ tool: string; result: unknown }>;
  timestamp: string;
};

export type PendingResult = {
  status: "pending";
  pending: PendingApproval;
};

export class TaskOrchestrator {
  private readonly queue = new PQueue({ concurrency: 2 });
  private readonly router = new ModelRouter();
  private readonly approvals = new ApprovalStore();
  private readonly tools = {
    git: new GitTool(),
    terraform: new TerraformTool(),
    kubernetes: new KubernetesTool(),
    docker: new DockerTool(),
    shell: new ShellTool(),
    openclaw: new OpenClawTool(),
    ansible: new AnsibleTool(),
    helm: new HelmTool(),
    flux: new FluxTool(),
    observability: new ObservabilityTool(),
  } as const;

  submit(task: TaskRequest): Promise<TaskResult | PendingResult> {
    if (task.approvalRequired && task.dryRun === false) {
      const pending = this.approvals.add(task);
      return Promise.resolve({ status: "pending", pending });
    }
    return this.queue.add<TaskResult>(() => this.execute(task)) as Promise<TaskResult>;
  }

  async approve(id: string): Promise<TaskResult> {
    const pending = this.approvals.pop(id);
    if (!pending) {
      throw new Error("Approval not found");
    }
    return this.queue.add<TaskResult>(() => this.execute(pending.task)) as Promise<TaskResult>;
  }

  reject(id: string): boolean {
    const pending = this.approvals.pop(id);
    return Boolean(pending);
  }

  listApprovals() {
    return this.approvals.list();
  }

  private async execute(task: TaskRequest): Promise<TaskResult> {
    const llm = await this.router.run(task);
    const actions: Array<{ tool: string; result: unknown }> = [];
    const getToolMeta = <T = Record<string, unknown>>(name: string): T | undefined => {
      const meta = task.metadata?.[name];
      return (meta as T) ?? undefined;
    };

    for (const tool of task.tools) {
      switch (tool) {
        case "git": {
          const meta = getToolMeta<{ command?: string; message?: string; patchPath?: string; args?: string[]; cwd?: string }>("git");
          const cwd = meta?.cwd ?? task.contextPaths[0];
          if (meta?.command === "commit" && meta.message) {
            actions.push({ tool, result: await this.tools.git.commit(meta.message, cwd, task.dryRun) });
          } else if (meta?.command === "apply" && meta.patchPath) {
            actions.push({ tool, result: await this.tools.git.applyPatch(meta.patchPath, cwd) });
          } else if (meta?.command === "raw" && meta.args) {
            actions.push({ tool, result: await this.tools.git.exec(meta.args, cwd, task.dryRun) });
          } else {
            actions.push({ tool, result: await this.tools.git.status(cwd) });
          }
          break;
        }
        case "terraform": {
          const meta = getToolMeta<{ action?: "plan" | "apply" | "init"; cwd?: string; planFile?: string }>("terraform");
          const cwd = meta?.cwd ?? task.contextPaths[0];
          if (!cwd) {
            actions.push({ tool, result: { error: "No Terraform working directory provided" } });
            break;
          }
          if (meta?.action === "apply") {
            actions.push({ tool, result: await this.tools.terraform.apply(cwd, meta.planFile ?? "plan.tfplan", task.dryRun) });
          } else if (meta?.action === "init") {
            actions.push({ tool, result: await this.tools.terraform.init(cwd, task.dryRun) });
          } else {
            actions.push({ tool, result: await this.tools.terraform.plan(cwd, meta?.planFile ?? "plan.tfplan", task.dryRun) });
          }
          break;
        }
        case "kubernetes": {
          const meta = getToolMeta<{ args?: string[]; kubeconfig?: string }>("kubernetes");
          const args = meta?.args ?? ["get", "pods", "-A"];
          actions.push({ tool, result: await this.tools.kubernetes.kubectl(args, meta?.kubeconfig, task.dryRun) });
          break;
        }
        case "docker": {
          const meta = getToolMeta<{ subcommand?: "compose" | "cli"; args?: string[]; cwd?: string }>("docker");
          const args = meta?.args ?? ["ps"];
          if (meta?.subcommand === "cli") {
            actions.push({ tool, result: await this.tools.docker.docker(args, task.dryRun) });
          } else {
            actions.push({ tool, result: await this.tools.docker.compose(args, meta?.cwd ?? task.contextPaths[0], task.dryRun) });
          }
          break;
        }
        case "shell": {
          const meta = getToolMeta<{ command?: string; args?: string[] }>("shell");
          const cmd = meta?.command ?? "powershell";
          const args = meta?.args ?? ["Get-Process"];
          actions.push({ tool, result: await this.tools.shell.run(cmd, args, { dryRun: task.dryRun }) });
          break;
        }
        case "openclaw":
          actions.push({
            tool,
            result: await this.tools.openclaw.agentMessage(task.objective, {
              dryRun: task.dryRun,
              agent:
                typeof task.metadata?.openclawAgent === "string"
                  ? (task.metadata.openclawAgent as string)
                  : undefined,
            }),
          });
          break;
        case "ansible": {
          const meta = getToolMeta<{ playbook?: string; inventory?: string; extraVars?: Record<string, unknown>; cwd?: string }>("ansible");
          if (!meta?.playbook) {
            actions.push({ tool, result: { error: "ansible metadata requires playbook" } });
            break;
          }
          actions.push({
            tool,
            result: await this.tools.ansible.runPlaybook({
              playbook: meta.playbook,
              inventory: meta.inventory,
              extraVars: meta.extraVars,
              cwd: meta.cwd ?? task.contextPaths[0],
              dryRun: task.dryRun,
            }),
          });
          break;
        }
        case "helm": {
          const meta = getToolMeta<{
            release?: string;
            chart?: string;
            namespace?: string;
            valuesFiles?: string[];
            set?: Record<string, string>;
            kubeconfig?: string;
            cwd?: string;
          }>("helm");
          if (!meta?.release || !meta.chart) {
            actions.push({ tool, result: { error: "helm metadata requires release + chart" } });
            break;
          }
          actions.push({
            tool,
            result: await this.tools.helm.upgradeInstall({
              release: meta.release,
              chart: meta.chart,
              namespace: meta.namespace,
              valuesFiles: meta.valuesFiles,
              set: meta.set,
              kubeconfig: meta.kubeconfig,
              cwd: meta.cwd ?? task.contextPaths[0],
              dryRun: task.dryRun,
            }),
          });
          break;
        }
        case "flux": {
          const meta = getToolMeta<{ kind?: "kustomization" | "helmrelease" | "alert" | "receiver"; name?: string; namespace?: string; kubeconfig?: string }>("flux");
          if (!meta?.kind || !meta.name) {
            actions.push({ tool, result: { error: "flux metadata requires kind + name" } });
            break;
          }
          actions.push({
            tool,
            result: await this.tools.flux.reconcile({
              kind: meta.kind,
              name: meta.name,
              namespace: meta.namespace,
              kubeconfig: meta.kubeconfig,
              dryRun: task.dryRun,
            }),
          });
          break;
        }
        case "github": {
          const meta = getToolMeta<{ action?: string; owner?: string; repo?: string; branch?: string; path?: string; content?: string; message?: string; title?: string; body?: string; sha?: string }>("github");
          const owner = meta?.owner ?? "JW-Flo";
          const repo = meta?.repo ?? "Project-AtlasIT";
          switch (meta?.action) {
            case "sync":
              actions.push({ tool, result: await githubTool.syncRepoContext(owner, repo) });
              break;
            case "tree":
              actions.push({ tool, result: await githubTool.getTree(owner, repo, meta.branch) });
              break;
            case "read":
              if (!meta.path) { actions.push({ tool, result: { error: "path required" } }); break; }
              actions.push({ tool, result: await githubTool.getFile(owner, repo, meta.path, meta.branch) });
              break;
            case "branch":
              if (!meta.branch) { actions.push({ tool, result: { error: "branch name required" } }); break; }
              actions.push({ tool, result: await githubTool.createBranch(owner, repo, meta.branch) });
              break;
            case "commit":
              if (!meta.branch || !meta.path || !meta.content || !meta.message) {
                actions.push({ tool, result: { error: "branch, path, content, message required" } });
                break;
              }
              actions.push({ tool, result: await githubTool.commitFile(owner, repo, meta.branch, meta.path, meta.content, meta.message, meta.sha) });
              break;
            case "pr":
              if (!meta.branch || !meta.title) { actions.push({ tool, result: { error: "branch, title required" } }); break; }
              actions.push({ tool, result: await githubTool.createPR(owner, repo, meta.branch, meta.title, meta.body ?? "") });
              break;
            default:
              actions.push({ tool, result: await githubTool.getRepoSummary(owner, repo) });
          }
          break;
        }
        case "observability": {
          if (task.dryRun) {
            actions.push({ tool, result: { skipped: true, reason: "dry run" } });
            break;
          }
          const meta = getToolMeta<{ prometheusQuery?: string; lokiQuery?: string; lokiLimit?: number; grafanaUid?: string }>("observability");
          const obs: Record<string, unknown> = {};
          if (meta?.prometheusQuery) {
            obs.prometheus = await this.tools.observability.prometheusQuery(meta.prometheusQuery);
          }
          if (meta?.lokiQuery) {
            obs.loki = await this.tools.observability.lokiQuery(meta.lokiQuery, meta.lokiLimit ?? 100);
          }
          if (meta?.grafanaUid) {
            obs.grafana = await this.tools.observability.grafanaDashboard(meta.grafanaUid);
          }
          if (Object.keys(obs).length === 0) {
            obs.message = "No observability queries configured";
          }
          actions.push({ tool, result: obs });
          break;
        }
      }
    }

    const result = {
      id: crypto.randomUUID(),
      task,
      llm,
      actions,
      timestamp: new Date().toISOString(),
    };

    await memoryStore.add({
      title: `${task.type.toUpperCase()}: ${task.objective.slice(0, 80)}`,
      details: llm.output,
      tags: ["task", ...task.tools],
      source: "task-orchestrator",
    });

    return result;
  }
}
