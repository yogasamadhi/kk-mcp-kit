import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { KkConfig } from "./config.js";
import { KkError } from "./errors.js";
import { invokeTool, success } from "./result.js";
import { EmptyInputSchema, StandardOutputSchema } from "./schemas.js";

export function createMcpServer(name: string, instructions: string): McpServer {
  return new McpServer({ name: `kk-mcp-${name}`, version: "0.2.0" }, { instructions });
}

export function requireCapability(enabled: boolean, configKey: string): void {
  if (!enabled) {
    throw new KkError("CAPABILITY_DISABLED", `Capability is disabled: ${configKey}`, {
      details: { configKey },
    });
  }
}

export function registerCapabilitiesTool(
  server: McpServer,
  config: KkConfig,
  serverName: string,
  capabilities: Record<string, unknown>,
): void {
  server.registerTool(
    "get_capabilities",
    {
      title: "Get server capabilities",
      description: "Report configured and platform-dependent capabilities for this MCP server.",
      inputSchema: EmptyInputSchema.shape,
      outputSchema: StandardOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () =>
      invokeTool(async (startedAt) =>
        success(
          {
            server: serverName,
            platform: process.platform,
            architecture: process.arch,
            node: process.version,
            configuredRoots: config.roots.map((root) => root.id),
            ...capabilities,
          },
          `Reported ${serverName} capabilities.`,
          startedAt,
        ),
      ),
  );
}

export const PlanIdInputSchema = z.object({ planId: z.string().uuid() });
