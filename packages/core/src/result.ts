import { randomUUID } from "node:crypto";
import { asKkError } from "./errors.js";
import type { McpToolResult, ResultMeta, ToolEnvelope } from "./types.js";

function metadata(startedAt: number, overrides: Partial<ResultMeta> = {}): ResultMeta {
  return {
    requestId: overrides.requestId ?? randomUUID(),
    durationMs: overrides.durationMs ?? Math.max(0, Date.now() - startedAt),
    platform: overrides.platform ?? process.platform,
    ...(overrides.truncated === undefined ? {} : { truncated: overrides.truncated }),
    ...(overrides.warnings === undefined ? {} : { warnings: overrides.warnings }),
  };
}

function structured<T>(envelope: ToolEnvelope<T>): Record<string, unknown> {
  return envelope as unknown as Record<string, unknown>;
}

export function success<T>(
  data: T,
  summary: string,
  startedAt = Date.now(),
  overrides: Partial<ResultMeta> = {},
): McpToolResult {
  const envelope: ToolEnvelope<T> = { ok: true, data, meta: metadata(startedAt, overrides) };
  return { content: [{ type: "text", text: summary }], structuredContent: structured(envelope) };
}

export function failure(error: unknown, startedAt = Date.now()): McpToolResult {
  const normalized = asKkError(error);
  const envelope: ToolEnvelope<never> = {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    },
    meta: metadata(startedAt),
  };
  return {
    content: [{ type: "text", text: `${normalized.code}: ${normalized.message}` }],
    structuredContent: structured(envelope),
    isError: true,
  };
}

export async function invokeTool(
  operation: (startedAt: number) => Promise<McpToolResult>,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  try {
    return await operation(startedAt);
  } catch (error) {
    return failure(error, startedAt);
  }
}
