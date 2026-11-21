import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { KkConfig } from "./config.js";
import { redactValue } from "./redaction.js";

export async function appendAudit(
  config: KkConfig,
  event: {
    server: string;
    action: string;
    outcome: "planned" | "applied" | "rejected" | "failed";
    details?: Record<string, unknown>;
  },
): Promise<void> {
  if (!config.audit.enabled) return;
  const directory = path.join(config.stateDir, "audit");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const record = redactValue(
    { timestamp: new Date().toISOString(), ...event },
    config.audit.redactionPatterns,
  );
  await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}
