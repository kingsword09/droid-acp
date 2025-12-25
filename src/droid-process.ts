import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { type Logger, findDroidExecutable } from "./utils.ts";

export interface DroidMessage {
  type: string;
  [key: string]: unknown;
}

export interface DroidOptions {
  cwd: string;
  sessionId?: string;
  model?: string;
  autoLevel?: "low" | "medium" | "high";
  skipPermissions?: boolean;
  enabledTools?: string[];
  disabledTools?: string[];
  logger?: Logger;
}

export class DroidProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private logger: Logger;
  private options: DroidOptions;
  private isRunning: boolean = false;

  constructor(options: DroidOptions) {
    super();
    this.options = options;
    this.logger = options.logger ?? console;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    const args = this.buildArgs();
    const executable = findDroidExecutable();

    this.logger.log(`Starting droid: ${executable} ${args.join(" ")}`);

    this.process = spawn(executable, args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        FORCE_COLOR: "0",
      },
    });

    this.isRunning = true;

    this.process.stdout?.on("data", (data: Buffer) => {
      this.handleStdout(data.toString());
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      this.logger.error(`[droid stderr]: ${data.toString()}`);
    });

    this.process.on("close", (code) => {
      this.isRunning = false;
      this.emit("close", code);
    });

    this.process.on("error", (err) => {
      this.isRunning = false;
      this.emit("error", err);
    });
  }

  private buildArgs(): string[] {
    const args = ["exec", "--input-format", "stream-json", "--output-format", "stream-json"];

    if (this.options.sessionId) {
      args.push("-s", this.options.sessionId);
    }

    if (this.options.model) {
      args.push("-m", this.options.model);
    }

    if (this.options.skipPermissions) {
      args.push("--skip-permissions-unsafe");
    } else if (this.options.autoLevel) {
      args.push("--auto", this.options.autoLevel);
    }

    if (this.options.enabledTools && this.options.enabledTools.length > 0) {
      args.push("--enabled-tools", this.options.enabledTools.join(","));
    }

    if (this.options.disabledTools && this.options.disabledTools.length > 0) {
      args.push("--disabled-tools", this.options.disabledTools.join(","));
    }

    return args;
  }

  private handleStdout(data: string): void {
    this.buffer += data;

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line) as DroidMessage;
          this.emit("message", message);
        } catch {
          this.logger.error(`Failed to parse droid output: ${line}`);
        }
      }
    }
  }

  send(message: DroidMessage): void {
    if (!this.process?.stdin) {
      throw new Error("Droid process not started or stdin not available");
    }

    const json = JSON.stringify(message) + "\n";
    this.process.stdin.write(json);
  }

  async stop(): Promise<void> {
    if (this.process && this.isRunning) {
      this.process.stdin?.end();
      this.process.kill("SIGTERM");

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill("SIGKILL");
          resolve();
        }, 5000);

        this.process?.on("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.isRunning = false;
    }
  }

  isActive(): boolean {
    return this.isRunning;
  }
}
