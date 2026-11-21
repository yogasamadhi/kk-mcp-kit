import path from "node:path";
import {
  ArtifactStore,
  appendAudit,
  createMcpServer,
  type DesktopApp,
  invokeTool,
  type KkConfig,
  KkError,
  PlanIdInputSchema,
  PlanStore,
  readTextTail,
  redactText,
  registerCapabilitiesTool,
  requireCapability,
  StandardOutputSchema,
  success,
} from "@kk-mcp-kit/core";
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  appProcesses,
  appProcessFingerprint,
  captureScreenshot,
  collectCrashReports,
  collectSystemLogs,
  desktopCapabilities,
  inspectWindows,
  launchApp,
  stopApp,
} from "./adapters/desktop.js";

interface AppPlanPayload {
  action: "launch" | "stop";
  appId: string;
  processFingerprint: string;
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
} as const;

function appById(config: KkConfig, appId: string): DesktopApp {
  const app = config.servers.desktopLab.apps.find((candidate) => candidate.id === appId);
  if (!app) throw new KkError("INVALID_ARGUMENT", `Unknown appId: ${appId}`);
  return app;
}

async function configuredLogFiles(
  config: KkConfig,
  app: DesktopApp,
): Promise<Array<Record<string, unknown>>> {
  const files: Array<Record<string, unknown>> = [];
  for (const configuredPath of app.logPaths) {
    if (!path.isAbsolute(configuredPath)) {
      throw new KkError("CONFIG_ERROR", `Desktop log path must be absolute: ${configuredPath}`);
    }
    const source = await readTextTail(configuredPath, config.limits.maxOutputBytes).catch(
      () => undefined,
    );
    if (source === undefined) continue;
    files.push({
      path: configuredPath,
      output: redactText(source.text, config.audit.redactionPatterns),
      truncated: source.truncated,
    });
  }
  return files;
}

export function createServer(config: KkConfig): McpServer {
  const server = createMcpServer(
    "desktop-lab",
    "Inspect and diagnose only explicitly configured desktop applications. Launch, stop, and capture require explicit capabilities and fresh plans where applicable.",
  );
  const plans = new PlanStore(config.limits.planTtlMs);
  const artifacts = new ArtifactStore(config, "desktop-lab");

  server.registerResource(
    "desktop-screenshot",
    new ResourceTemplate("desktop-lab://artifacts/{id}", {
      list: async () => ({
        resources: (await artifacts.list()).map((artifact) => ({
          uri: artifact.uri,
          name: `Desktop screenshot ${artifact.id}`,
          mimeType: artifact.mimeType,
        })),
      }),
    }),
    { title: "Desktop screenshot artifact" },
    async (uri) => {
      const id = decodeURIComponent(uri.pathname.split("/").filter(Boolean).at(-1) ?? "");
      const artifact = await artifacts.get(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: artifact.mimeType,
            blob: Buffer.from(await artifacts.read(artifact)).toString("base64"),
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_desktop_capabilities",
    {
      title: "List desktop capabilities",
      description: "Detect available launch, window, log, crash, and screenshot backends.",
      inputSchema: z.object({}).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async () =>
      invokeTool(async (startedAt) =>
        success(await desktopCapabilities(), "Detected desktop backends.", startedAt),
      ),
  );

  server.registerTool(
    "list_configured_apps",
    {
      title: "List configured apps",
      description: "List the desktop applications this server is permitted to inspect or control.",
      inputSchema: z.object({}).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async () =>
      invokeTool(async (startedAt) =>
        success(
          {
            apps: config.servers.desktopLab.apps.map((app) => ({
              id: app.id,
              name: app.name,
              executable: app.executable,
              processMatch: app.processMatch,
              bundleId: app.bundleId ?? null,
            })),
          },
          `Listed ${config.servers.desktopLab.apps.length} configured apps.`,
          startedAt,
        ),
      ),
  );

  server.registerTool(
    "inspect_app_process",
    {
      title: "Inspect app process",
      description: "Inspect processes matching one configured desktop app.",
      inputSchema: z.object({ appId: z.string().min(1) }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ appId }) =>
      invokeTool(async (startedAt) => {
        const processes = await appProcesses(appById(config, appId));
        return success({ appId, processes }, `Found ${processes.length} app processes.`, startedAt);
      }),
  );

  server.registerTool(
    "inspect_window_state",
    {
      title: "Inspect window state",
      description: "Inspect bounded window metadata using a platform backend without UI input.",
      inputSchema: z.object({ appId: z.string().min(1) }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ appId }) =>
      invokeTool(async (startedAt) =>
        success(
          await inspectWindows(appById(config, appId)),
          `Inspected windows for ${appId}.`,
          startedAt,
        ),
      ),
  );

  server.registerTool(
    "collect_app_logs",
    {
      title: "Collect app logs",
      description: "Collect bounded platform logs and explicitly configured log files.",
      inputSchema: z.object({
        appId: z.string().min(1),
        minutes: z.number().int().min(1).max(10_080).default(60),
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ appId, minutes }) =>
      invokeTool(async (startedAt) => {
        const app = appById(config, appId);
        const files = await configuredLogFiles(config, app);
        const system = await collectSystemLogs(config, app, minutes).catch((error) => ({
          unavailable: error instanceof Error ? error.message : String(error),
        }));
        return success({ appId, files, system }, `Collected logs for ${appId}.`, startedAt);
      }),
  );

  server.registerTool(
    "collect_crash_reports",
    {
      title: "Collect crash reports",
      description: "List crash report metadata from configured or platform-standard locations.",
      inputSchema: z.object({ appId: z.string().min(1) }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ appId }) =>
      invokeTool(async (startedAt) =>
        success(
          await collectCrashReports(config, appById(config, appId)),
          `Collected crash report metadata for ${appId}.`,
          startedAt,
        ),
      ),
  );

  server.registerTool(
    "capture_app_screenshot",
    {
      title: "Capture app screenshot",
      description:
        "Capture the desktop through a detected backend and store it as a bounded artifact.",
      inputSchema: z.object({ appId: z.string().min(1) }).shape,
      outputSchema: StandardOutputSchema,
      annotations: destructive,
    },
    async ({ appId }) =>
      invokeTool(async (startedAt) => {
        requireCapability(
          config.capabilities.desktopLab.capture,
          "capabilities.desktopLab.capture",
        );
        appById(config, appId);
        const capture = await captureScreenshot();
        const artifact = await artifacts.put(capture.data, "png", "image/png");
        await appendAudit(config, {
          server: "desktop-lab",
          action: "capture",
          outcome: "applied",
          details: { appId, artifactId: artifact.id, backend: capture.backend },
        });
        const result = success(
          { appId, backend: capture.backend, artifact },
          `Captured screenshot for ${appId}.`,
          startedAt,
        );
        result.content.push({
          type: "image",
          data: Buffer.from(capture.data).toString("base64"),
          mimeType: "image/png",
        });
        return result;
      }),
  );

  const planAppAction = (action: "launch" | "stop", appId: string) =>
    invokeTool(async (startedAt) => {
      const app = appById(config, appId);
      const processes = await appProcesses(app);
      if (action === "launch" && processes.length > 0) {
        throw new KkError("CONFLICT", `${app.name} is already running`);
      }
      if (action === "stop" && processes.length === 0) {
        throw new KkError("CONFLICT", `${app.name} is not running`);
      }
      const processFingerprint = appProcessFingerprint(processes);
      const plan = plans.create<AppPlanPayload>({
        kind: `desktop-${action}`,
        fingerprint: processFingerprint,
        summary: `${action === "launch" ? "Launch" : "Stop"} configured app ${app.name}`,
        risks: action === "stop" ? ["The app may have unsaved state"] : [],
        payload: { action, appId, processFingerprint },
      });
      await appendAudit(config, {
        server: "desktop-lab",
        action,
        outcome: "planned",
        details: { planId: plan.planId, appId },
      });
      return success(
        {
          planId: plan.planId,
          expiresAt: plan.expiresAt,
          summary: plan.summary,
          risks: plan.risks,
        },
        plan.summary,
        startedAt,
      );
    });

  server.registerTool(
    "plan_launch_app",
    {
      title: "Plan app launch",
      description: "Create a short-lived launch plan for one configured app.",
      inputSchema: z.object({ appId: z.string().min(1) }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ appId }) => planAppAction("launch", appId),
  );

  server.registerTool(
    "apply_launch_app",
    {
      title: "Apply app launch",
      description: "Launch the configured executable if the plan is still fresh.",
      inputSchema: PlanIdInputSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: destructive,
    },
    async ({ planId }) =>
      invokeTool(async (startedAt) => {
        requireCapability(config.capabilities.desktopLab.launch, "capabilities.desktopLab.launch");
        const plan = plans.get<AppPlanPayload>(planId, "desktop-launch");
        const app = appById(config, plan.payload.appId);
        if (appProcessFingerprint(await appProcesses(app)) !== plan.fingerprint) {
          throw new KkError("STALE_PLAN", "App process state changed after planning");
        }
        await launchApp(app);
        plans.consume(planId, "desktop-launch");
        await appendAudit(config, {
          server: "desktop-lab",
          action: "launch",
          outcome: "applied",
          details: { planId, appId: app.id },
        });
        return success({ appId: app.id, launched: true }, `Launched ${app.name}.`, startedAt);
      }),
  );

  server.registerTool(
    "plan_stop_app",
    {
      title: "Plan app stop",
      description: "Create a short-lived stop plan for matching configured app processes.",
      inputSchema: z.object({ appId: z.string().min(1) }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ appId }) => planAppAction("stop", appId),
  );

  server.registerTool(
    "apply_stop_app",
    {
      title: "Apply app stop",
      description: "Send a normal termination signal to unchanged configured app processes.",
      inputSchema: PlanIdInputSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: destructive,
    },
    async ({ planId }) =>
      invokeTool(async (startedAt) => {
        requireCapability(config.capabilities.desktopLab.stop, "capabilities.desktopLab.stop");
        const plan = plans.get<AppPlanPayload>(planId, "desktop-stop");
        const app = appById(config, plan.payload.appId);
        const current = await appProcesses(app);
        if (appProcessFingerprint(current) !== plan.fingerprint) {
          throw new KkError("STALE_PLAN", "App process state changed after planning");
        }
        await stopApp(current);
        plans.consume(planId, "desktop-stop");
        await appendAudit(config, {
          server: "desktop-lab",
          action: "stop",
          outcome: "applied",
          details: { planId, appId: app.id, pids: current.map((record) => record.pid) },
        });
        return success(
          { appId: app.id, signalledPids: current.map((record) => record.pid) },
          `Requested stop for ${app.name}.`,
          startedAt,
        );
      }),
  );

  registerCapabilitiesTool(server, config, "desktop-lab", {
    configuredApps: config.servers.desktopLab.apps.length,
    launch: config.capabilities.desktopLab.launch,
    stop: config.capabilities.desktopLab.stop,
    capture: config.capabilities.desktopLab.capture,
    platformBackends: "detected-at-call-time",
    uiInput: false,
  });
  return server;
}
