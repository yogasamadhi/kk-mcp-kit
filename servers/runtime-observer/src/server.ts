import { setTimeout as delay } from "node:timers/promises";
import {
  appendAudit,
  createMcpServer,
  invokeTool,
  type KkConfig,
  KkError,
  PlanIdInputSchema,
  PlanStore,
  registerCapabilitiesTool,
  requireCapability,
  StandardOutputSchema,
  success,
} from "@kk-mcp-kit/core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  assertStoppableProcess,
  findPortOwners,
  inspectProcess,
  type ProcessRecord,
  processFingerprint,
} from "./adapters/processes.js";
import {
  inspectConfiguredService,
  listConfiguredServices,
  listDevProcesses,
  readServiceLogs,
} from "./domain/runtime.js";

interface StopProcessPayload {
  process: ProcessRecord;
  fingerprint: string;
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
} as const;

function serviceById(config: KkConfig, serviceId: string) {
  const service = config.servers.runtimeObserver.services.find(
    (candidate) => candidate.id === serviceId,
  );
  if (!service) throw new KkError("INVALID_ARGUMENT", `Unknown serviceId: ${serviceId}`);
  return service;
}

export function createServer(config: KkConfig): McpServer {
  const server = createMcpServer(
    "runtime-observer",
    "Inspect local processes, ports, configured services, health, and logs. Process termination requires a fresh plan.",
  );
  const plans = new PlanStore(config.limits.planTtlMs);

  server.registerTool(
    "list_dev_processes",
    {
      title: "List development processes",
      description: "List processes matching configured services, a workspace root, or a query.",
      inputSchema: z.object({
        rootId: z.string().optional(),
        query: z.string().max(256).optional(),
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async (input) =>
      invokeTool(async (startedAt) => {
        const processes = await listDevProcesses(config, {
          ...(input.rootId === undefined ? {} : { rootId: input.rootId }),
          ...(input.query === undefined ? {} : { query: input.query }),
        });
        return success(
          { processes },
          `Found ${processes.length} development processes.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "find_process_by_port",
    {
      title: "Find process by port",
      description: "Find listening process owners for a TCP port using the platform adapter.",
      inputSchema: z.object({ port: z.number().int().min(1).max(65_535) }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ port }) =>
      invokeTool(async (startedAt) => {
        const result = await findPortOwners(port);
        const owners = await Promise.all(
          result.owners.map(async (owner) => ({
            ...owner,
            process: await inspectProcess(owner.pid).catch(() => null),
          })),
        );
        return success(
          { ...result, port, owners },
          `Found ${owners.length} port owners.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "inspect_process",
    {
      title: "Inspect process",
      description: "Inspect a process by PID without changing it.",
      inputSchema: z.object({ pid: z.number().int().positive() }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ pid }) =>
      invokeTool(async (startedAt) =>
        success(await inspectProcess(pid), `Inspected process ${pid}.`, startedAt),
      ),
  );

  server.registerTool(
    "list_services",
    {
      title: "List configured services",
      description: "Inspect all configured native or Compose-backed development services.",
      inputSchema: z.object({}).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async () =>
      invokeTool(async (startedAt) => {
        const services = await listConfiguredServices(config);
        return success(
          { services },
          `Inspected ${services.length} configured services.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "inspect_service_health",
    {
      title: "Inspect service health",
      description: "Inspect process, configured HTTP health, and Compose state for one service.",
      inputSchema: z.object({ serviceId: z.string().min(1) }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ serviceId }) =>
      invokeTool(async (startedAt) =>
        success(
          await inspectConfiguredService(config, serviceById(config, serviceId)),
          `Inspected service ${serviceId}.`,
          startedAt,
        ),
      ),
  );

  server.registerTool(
    "tail_service_log",
    {
      title: "Tail service logs",
      description: "Read bounded tails from configured log files or Compose logs.",
      inputSchema: z.object({
        serviceId: z.string().min(1),
        lines: z.number().int().min(1).max(2_000).default(200),
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ serviceId, lines }) =>
      invokeTool(async (startedAt) => {
        const logs = await readServiceLogs(config, serviceById(config, serviceId), lines);
        return success({ serviceId, logs }, `Read ${logs.length} log sources.`, startedAt);
      }),
  );

  server.registerTool(
    "plan_stop_process",
    {
      title: "Plan process termination",
      description: "Create a short-lived termination plan from a process identity fingerprint.",
      inputSchema: z.object({ pid: z.number().int().positive() }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ pid }) =>
      invokeTool(async (startedAt) => {
        const record = await inspectProcess(pid);
        assertStoppableProcess(record);
        const fingerprint = processFingerprint(record);
        const plan = plans.create<StopProcessPayload>({
          kind: "stop-process",
          fingerprint,
          summary: `Terminate PID ${pid}: ${record.command.slice(0, 160)}`,
          risks: ["The process may have unsaved state"],
          payload: { process: record, fingerprint },
        });
        await appendAudit(config, {
          server: "runtime-observer",
          action: "stop-process",
          outcome: "planned",
          details: { planId: plan.planId, pid },
        });
        return success(
          {
            planId: plan.planId,
            expiresAt: plan.expiresAt,
            summary: plan.summary,
            risks: plan.risks,
            process: record,
          },
          plan.summary,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "apply_stop_process",
    {
      title: "Apply process termination",
      description: "Send a normal termination signal when a fresh process plan still matches.",
      inputSchema: PlanIdInputSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: destructive,
    },
    async ({ planId }) =>
      invokeTool(async (startedAt) => {
        requireCapability(
          config.capabilities.runtimeObserver.stopProcess,
          "capabilities.runtimeObserver.stopProcess",
        );
        const plan = plans.get<StopProcessPayload>(planId, "stop-process");
        const current = await inspectProcess(plan.payload.process.pid);
        assertStoppableProcess(current);
        if (processFingerprint(current) !== plan.fingerprint) {
          throw new KkError("STALE_PLAN", "PID identity changed after planning");
        }
        process.kill(current.pid, "SIGTERM");
        let running = true;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await delay(100);
          running = await inspectProcess(current.pid).then(
            () => true,
            () => false,
          );
          if (!running) break;
        }
        plans.consume(planId, "stop-process");
        await appendAudit(config, {
          server: "runtime-observer",
          action: "stop-process",
          outcome: "applied",
          details: { planId, pid: current.pid, stopped: !running },
        });
        return success(
          { pid: current.pid, stopped: !running, signal: "SIGTERM" },
          running ? `Termination requested for PID ${current.pid}.` : `Stopped PID ${current.pid}.`,
          startedAt,
        );
      }),
  );

  registerCapabilitiesTool(server, config, "runtime-observer", {
    stopProcess: config.capabilities.runtimeObserver.stopProcess,
    processBackend:
      process.platform === "win32"
        ? "PowerShell/CIM"
        : process.platform === "darwin"
          ? "ps/lsof"
          : "/proc/ss",
    dockerCompose: "detected-at-call-time",
  });
  return server;
}
