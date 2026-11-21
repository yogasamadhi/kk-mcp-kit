import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KkConfig } from "@kk-mcp-kit/core";
import { importDrafts, MemoryDatabase } from "../src/domain/memory.js";

function config(stateDir: string, root: string): KkConfig {
  return {
    version: 1,
    stateDir,
    roots: [{ id: "repo", path: root, maxDepth: 8 }],
    limits: {
      defaultTimeoutMs: 30_000,
      maxOutputBytes: 262_144,
      maxArtifactBytes: 10_485_760,
      maxItems: 500,
      planTtlMs: 300_000,
    },
    audit: { enabled: false, redactionPatterns: [] },
    capabilities: {
      gitGuardian: { applyVendorSync: false },
      runtimeObserver: { stopProcess: false },
      projectMemory: { write: false, import: false },
      buildEvidence: { run: false },
      desktopLab: { launch: false, stop: false, capture: false },
      networkForensics: { activeProbe: false },
    },
    servers: {
      workspace: { ignoredDirectories: [] },
      gitGuardian: { vendors: [] },
      runtimeObserver: { services: [] },
      projectMemory: { importRoots: [root] },
      buildEvidence: { profiles: [] },
      desktopLab: { apps: [] },
      networkForensics: { allowedHosts: ["localhost"], profiles: [] },
    },
  };
}

test("imports, redacts, deduplicates, and searches Codex-style JSONL", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kk-mcp-memory-test-"));
  try {
    const root = path.join(directory, "repo");
    const state = path.join(directory, "state");
    await mkdir(root);
    const file = path.join(root, "rollout.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "decision with sk-abcdefghijklmnop" } })}\n`,
    );
    const testConfig = config(state, root);
    const drafts = importDrafts(testConfig, file, "codex-jsonl", {
      rootId: "repo",
      relativePath: ".",
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.body).toContain("[REDACTED]");
    const draft = drafts[0];
    if (!draft) throw new Error("Expected an imported draft");
    const database = new MemoryDatabase(testConfig);
    const first = database.insert(draft);
    const duplicate = database.insert(draft);
    expect(duplicate.id).toBe(first.id);
    expect(database.search({ query: "decision", limit: 10 })).toHaveLength(1);
    await writeFile(file, `${JSON.stringify({ type: "unknown_future_record", payload: {} })}\n`);
    expect(() => importDrafts(testConfig, file, "codex-jsonl")).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
