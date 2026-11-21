import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { KkError } from "./errors.js";
import { redactText } from "./redaction.js";

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string | undefined>;
  environmentAllowlist?: string[];
  allowNonZero?: boolean;
  signal?: AbortSignal;
}

const BASE_ENVIRONMENT = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TERM",
];

function environment(options: RunCommandOptions): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [...BASE_ENVIRONMENT, ...(options.environmentAllowlist ?? [])]) {
    const value = options.env?.[key] ?? process.env[key];
    if (value !== undefined) result[key] = value;
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined && (options.environmentAllowlist ?? []).includes(key))
      result[key] = value;
  }
  return result;
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  if (!command || command.includes("\0")) {
    throw new KkError("INVALID_ARGUMENT", "Command must be a non-empty executable name");
  }
  if (args.some((argument) => argument.includes("\0"))) {
    throw new KkError("INVALID_ARGUMENT", "Command arguments cannot contain NUL bytes");
  }

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 262_144;
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: environment(options),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let truncated = false;
  const append = (
    current: Buffer<ArrayBufferLike>,
    chunk: Buffer<ArrayBufferLike>,
  ): Buffer<ArrayBufferLike> => {
    if (current.length >= maxOutputBytes) {
      truncated = true;
      return current;
    }
    const remaining = maxOutputBytes - current.length;
    if (chunk.length > remaining) truncated = true;
    return Buffer.concat([current, chunk.subarray(0, remaining)]);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
  }, timeoutMs);
  timeout.unref();

  const abort = () => child.kill("SIGTERM");
  options.signal?.addEventListener("abort", abort, { once: true });

  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new KkError("COMMAND_NOT_FOUND", `Executable not found: ${command}`, { cause: error });
    }
    throw new KkError("INTERNAL_ERROR", `Failed to start ${command}: ${error.message}`, {
      cause: error,
    });
  });

  clearTimeout(timeout);
  options.signal?.removeEventListener("abort", abort);
  if (timedOut) {
    throw new KkError("TIMEOUT", `${command} exceeded ${timeoutMs}ms`, {
      retryable: true,
      details: { stderr: redactText(stderr.toString("utf8")) },
    });
  }

  const result: CommandResult = {
    command,
    args: [...args],
    exitCode: outcome.code ?? -1,
    signal: outcome.signal,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
    durationMs: Date.now() - startedAt,
    truncated,
  };
  if (result.exitCode !== 0 && !options.allowNonZero) {
    throw new KkError("CONFLICT", `${command} exited with code ${result.exitCode}`, {
      details: {
        stderr: redactText(result.stderr),
        stdout: redactText(result.stdout),
        exitCode: result.exitCode,
      },
    });
  }
  return result;
}

export async function commandExists(command: string): Promise<boolean> {
  if (path.isAbsolute(command)) {
    return access(command).then(
      () => true,
      () => false,
    );
  }
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = await runCommand(locator, [command], {
    allowNonZero: true,
    timeoutMs: 5_000,
  }).catch(() => undefined);
  return result?.exitCode === 0;
}
