import {
  createMcpServer,
  invokeTool,
  type KkConfig,
  KkError,
  RepositoryInputSchema,
  redactValue,
  registerCapabilitiesTool,
  resolveRepository,
  StandardOutputSchema,
  success,
} from "@kk-mcp-kit/core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { searchWorkspace } from "./domain/search.js";
import {
  dependencyGraph,
  discoverRepositories,
  inspectRepository,
  projectInstructions,
  summarizeRepository,
} from "./domain/workspace.js";

const RootSelectionSchema = z.object({ rootIds: z.array(z.string()).optional() });

function annotations(readOnly = true) {
  return { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true } as const;
}

export function createServer(config: KkConfig): McpServer {
  const server = createMcpServer(
    "workspace",
    "Read-only workspace inventory and dependency intelligence. Paths are restricted to configured roots.",
  );

  server.registerTool(
    "discover_repositories",
    {
      title: "Discover repositories",
      description: "Find Git repositories below configured workspace roots.",
      inputSchema: RootSelectionSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: annotations(),
    },
    async ({ rootIds }) =>
      invokeTool(async (startedAt) => {
        const repositories = await discoverRepositories(config, rootIds);
        return success(
          { repositories, count: repositories.length },
          `Discovered ${repositories.length} repositories.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "inspect_repository",
    {
      title: "Inspect repository",
      description: "Inspect manifests, Git state, remotes, scripts, and project instructions.",
      inputSchema: RepositoryInputSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: annotations(),
    },
    async ({ repository }) =>
      invokeTool(async (startedAt) => {
        const absolute = await resolveRepository(config, repository);
        const root = config.roots.find((candidate) => candidate.id === repository.rootId);
        if (!root) throw new KkError("INVALID_ARGUMENT", `Unknown rootId: ${repository.rootId}`);
        const summary = await summarizeRepository(repository.rootId, root.path, absolute);
        const inspection = await inspectRepository(summary);
        return success(
          redactValue(inspection, config.audit.redactionPatterns),
          `Inspected ${summary.name}.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "inspect_workspace",
    {
      title: "Inspect workspace",
      description: "Summarize configured roots, repositories, ecosystems, and dirty worktrees.",
      inputSchema: RootSelectionSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: annotations(),
    },
    async ({ rootIds }) =>
      invokeTool(async (startedAt) => {
        const repositories = await discoverRepositories(config, rootIds);
        const ecosystems = Object.fromEntries(
          [...new Set(repositories.flatMap((repository) => repository.ecosystems))].map(
            (ecosystem) => [
              ecosystem,
              repositories.filter((repository) => repository.ecosystems.includes(ecosystem)).length,
            ],
          ),
        );
        return success(
          {
            roots: config.roots
              .filter((root) => !rootIds || rootIds.includes(root.id))
              .map(({ id, path, maxDepth }) => ({ id, path, maxDepth })),
            repositoryCount: repositories.length,
            dirtyRepositories: repositories
              .filter((repository) => repository.dirty)
              .map((r) => r.id),
            ecosystems,
          },
          `Inspected ${repositories.length} repositories.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "find_project_instructions",
    {
      title: "Find project instructions",
      description: "Read bounded AGENTS, README, CLAUDE, and repository instruction files.",
      inputSchema: RepositoryInputSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: annotations(),
    },
    async ({ repository }) =>
      invokeTool(async (startedAt) => {
        const absolute = await resolveRepository(config, repository);
        const instructions = await projectInstructions(absolute);
        return success(
          redactValue({ repository, instructions }, config.audit.redactionPatterns),
          `Found ${instructions.length} instruction files.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "analyze_dependency_graph",
    {
      title: "Analyze dependency graph",
      description: "Build a cross-repository graph from common language and build manifests.",
      inputSchema: RootSelectionSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: annotations(),
    },
    async ({ rootIds }) =>
      invokeTool(async (startedAt) => {
        const repositories = await discoverRepositories(config, rootIds);
        const graph = await dependencyGraph(repositories);
        return success(
          redactValue(graph, config.audit.redactionPatterns),
          `Built a graph with ${graph.nodes.length} nodes.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "search_workspace",
    {
      title: "Search workspace",
      description:
        "Search text below configured roots with bounded output and a portable fallback.",
      inputSchema: z.object({
        query: z.string().min(1).max(1_000),
        rootIds: z.array(z.string()).optional(),
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: annotations(),
    },
    async ({ query, rootIds }) =>
      invokeTool(async (startedAt) => {
        const selected = rootIds ?? config.roots.map((root) => root.id);
        const result = await searchWorkspace(config, query, selected);
        return success(
          redactValue(result, config.audit.redactionPatterns),
          `Found ${result.matches.length} matches.`,
          startedAt,
        );
      }),
  );

  registerCapabilitiesTool(server, config, "workspace", {
    readOnly: true,
    manifestAdapters: ["javascript", "rust", "go", "python", "maven", "gradle"],
  });

  server.registerResource(
    "workspace-roots",
    "workspace://roots",
    { title: "Configured workspace roots", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(config.roots, null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "workspace-repositories",
    "workspace://repositories",
    { title: "Discovered repositories", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await discoverRepositories(config), null, 2),
        },
      ],
    }),
  );

  return server;
}
