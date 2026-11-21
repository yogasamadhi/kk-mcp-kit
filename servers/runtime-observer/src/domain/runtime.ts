import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertAllowedAbsolutePath,
  commandExists,
  type KkConfig,
  KkError,
  type RuntimeService,
  readTextTail,
  redactText,
  resolveRepository,
  runCommand,
} from "@kk-mcp-kit/core";
import { listProcesses, type ProcessRecord } from "../adapters/processes.js";

function normalizedExecutable(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function matchesService(
  record: ProcessRecord,
  service: RuntimeService,
  configuredPids: ReadonlySet<number>,
): boolean {
  if (configuredPids.has(record.pid)) return true;
  if (service.processMatch && record.command.includes(service.processMatch)) return true;
  if (service.executable && record.executable) {
    const expected = normalizedExecutable(service.executable);
    const actual = normalizedExecutable(record.executable);
    return actual === expected || path.basename(actual) === path.basename(expected);
  }
  return false;
}

async function configuredServicePids(
  config: KkConfig,
  service: RuntimeService,
): Promise<Set<number>> {
  const pids = new Set<number>();
  if (service.pid) pids.add(service.pid);
  if (service.pidFile) {
    let absolute = service.pidFile;
    if (!path.isAbsolute(service.pidFile) && service.repository) {
      const repositoryPath = await resolveRepository(config, service.repository);
      absolute = await assertAllowedAbsolutePath(path.join(repositoryPath, service.pidFile), [
        repositoryPath,
      ]);
    }
    const source = await readFile(absolute, "utf8").catch(() => undefined);
    const pid = Number(source?.trim());
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return pids;
}

export async function listDevProcesses(
  config: KkConfig,
  options: { rootId?: string; query?: string },
): Promise<ProcessRecord[]> {
  const records = await listProcesses();
  const root = options.rootId
    ? config.roots.find((candidate) => candidate.id === options.rootId)
    : undefined;
  if (options.rootId && !root)
    throw new KkError("INVALID_ARGUMENT", `Unknown rootId: ${options.rootId}`);
  const configuredPids = new Set<number>();
  for (const service of config.servers.runtimeObserver.services) {
    for (const pid of await configuredServicePids(config, service)) configuredPids.add(pid);
  }
  const selectors = config.servers.runtimeObserver.services.flatMap((service) =>
    [service.processMatch, service.executable].filter((value): value is string => Boolean(value)),
  );
  const rootPaths = config.roots.map((candidate) => candidate.path);
  return records
    .filter((record) => {
      if (options.query && !record.command.toLowerCase().includes(options.query.toLowerCase()))
        return false;
      if (root) return record.command.includes(root.path);
      if (options.query) return true;
      return (
        configuredPids.has(record.pid) ||
        selectors.some((value) => record.command.includes(value)) ||
        rootPaths.some((rootPath) => record.command.includes(rootPath))
      );
    })
    .slice(0, config.limits.maxItems);
}

async function composeState(config: KkConfig, service: RuntimeService): Promise<unknown> {
  if (!service.composeService || !service.repository || !(await commandExists("docker")))
    return null;
  const repositoryPath = await resolveRepository(config, service.repository);
  const result = await runCommand(
    "docker",
    ["compose", "ps", service.composeService, "--format", "json"],
    { cwd: repositoryPath, allowNonZero: true, timeoutMs: 30_000 },
  );
  if (!result.stdout.trim()) return null;
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

export async function inspectConfiguredService(
  config: KkConfig,
  service: RuntimeService,
): Promise<Record<string, unknown>> {
  const configuredPids = await configuredServicePids(config, service);
  const processes = (await listProcesses()).filter((record) =>
    matchesService(record, service, configuredPids),
  );
  let health: Record<string, unknown> | null = null;
  if (service.healthUrl) {
    const startedAt = Date.now();
    try {
      const response = await fetch(service.healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(config.limits.defaultTimeoutMs, 30_000)),
        redirect: "manual",
      });
      health = { ok: response.ok, status: response.status, durationMs: Date.now() - startedAt };
      await response.body?.cancel();
    } catch (error) {
      health = {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    id: service.id,
    name: service.name,
    configuredPids: [...configuredPids],
    running: processes.length > 0,
    processes,
    health,
    compose: await composeState(config, service),
  };
}

export async function listConfiguredServices(config: KkConfig): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  for (const service of config.servers.runtimeObserver.services) {
    result.push(await inspectConfiguredService(config, service));
  }
  return result;
}

export async function readServiceLogs(
  config: KkConfig,
  service: RuntimeService,
  lines: number,
): Promise<Array<{ path: string; lines: string[]; truncated: boolean }>> {
  const output: Array<{ path: string; lines: string[]; truncated: boolean }> = [];
  for (const configuredPath of service.logPaths) {
    let absolute = configuredPath;
    if (!path.isAbsolute(configuredPath) && service.repository) {
      const repositoryPath = await resolveRepository(config, service.repository);
      absolute = await assertAllowedAbsolutePath(path.join(repositoryPath, configuredPath), [
        repositoryPath,
      ]);
    }
    const source = await readTextTail(absolute, config.limits.maxOutputBytes).catch(
      () => undefined,
    );
    if (source === undefined) continue;
    const allLines = source.text.split(/\r?\n/);
    output.push({
      path: configuredPath,
      lines: allLines.slice(-lines).map((line) => redactText(line, config.audit.redactionPatterns)),
      truncated: source.truncated || allLines.length > lines,
    });
  }
  if (service.composeService && service.repository && (await commandExists("docker"))) {
    const repositoryPath = await resolveRepository(config, service.repository);
    const result = await runCommand(
      "docker",
      ["compose", "logs", "--no-color", "--tail", String(lines), service.composeService],
      { cwd: repositoryPath, allowNonZero: true, maxOutputBytes: config.limits.maxOutputBytes },
    );
    output.push({
      path: `compose://${service.composeService}`,
      lines: result.stdout
        .split(/\r?\n/)
        .map((line) => redactText(line, config.audit.redactionPatterns)),
      truncated: result.truncated,
    });
  }
  return output;
}
