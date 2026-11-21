import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  appendAudit,
  assertAllowedAbsolutePath,
  createMcpServer,
  invokeTool,
  type KkConfig,
  KkError,
  PlanIdInputSchema,
  PlanStore,
  RepositoryInputSchema,
  type RepositoryRef,
  registerCapabilitiesTool,
  requireCapability,
  resolveRepository,
  StandardOutputSchema,
  success,
} from "@kk-mcp-kit/core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  importDrafts,
  MemoryDatabase,
  type MemoryDraft,
  type MemoryKind,
  memoryContentHash,
} from "./domain/memory.js";

type MemoryPlanPayload =
  | { action: "insert"; source: "write"; drafts: MemoryDraft[] }
  | { action: "insert"; source: "import"; drafts: MemoryDraft[]; file: string; sourceHash: string }
  | { action: "link"; memoryId: string; repository: RepositoryRef };

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
const writePlan = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
} as const;

function boundedRecords<T extends { body: string }>(records: T[]) {
  return records.map((record) => ({
    ...record,
    body: record.body.slice(0, 16_384),
    bodyTruncated: record.body.length > 16_384,
  }));
}

function planDraft(
  plans: PlanStore,
  draft: MemoryDraft,
  summary: string,
): ReturnType<PlanStore["create"]> {
  return plans.create<MemoryPlanPayload>({
    kind: "memory-write",
    fingerprint: memoryContentHash(draft),
    summary,
    payload: { action: "insert", source: "write", drafts: [draft] },
  });
}

function planOutput(plan: ReturnType<PlanStore["create"]>) {
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

const RepositoryOptionalSchema = RepositoryInputSchema.shape.repository.optional();
const BaseRecordSchema = z.object({
  repository: RepositoryOptionalSchema,
  title: z.string().min(1).max(500),
  tags: z.array(z.string().min(1).max(100)).default([]),
  sources: z.array(z.string().max(2_048)).default([]),
});

export function createServer(config: KkConfig): McpServer {
  const server = createMcpServer(
    "project-memory",
    "Local SQLite FTS project memory. All writes and imports require a short-lived plan and explicit capability.",
  );
  const database = new MemoryDatabase(config);
  const plans = new PlanStore(config.limits.planTtlMs);

  server.registerTool(
    "search_project_memory",
    {
      title: "Search project memory",
      description: "Search local memory with FTS, repository, kind, tag, and time filters.",
      inputSchema: z.object({
        query: z.string().max(2_000).default(""),
        repository: RepositoryOptionalSchema,
        kinds: z
          .array(z.enum(["decision", "incident", "verification", "note", "conversation"]))
          .optional(),
        tags: z.array(z.string()).optional(),
        since: z.iso.datetime().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async (input) =>
      invokeTool(async (startedAt) => {
        if (input.repository) await resolveRepository(config, input.repository);
        const records = database.search({
          query: input.query,
          ...(input.repository ? { repository: input.repository } : {}),
          ...(input.kinds ? { kinds: input.kinds as MemoryKind[] } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
          ...(input.since ? { since: input.since } : {}),
          limit: input.limit,
        });
        return success(
          { records: boundedRecords(records), count: records.length },
          `Found ${records.length} memory records.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "get_project_context",
    {
      title: "Get project context",
      description: "Return recent structured memories linked to a repository.",
      inputSchema: z.object({
        repository: RepositoryInputSchema.shape.repository,
        limit: z.number().int().min(1).max(100).default(30),
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async ({ repository, limit }) =>
      invokeTool(async (startedAt) => {
        await resolveRepository(config, repository);
        const records = database.context(repository, limit);
        return success(
          { repository, records: boundedRecords(records) },
          `Loaded ${records.length} project memories.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "plan_record_decision",
    {
      title: "Plan decision record",
      description: "Plan a structured architecture or project decision memory.",
      inputSchema: BaseRecordSchema.extend({
        decision: z.string().min(1).max(524_288),
        context: z.string().max(262_144).default(""),
        alternatives: z.array(z.string()).default([]),
        consequences: z.array(z.string()).default([]),
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: writePlan,
    },
    async (input) =>
      invokeTool(async (startedAt) => {
        if (input.repository) await resolveRepository(config, input.repository);
        const draft: MemoryDraft = {
          kind: "decision",
          title: input.title,
          body: [
            `Decision\n${input.decision}`,
            input.context ? `Context\n${input.context}` : "",
            input.alternatives.length ? `Alternatives\n${input.alternatives.join("\n")}` : "",
            input.consequences.length ? `Consequences\n${input.consequences.join("\n")}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
          ...(input.repository ? { repository: input.repository } : {}),
          tags: input.tags,
          sources: input.sources,
        };
        const plan = planDraft(plans, draft, `Record decision: ${input.title}`);
        return success(planOutput(plan), plan.summary, startedAt);
      }),
  );

  server.registerTool(
    "plan_record_incident",
    {
      title: "Plan incident record",
      description: "Plan a structured incident, root cause, resolution, and prevention memory.",
      inputSchema: BaseRecordSchema.extend({
        symptoms: z.string().min(1).max(262_144),
        rootCause: z.string().min(1).max(262_144),
        resolution: z.string().min(1).max(262_144),
        prevention: z.string().max(262_144).default(""),
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: writePlan,
    },
    async (input) =>
      invokeTool(async (startedAt) => {
        if (input.repository) await resolveRepository(config, input.repository);
        const draft: MemoryDraft = {
          kind: "incident",
          title: input.title,
          body: `Symptoms\n${input.symptoms}\n\nRoot cause\n${input.rootCause}\n\nResolution\n${input.resolution}${input.prevention ? `\n\nPrevention\n${input.prevention}` : ""}`,
          ...(input.repository ? { repository: input.repository } : {}),
          tags: input.tags,
          sources: input.sources,
        };
        const plan = planDraft(plans, draft, `Record incident: ${input.title}`);
        return success(planOutput(plan), plan.summary, startedAt);
      }),
  );

  server.registerTool(
    "plan_record_verification",
    {
      title: "Plan verification record",
      description: "Plan a verified result and evidence memory without executing a command.",
      inputSchema: BaseRecordSchema.extend({
        result: z.enum(["passed", "failed", "partial"]),
        summary: z.string().min(1).max(262_144),
        command: z.string().max(2_048).optional(),
        evidence: z.array(z.string().max(4_096)).default([]),
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: writePlan,
    },
    async (input) =>
      invokeTool(async (startedAt) => {
        if (input.repository) await resolveRepository(config, input.repository);
        const draft: MemoryDraft = {
          kind: "verification",
          title: input.title,
          body: `Result: ${input.result}\n${input.command ? `Command: ${input.command}\n` : ""}${input.summary}${input.evidence.length ? `\n\nEvidence\n${input.evidence.join("\n")}` : ""}`,
          ...(input.repository ? { repository: input.repository } : {}),
          tags: input.tags,
          sources: input.sources,
        };
        const plan = planDraft(plans, draft, `Record verification: ${input.title}`);
        return success(planOutput(plan), plan.summary, startedAt);
      }),
  );

  server.registerTool(
    "plan_link_memory",
    {
      title: "Plan memory link",
      description: "Plan linking an existing memory to a configured repository reference.",
      inputSchema: z.object({
        memoryId: z.string().uuid(),
        repository: RepositoryInputSchema.shape.repository,
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: writePlan,
    },
    async ({ memoryId, repository }) =>
      invokeTool(async (startedAt) => {
        await resolveRepository(config, repository);
        const plan = plans.create<MemoryPlanPayload>({
          kind: "memory-write",
          fingerprint: `${memoryId}:${repository.rootId}:${repository.relativePath}`,
          summary: `Link memory ${memoryId} to ${repository.rootId}:${repository.relativePath}`,
          payload: { action: "link", memoryId, repository },
        });
        return success(planOutput(plan), plan.summary, startedAt);
      }),
  );

  server.registerTool(
    "plan_import_memory",
    {
      title: "Plan memory import",
      description: "Parse an explicitly allowed Markdown, JSON, JSONL, or Codex rollout file.",
      inputSchema: z.object({
        path: z.string().min(1),
        format: z.enum(["auto", "markdown", "json", "jsonl", "codex-jsonl"]).default("auto"),
        repository: RepositoryOptionalSchema,
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: writePlan,
    },
    async (input) =>
      invokeTool(async (startedAt) => {
        if (config.servers.projectMemory.importRoots.length === 0) {
          throw new KkError("CAPABILITY_DISABLED", "No projectMemory.importRoots are configured");
        }
        const file = await assertAllowedAbsolutePath(
          input.path,
          config.servers.projectMemory.importRoots,
        );
        if (input.repository) await resolveRepository(config, input.repository);
        const drafts = importDrafts(config, file, input.format, input.repository);
        const duplicates = drafts.filter((draft) =>
          database.hasHash(memoryContentHash(draft)),
        ).length;
        const sourceHash = createHash("sha256")
          .update(await readFile(file))
          .digest("hex");
        const plan = plans.create<MemoryPlanPayload>({
          kind: "memory-write",
          fingerprint: sourceHash,
          summary: `Import ${drafts.length - duplicates} new records from ${file}`,
          risks: ["Imported conversation text may contain private project context"],
          payload: { action: "insert", source: "import", drafts, file, sourceHash },
        });
        return success(
          {
            ...planOutput(plan),
            parsed: drafts.length,
            duplicates,
            newRecords: drafts.length - duplicates,
          },
          plan.summary,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "apply_memory_plan",
    {
      title: "Apply memory plan",
      description: "Apply a fresh record, link, or import plan to the local SQLite database.",
      inputSchema: PlanIdInputSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: destructive,
    },
    async ({ planId }) =>
      invokeTool(async (startedAt) => {
        const plan = plans.get<MemoryPlanPayload>(planId, "memory-write");
        if (plan.payload.action === "insert" && plan.payload.source === "import") {
          requireCapability(
            config.capabilities.projectMemory.import,
            "capabilities.projectMemory.import",
          );
          const file = await assertAllowedAbsolutePath(
            plan.payload.file,
            config.servers.projectMemory.importRoots,
          );
          const currentHash = createHash("sha256")
            .update(await readFile(file))
            .digest("hex");
          if (currentHash !== plan.fingerprint || currentHash !== plan.payload.sourceHash) {
            throw new KkError("STALE_PLAN", "Import source changed after planning");
          }
        } else {
          requireCapability(
            config.capabilities.projectMemory.write,
            "capabilities.projectMemory.write",
          );
        }
        let result: Record<string, unknown>;
        if (plan.payload.action === "link") {
          result = { record: database.link(plan.payload.memoryId, plan.payload.repository) };
        } else {
          const records = plan.payload.drafts.map((draft) => database.insert(draft));
          result = { records: boundedRecords(records), count: records.length };
        }
        plans.consume(planId, "memory-write");
        await appendAudit(config, {
          server: "project-memory",
          action: "memory-write",
          outcome: "applied",
          details: { planId, action: plan.payload.action },
        });
        return success(result, `Applied memory plan ${planId}.`, startedAt);
      }),
  );

  registerCapabilitiesTool(server, config, "project-memory", {
    write: config.capabilities.projectMemory.write,
    import: config.capabilities.projectMemory.import,
    search: "SQLite FTS5",
    importFormats: ["markdown", "json", "jsonl", "codex-jsonl"],
  });

  server.registerResource(
    "memory-stats",
    "project-memory://stats",
    { title: "Project memory statistics", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(database.stats(), null, 2),
        },
      ],
    }),
  );
  return server;
}
