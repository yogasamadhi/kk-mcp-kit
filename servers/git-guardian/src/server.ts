import {
  appendAudit,
  createMcpServer,
  invokeTool,
  type KkConfig,
  KkError,
  PlanIdInputSchema,
  type PlanRecord,
  PlanStore,
  RepositoryInputSchema,
  redactValue,
  registerCapabilitiesTool,
  requireCapability,
  resolveRepository,
  StandardOutputSchema,
  success,
} from "@kk-mcp-kit/core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  applyVendorSync,
  commitScope,
  compareRefs,
  gitFingerprint,
  inspectGitState,
  inspectSubmodules,
  inspectSubtree,
  inspectVendorLock,
  prepareVendorSync,
  type VendorSyncPayload,
} from "./domain/git.js";

interface CommitPlanPayload {
  repositoryPath: string;
  paths: string[];
  message?: string;
}

function publicPlan<T>(plan: PlanRecord<T>) {
  return {
    planId: plan.planId,
    kind: plan.kind,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    fingerprint: plan.fingerprint,
    summary: plan.summary,
    risks: plan.risks,
  };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
} as const;

export function createServer(config: KkConfig): McpServer {
  const server = createMcpServer(
    "git-guardian",
    "Inspect Git safely. Vendor mutations require an enabled capability and a fresh planId.",
  );
  const plans = new PlanStore(config.limits.planTtlMs);

  server.registerTool(
    "inspect_git_state",
    {
      title: "Inspect Git state",
      description:
        "Return branch, HEAD, upstream, remotes, changes, and a stable state fingerprint.",
      inputSchema: RepositoryInputSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ repository }) =>
      invokeTool(async (startedAt) => {
        const repositoryPath = await resolveRepository(config, repository);
        return success(
          redactValue(await inspectGitState(repositoryPath), config.audit.redactionPatterns),
          "Inspected Git state.",
          startedAt,
        );
      }),
  );

  server.registerTool(
    "compare_git_refs",
    {
      title: "Compare Git refs",
      description: "Compare divergence, merge-base, and changed paths between two Git refs.",
      inputSchema: z.object({
        repository: RepositoryInputSchema.shape.repository,
        left: z.string().min(1).max(256),
        right: z.string().min(1).max(256),
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ repository, left, right }) =>
      invokeTool(async (startedAt) => {
        const repositoryPath = await resolveRepository(config, repository);
        return success(
          await compareRefs(repositoryPath, left, right),
          "Compared Git refs.",
          startedAt,
        );
      }),
  );

  server.registerTool(
    "inspect_submodules",
    {
      title: "Inspect submodules",
      description: "Inspect configured, expected, actual, initialized, and dirty submodule state.",
      inputSchema: RepositoryInputSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ repository }) =>
      invokeTool(async (startedAt) => {
        const repositoryPath = await resolveRepository(config, repository);
        const submodules = await inspectSubmodules(repositoryPath);
        return success({ submodules }, `Inspected ${submodules.length} submodules.`, startedAt);
      }),
  );

  server.registerTool(
    "inspect_vendor_lock",
    {
      title: "Inspect vendor lock",
      description: "Read and hash a vendor-lock JSON file inside an allowed repository.",
      inputSchema: z.object({
        repository: RepositoryInputSchema.shape.repository,
        lockFile: z.string().default("vendor-lock.json"),
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ repository, lockFile }) =>
      invokeTool(async (startedAt) => {
        const repositoryPath = await resolveRepository(config, repository);
        return success(
          redactValue(
            await inspectVendorLock(repositoryPath, lockFile),
            config.audit.redactionPatterns,
          ),
          `Inspected ${lockFile}.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "inspect_subtree",
    {
      title: "Inspect Git subtree evidence",
      description: "Find Git subtree metadata without executing subtree updates.",
      inputSchema: z.object({
        repository: RepositoryInputSchema.shape.repository,
        prefix: z.string().optional(),
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ repository, prefix }) =>
      invokeTool(async (startedAt) => {
        const repositoryPath = await resolveRepository(config, repository);
        return success(
          await inspectSubtree(repositoryPath, prefix),
          "Inspected subtree metadata.",
          startedAt,
        );
      }),
  );

  server.registerTool(
    "plan_vendor_sync",
    {
      title: "Plan vendor sync",
      description:
        "Resolve a configured submodule remote HEAD and produce a short-lived sync plan.",
      inputSchema: z.object({ vendorId: z.string().min(1) }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ vendorId }) =>
      invokeTool(async (startedAt) => {
        const vendor = config.servers.gitGuardian.vendors.find(
          (candidate) => candidate.id === vendorId,
        );
        if (!vendor) throw new KkError("INVALID_ARGUMENT", `Unknown vendorId: ${vendorId}`);
        const repositoryPath = await resolveRepository(config, vendor.repository);
        const prepared = await prepareVendorSync(vendor, repositoryPath);
        const plan = plans.create<VendorSyncPayload>({
          kind: "vendor-sync",
          fingerprint: prepared.fingerprint,
          summary: `${vendorId}: ${prepared.payload.currentRevision.slice(0, 12)} -> ${prepared.payload.targetRevision.slice(0, 12)}`,
          risks:
            prepared.payload.currentRevision === prepared.payload.targetRevision
              ? []
              : ["Updates a submodule gitlink and vendor-lock.json"],
          payload: prepared.payload,
        });
        await appendAudit(config, {
          server: "git-guardian",
          action: "vendor-sync",
          outcome: "planned",
          details: publicPlan(plan),
        });
        return success(
          {
            ...publicPlan(plan),
            vendorId,
            currentRevision: prepared.payload.currentRevision,
            targetRevision: prepared.payload.targetRevision,
          },
          plan.summary,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "apply_vendor_sync",
    {
      title: "Apply vendor sync",
      description:
        "Apply a fresh configured submodule/vendor-lock sync plan with rollback on failure.",
      inputSchema: PlanIdInputSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: destructive,
    },
    async ({ planId }) =>
      invokeTool(async (startedAt) => {
        requireCapability(
          config.capabilities.gitGuardian.applyVendorSync,
          "capabilities.gitGuardian.applyVendorSync",
        );
        const plan = plans.get<VendorSyncPayload>(planId, "vendor-sync");
        const currentFingerprint = await gitFingerprint(plan.payload.repositoryPath);
        if (currentFingerprint !== plan.fingerprint) {
          throw new KkError(
            "STALE_PLAN",
            "Repository state changed after the vendor plan was created",
          );
        }
        const result = await applyVendorSync(plan.payload);
        plans.consume(planId, "vendor-sync");
        await appendAudit(config, {
          server: "git-guardian",
          action: "vendor-sync",
          outcome: "applied",
          details: { planId, ...result },
        });
        return success(result, `Applied vendor sync for ${plan.payload.vendorId}.`, startedAt);
      }),
  );

  server.registerTool(
    "plan_commit",
    {
      title: "Plan commit scope",
      description:
        "Snapshot changed paths and optionally attach a proposed commit message; never commits.",
      inputSchema: z.object({
        repository: RepositoryInputSchema.shape.repository,
        message: z.string().max(500).optional(),
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ repository, message }) =>
      invokeTool(async (startedAt) => {
        const repositoryPath = await resolveRepository(config, repository);
        const scope = await commitScope(repositoryPath);
        const payload: CommitPlanPayload = {
          repositoryPath,
          paths: scope.paths,
          ...(message ? { message } : {}),
        };
        const plan = plans.create<CommitPlanPayload>({
          kind: "commit-scope",
          fingerprint: scope.fingerprint,
          summary: `Commit scope contains ${scope.paths.length} changed paths.`,
          payload,
        });
        return success(
          {
            ...publicPlan(plan),
            paths: scope.paths,
            status: scope.status,
            message: message ?? null,
          },
          plan.summary,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "verify_commit_scope",
    {
      title: "Verify commit scope",
      description: "Check whether a prior commit scope plan still matches the repository.",
      inputSchema: PlanIdInputSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ planId }) =>
      invokeTool(async (startedAt) => {
        const plan = plans.get<CommitPlanPayload>(planId, "commit-scope");
        const current = await commitScope(plan.payload.repositoryPath);
        const valid = current.fingerprint === plan.fingerprint;
        return success(
          {
            valid,
            plannedPaths: plan.payload.paths,
            currentPaths: current.paths,
            added: current.paths.filter((path) => !plan.payload.paths.includes(path)),
            removed: plan.payload.paths.filter((path) => !current.paths.includes(path)),
          },
          valid ? "Commit scope is unchanged." : "Commit scope has changed.",
          startedAt,
        );
      }),
  );

  registerCapabilitiesTool(server, config, "git-guardian", {
    applyVendorSync: config.capabilities.gitGuardian.applyVendorSync,
    vendorStrategies: { submodule: "apply", vendorLock: "apply", subtree: "inspect-only" },
  });
  return server;
}
