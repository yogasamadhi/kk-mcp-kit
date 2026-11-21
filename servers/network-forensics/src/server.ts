import {
  createMcpServer,
  invokeTool,
  type KkConfig,
  KkError,
  registerCapabilitiesTool,
  requireCapability,
  StandardOutputSchema,
  success,
} from "@kk-mcp-kit/core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  type AddressFamily,
  inspectDns,
  inspectProxyEnvironment,
  inspectTls,
  networkCapabilities,
  parseAllowedUrl,
  traceHttp,
  traceRoute,
} from "./domain/network.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
const active = { readOnlyHint: true, destructiveHint: false, idempotentHint: false } as const;
const FamilySchema = z.enum(["auto", "ipv4", "ipv6"]).default("auto");

function requireActive(config: KkConfig): void {
  requireCapability(
    config.capabilities.networkForensics.activeProbe,
    "capabilities.networkForensics.activeProbe",
  );
}

function errorMessage(error: unknown): Record<string, unknown> {
  if (error instanceof KkError) return { ok: false, code: error.code, message: error.message };
  return {
    ok: false,
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function createServer(config: KkConfig): McpServer {
  const server = createMcpServer(
    "network-forensics",
    "Perform bounded DNS, TLS, HTTP, and route diagnostics only for explicitly allowed hosts. Active probes are disabled by default.",
  );

  server.registerTool(
    "list_network_capabilities",
    {
      title: "List network capabilities",
      description: "Detect standard-module and route tracing backends without probing a target.",
      inputSchema: z.object({}).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async () =>
      invokeTool(async (startedAt) =>
        success(
          {
            ...(await networkCapabilities()),
            activeProbe: config.capabilities.networkForensics.activeProbe,
            allowedHosts: config.servers.networkForensics.allowedHosts,
          },
          "Detected network diagnostic capabilities.",
          startedAt,
        ),
      ),
  );

  server.registerTool(
    "inspect_proxy_environment",
    {
      title: "Inspect proxy environment",
      description: "Report proxy environment configuration with credentials removed.",
      inputSchema: z.object({}).shape,
      outputSchema: StandardOutputSchema,
      annotations: readOnly,
    },
    async () =>
      invokeTool(async (startedAt) =>
        success(inspectProxyEnvironment(), "Inspected proxy environment.", startedAt),
      ),
  );

  server.registerTool(
    "inspect_dns",
    {
      title: "Inspect DNS",
      description: "Resolve an allowed hostname and return bounded DNS metadata.",
      inputSchema: z.object({ hostname: z.string().min(1).max(253), family: FamilySchema }).shape,
      outputSchema: StandardOutputSchema,
      annotations: active,
    },
    async ({ hostname, family }) =>
      invokeTool(async (startedAt) => {
        requireActive(config);
        return success(
          await inspectDns(config, hostname, family),
          `Resolved ${hostname}.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "inspect_tls",
    {
      title: "Inspect TLS",
      description:
        "Perform a TLS handshake to an allowed host with certificate verification enabled.",
      inputSchema: z.object({
        hostname: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65_535).default(443),
        family: FamilySchema,
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: active,
    },
    async ({ hostname, port, family }) =>
      invokeTool(async (startedAt) => {
        requireActive(config);
        return success(
          await inspectTls(config, hostname, port, family),
          `Inspected TLS for ${hostname}:${port}.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "trace_http_request",
    {
      title: "Trace HTTP request",
      description:
        "Trace DNS/TCP/TLS/first-byte phases without returning a response body or sending credentials.",
      inputSchema: z.object({
        url: z.string().url(),
        method: z.enum(["HEAD", "GET"]).default("HEAD"),
        family: FamilySchema,
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: active,
    },
    async ({ url, method, family }) =>
      invokeTool(async (startedAt) => {
        requireActive(config);
        return success(await traceHttp(config, url, method, family), `Traced ${url}.`, startedAt);
      }),
  );

  server.registerTool(
    "trace_route",
    {
      title: "Trace route",
      description: "Run a detected route tracer against the pinned IP of an allowed hostname.",
      inputSchema: z.object({
        hostname: z.string().min(1).max(253),
        maxHops: z.number().int().min(1).max(64).default(20),
      }).shape,
      outputSchema: StandardOutputSchema,
      annotations: active,
    },
    async ({ hostname, maxHops }) =>
      invokeTool(async (startedAt) => {
        requireActive(config);
        return success(
          await traceRoute(config, hostname, maxHops),
          `Traced route to ${hostname}.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "diagnose_endpoint",
    {
      title: "Diagnose endpoint",
      description: "Combine DNS, optional TLS, and HTTP traces for one allowed endpoint.",
      inputSchema: z.object({ url: z.string().url(), family: FamilySchema }).shape,
      outputSchema: StandardOutputSchema,
      annotations: active,
    },
    async ({ url, family }) =>
      invokeTool(async (startedAt) => {
        requireActive(config);
        const parsed = parseAllowedUrl(config, url);
        const dnsResult = await inspectDns(config, parsed.hostname, family).catch(errorMessage);
        const tlsResult =
          parsed.protocol === "https:"
            ? await inspectTls(config, parsed.hostname, Number(parsed.port || 443), family).catch(
                errorMessage,
              )
            : { skipped: true, reason: "plain HTTP" };
        const httpResult = await traceHttp(config, url, "HEAD", family).catch(errorMessage);
        return success(
          { url, dns: dnsResult, tls: tlsResult, http: httpResult },
          `Diagnosed ${url}.`,
          startedAt,
        );
      }),
  );

  server.registerTool(
    "compare_network_paths",
    {
      title: "Compare network paths",
      description: "Compare an endpoint across configured named direct network profiles.",
      inputSchema: z.object({ url: z.string().url(), profileIds: z.array(z.string()).optional() })
        .shape,
      outputSchema: StandardOutputSchema,
      annotations: active,
    },
    async ({ url, profileIds }) =>
      invokeTool(async (startedAt) => {
        requireActive(config);
        parseAllowedUrl(config, url);
        const selected = profileIds
          ? profileIds.map((id) => {
              const profile = config.servers.networkForensics.profiles.find(
                (candidate) => candidate.id === id,
              );
              if (!profile) throw new KkError("INVALID_ARGUMENT", `Unknown network profile: ${id}`);
              return profile;
            })
          : config.servers.networkForensics.profiles;
        const results: Array<Record<string, unknown>> = [];
        for (const profile of selected) {
          if (profile.proxyUrl) {
            results.push({
              profileId: profile.id,
              ok: false,
              error: {
                code: "UNSUPPORTED_BACKEND",
                message:
                  "Proxy profiles require an explicit proxy transport backend, which is not enabled in v1",
              },
            });
            continue;
          }
          const profileStartedAt = Date.now();
          try {
            const trace = await traceHttp(config, url, "HEAD", profile.family);
            results.push({
              profileId: profile.id,
              family: profile.family as AddressFamily,
              ok: true,
              durationMs: Date.now() - profileStartedAt,
              trace,
            });
          } catch (error) {
            results.push({
              profileId: profile.id,
              family: profile.family,
              durationMs: Date.now() - profileStartedAt,
              ...errorMessage(error),
            });
          }
        }
        return success({ url, results }, `Compared ${results.length} network profiles.`, startedAt);
      }),
  );

  registerCapabilitiesTool(server, config, "network-forensics", {
    activeProbe: config.capabilities.networkForensics.activeProbe,
    allowedHosts: config.servers.networkForensics.allowedHosts,
    profileCount: config.servers.networkForensics.profiles.length,
    proxyEnvironmentReadOnly: true,
    rawPacketCapture: false,
  });
  return server;
}
