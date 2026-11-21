import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ArtifactStore,
  appendAudit,
  createMcpServer,
  invokeTool,
  type KkConfig,
  KkError,
  PlanIdInputSchema,
  PlanStore,
  RepositoryInputSchema,
  redactText,
  registerCapabilitiesTool,
  requireCapability,
  resolveRepository,
  StandardOutputSchema,
  success,
  type VerificationProfile,
} from "@kk-mcp-kit/core";
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  detectFrameworks,
  EvidenceDatabase,
  runVerification,
  verificationFingerprint,
} from "./domain/evidence.js";

interface VerificationPlanPayload {
  profile: VerificationProfile;
  repositoryPath: string;
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
} as const;

function profileById(config: KkConfig, profileId: string): VerificationProfile {
  const profile = config.servers.buildEvidence.profiles.find(
    (candidate) => candidate.id === profileId,
  );
  if (!profile) throw new KkError("INVALID_ARGUMENT", `Unknown profileId: ${profileId}`);
  return profile;
}

function boundedRun(run: ReturnType<EvidenceDatabase["get"]>) {
  return {
    ...run,
    stdout: run.stdout.slice(0, 32_768),
    stderr: run.stderr.slice(0, 32_768),
    outputTruncated: run.truncated || run.stdout.length > 32_768 || run.stderr.length > 32_768,
  };
}

export function createServer(config: KkConfig): McpServer {
  const server = createMcpServer(
    "build-evidence",
    "Run only named verification profiles from configuration. Clients cannot provide commands or arguments.",
  );
  const plans = new PlanStore(config.limits.planTtlMs);
  const database = new EvidenceDatabase(config);
  const artifactStore = new ArtifactStore(config, "build-evidence");

  server.registerResource(
    "build-artifact",
    new ResourceTemplate("build-evidence://artifacts/{id}", {
      list: async () => ({
        resources: (await artifactStore.list()).map((artifact) => ({
          uri: artifact.uri,
          name: `Build artifact ${artifact.id}`,
          mimeType: artifact.mimeType,
        })),
      }),
    }),
    { title: "Build evidence artifact" },
    async (uri) => {
      const id = decodeURIComponent(uri.pathname.split("/").filter(Boolean).at(-1) ?? "");
      const artifact = await artifactStore.get(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: artifact.mimeType,
            blob: Buffer.from(await artifactStore.read(artifact)).toString("base64"),
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_verification_profiles",
    {
      title: "List verification profiles",
      description: "List immutable configured command profiles without executing them.",
      inputSchema: z.object({}).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async () =>
      invokeTool(async (startedAt) =>
        success(
          {
            profiles: config.servers.buildEvidence.profiles.map((profile) => ({
              id: profile.id,
              repository: profile.repository,
              command: redactText(profile.command, config.audit.redactionPatterns),
              args: profile.args.map((argument) =>
                redactText(argument, config.audit.redactionPatterns),
              ),
              timeoutMs: profile.timeoutMs,
              parser: profile.parser,
              resultPaths: profile.resultPaths,
              artifactGlobs: profile.artifactGlobs,
            })),
          },
          `Listed ${config.servers.buildEvidence.profiles.length} verification profiles.`,
          startedAt,
        ),
      ),
  );

  server.registerTool(
    "detect_test_frameworks",
    {
      title: "Detect test frameworks",
      description: "Inspect repository manifests for common test and build frameworks.",
      inputSchema: RepositoryInputSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ repository }) =>
      invokeTool(async (startedAt) => {
        const repositoryPath = await resolveRepository(config, repository);
        const frameworks = await detectFrameworks(repositoryPath);
        return success(
          { repository, frameworks },
          `Detected ${frameworks.length} frameworks.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "plan_verification",
    {
      title: "Plan verification",
      description: "Create a repository-state-bound plan for a configured verification profile.",
      inputSchema: z.object({ profileId: z.string().min(1) }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ profileId }) =>
      invokeTool(async (startedAt) => {
        const profile = profileById(config, profileId);
        const repositoryPath = await resolveRepository(config, profile.repository);
        const fingerprint = await verificationFingerprint(profile, repositoryPath);
        const plan = plans.create<VerificationPlanPayload>({
          kind: "verification",
          fingerprint,
          summary: `Run profile ${profile.id} in ${profile.repository.rootId}:${profile.repository.relativePath}`,
          risks: ["Configured lifecycle commands may modify files in the repository"],
          payload: { profile, repositoryPath },
        });
        await appendAudit(config, {
          server: "build-evidence",
          action: "verification",
          outcome: "planned",
          details: { planId: plan.planId, profileId },
        });
        return success(
          {
            planId: plan.planId,
            expiresAt: plan.expiresAt,
            fingerprint: plan.fingerprint,
            summary: plan.summary,
            risks: plan.risks,
            profile: {
              id: profile.id,
              command: redactText(profile.command, config.audit.redactionPatterns),
              args: profile.args.map((argument) =>
                redactText(argument, config.audit.redactionPatterns),
              ),
              timeoutMs: profile.timeoutMs,
            },
          },
          plan.summary,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "run_verification",
    {
      title: "Run verification",
      description:
        "Execute a configured command only when the plan is fresh and execution is enabled.",
      inputSchema: PlanIdInputSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: destructive,
    },
    async ({ planId }) =>
      invokeTool(async (startedAt) => {
        requireCapability(config.capabilities.buildEvidence.run, "capabilities.buildEvidence.run");
        const plan = plans.get<VerificationPlanPayload>(planId, "verification");
        const fingerprint = await verificationFingerprint(
          plan.payload.profile,
          plan.payload.repositoryPath,
        );
        if (fingerprint !== plan.fingerprint) {
          throw new KkError("STALE_PLAN", "Repository state changed after verification planning");
        }
        const run = await runVerification(
          config,
          plan.payload.profile,
          plan.payload.repositoryPath,
          database,
          artifactStore,
        );
        plans.consume(planId, "verification");
        await appendAudit(config, {
          server: "build-evidence",
          action: "verification",
          outcome: "applied",
          details: { planId, runId: run.id, status: run.status },
        });
        return success(
          boundedRun(run),
          `${run.profileId} ${run.status} in ${run.durationMs}ms.`,
          startedAt,
          { truncated: run.truncated },
        );
      }),
  );

  server.registerTool(
    "get_verification_run",
    {
      title: "Get verification run",
      description: "Get a persisted verification result with bounded process output.",
      inputSchema: z.object({ runId: z.string().uuid() }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ runId }) =>
      invokeTool(async (startedAt) =>
        success(boundedRun(database.get(runId)), `Loaded verification run ${runId}.`, startedAt),
      ),
  );

  server.registerTool(
    "get_failed_tests",
    {
      title: "Get failed tests",
      description: "Return structured failures from a persisted verification run.",
      inputSchema: z.object({ runId: z.string().uuid() }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ runId }) =>
      invokeTool(async (startedAt) => {
        const run = database.get(runId);
        return success(
          { runId, failures: run.failures, count: run.failures.length },
          `Found ${run.failures.length} failures.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "compare_verification_runs",
    {
      title: "Compare verification runs",
      description: "Compare duration and failure-set changes between two persisted runs.",
      inputSchema: z.object({ leftRunId: z.string().uuid(), rightRunId: z.string().uuid() }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ leftRunId, rightRunId }) =>
      invokeTool(async (startedAt) =>
        success(database.compare(leftRunId, rightRunId), "Compared verification runs.", startedAt),
      ),
  );

  server.registerTool(
    "list_build_artifacts",
    {
      title: "List build artifacts",
      description: "List artifact metadata captured from one or recent verification runs.",
      inputSchema: z.object({ runId: z.string().uuid().optional() }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ runId }) =>
      invokeTool(async (startedAt) => {
        const artifacts = database.listArtifacts(runId);
        return success({ artifacts }, `Listed ${artifacts.length} artifacts.`, startedAt);
      }),
  );

  server.registerTool(
    "inspect_build_artifact",
    {
      title: "Inspect build artifact",
      description: "Inspect captured artifact metadata and a bounded text preview when applicable.",
      inputSchema: z.object({ artifactId: z.string().uuid() }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ artifactId }) =>
      invokeTool(async (startedAt) => {
        const artifact = database.listArtifacts().find((candidate) => candidate.id === artifactId);
        if (!artifact) throw new KkError("INVALID_ARGUMENT", `Unknown artifactId: ${artifactId}`);
        const absolute = path.join(config.stateDir, "artifacts", artifact.relativePath);
        const preview =
          artifact.mimeType.startsWith("text/") || artifact.mimeType.includes("json")
            ? await readFile(absolute, "utf8").then((source) => source.slice(0, 16_384))
            : null;
        return success({ artifact, preview }, `Inspected artifact ${artifactId}.`, startedAt);
      }),
  );

  registerCapabilitiesTool(server, config, "build-evidence", {
    run: config.capabilities.buildEvidence.run,
    parsers: ["generic", "junit", "go-json", "cargo", "xcresult"],
    profileCount: config.servers.buildEvidence.profiles.length,
  });
  return server;
}
