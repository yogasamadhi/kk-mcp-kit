import type { ErrorCode } from "./types.js";

export class KkError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "KkError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function asKkError(error: unknown): KkError {
  if (error instanceof KkError) return error;
  if (error instanceof Error) {
    return new KkError("INTERNAL_ERROR", error.message, { cause: error });
  }
  return new KkError("INTERNAL_ERROR", "An unknown error occurred", {
    details: { value: String(error) },
  });
}
