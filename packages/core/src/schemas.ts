import { z } from "zod/v4";
import { ERROR_CODES } from "./types.js";

export const EmptyInputSchema = z.object({});
export const RepositoryInputSchema = z.object({
  repository: z.object({
    rootId: z.string().min(1),
    relativePath: z.string().default("."),
  }),
});

export const StandardOutputSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.enum(ERROR_CODES),
      message: z.string(),
      retryable: z.boolean(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  meta: z.object({
    requestId: z.string(),
    durationMs: z.number(),
    platform: z.string(),
    truncated: z.boolean().optional(),
    warnings: z.array(z.string()).optional(),
  }),
});
