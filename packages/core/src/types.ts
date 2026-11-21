export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "CONFIG_ERROR",
  "PATH_OUTSIDE_ROOT",
  "CAPABILITY_DISABLED",
  "PLAN_NOT_FOUND",
  "PLAN_EXPIRED",
  "STALE_PLAN",
  "COMMAND_NOT_FOUND",
  "UNSUPPORTED_PLATFORM",
  "UNSUPPORTED_BACKEND",
  "PERMISSION_DENIED",
  "TIMEOUT",
  "OUTPUT_LIMIT",
  "CONFLICT",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ToolError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ResultMeta {
  requestId: string;
  durationMs: number;
  platform: NodeJS.Platform;
  truncated?: boolean;
  warnings?: string[];
}

export type ToolEnvelope<T> =
  | { ok: true; data: T; meta: ResultMeta }
  | { ok: false; error: ToolError; meta: ResultMeta };

export interface McpToolResult {
  [key: string]: unknown;
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export interface RepositoryRef {
  rootId: string;
  relativePath: string;
}

export interface ArtifactRecord {
  id: string;
  server: string;
  relativePath: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
  uri: string;
}
