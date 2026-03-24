import { spawn } from "child_process";
import { once } from "events";
import { createWriteStream, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "../config.js";

export type CommandResult = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  dryRun: boolean;
  logPath?: string;
};

export class LocalRunner {
  constructor(private readonly logDir = join(config.cacheDir, "logs")) {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  async run(
    command: string,
    args: string[],
    options?: { cwd?: string; dryRun?: boolean; env?: NodeJS.ProcessEnv },
  ): Promise<CommandResult> {
    const dryRun = options?.dryRun ?? true;
    if (dryRun) {
      return {
        command: [command, ...args].join(" "),
        exitCode: 0,
        stdout: "",
        stderr: "",
        dryRun: true,
      };
    }

    const logPath = join(this.logDir, `${Date.now()}-${command.replace(/[\\/]/g, "_")}.log`);
    const logStream = createWriteStream(logPath, { flags: "a" });

    const child = spawn(command, args, {
      cwd: options?.cwd ?? config.workspaceRoot,
      env: { ...process.env, ...(options?.env ?? {}) },
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      logStream.write(text);
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      logStream.write(text);
    });

    const [exitCode] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    logStream.end();

    return {
      command: [command, ...args].join(" "),
      exitCode,
      stdout,
      stderr,
      dryRun: false,
      logPath,
    };
  }
}
