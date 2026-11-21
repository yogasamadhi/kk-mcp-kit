import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore, type KkConfig, type VerificationProfile } from "@kk-mcp-kit/core";
import { EvidenceDatabase, parseXcResult, runVerification } from "../src/domain/evidence.js";

function baseConfig(directory: string, profiles: VerificationProfile[]): KkConfig {
  return {
    version: 1,
    stateDir: path.join(directory, "state"),
    roots: [{ id: "repo", path: path.join(directory, "repo"), maxDepth: 8 }],
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
      buildEvidence: { run: true },
      desktopLab: { launch: false, stop: false, capture: false },
      networkForensics: { activeProbe: false },
    },
    servers: {
      workspace: { ignoredDirectories: [] },
      gitGuardian: { vendors: [] },
      runtimeObserver: { services: [] },
      projectMemory: { importRoots: [] },
      buildEvidence: { profiles },
      desktopLab: { apps: [] },
      networkForensics: { allowedHosts: ["localhost"], profiles: [] },
    },
  };
}

test("runs named fixture profiles, stores failures, artifacts, and comparisons", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kk-mcp-evidence-test-"));
  try {
    const repository = path.join(directory, "repo");
    await mkdir(repository);
    const node = process.env.NODE_BINARY ?? "node";
    const common = {
      repository: { rootId: "repo", relativePath: "." },
      command: node,
      timeoutMs: 10_000,
      environmentAllowlist: [],
      resultPaths: [],
    } as const;
    const pass: VerificationProfile = {
      ...common,
      id: "pass",
      args: ["-e", "require('node:fs').writeFileSync('artifact.txt','evidence')"],
      parser: "generic",
      artifactGlobs: ["artifact.txt"],
    };
    const fail: VerificationProfile = {
      ...common,
      id: "fail",
      args: ["-e", "process.stderr.write('sample.test.ts:7: error: broke\\n');process.exit(1)"],
      parser: "generic",
      artifactGlobs: [],
    };
    const config = baseConfig(directory, [pass, fail]);
    const database = new EvidenceDatabase(config);
    const store = new ArtifactStore(config, "build-evidence");
    const passed = await runVerification(config, pass, repository, database, store);
    const failed = await runVerification(config, fail, repository, database, store);
    expect(passed.status).toBe("passed");
    expect(passed.artifacts).toHaveLength(1);
    const artifact = passed.artifacts[0];
    if (!artifact) throw new Error("Expected a captured artifact");
    expect((await store.get(artifact.id)).sha256).toBe(artifact.sha256);
    expect(await store.list()).toHaveLength(1);
    expect(failed.status).toBe("failed");
    expect(failed.failures[0]).toMatchObject({ file: "sample.test.ts", line: 7, message: "broke" });
    expect(database.get(failed.id).failures).toHaveLength(1);
    expect(database.compare(passed.id, failed.id).newlyFailing).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parses plain and legacy-wrapped XCResult failure nodes", () => {
  const failures = parseXcResult(
    JSON.stringify({
      tests: [
        {
          name: "plain test",
          testStatus: "Failure",
          failureSummaries: [{ message: "plain broke" }],
        },
        {
          name: { _value: "legacy test" },
          testStatus: { _value: "Failure" },
          failureSummaries: { _values: [{ message: { _value: "legacy broke" } }] },
        },
      ],
    }),
  );
  expect(failures).toEqual([
    { name: "plain test", message: "plain broke" },
    { name: "legacy test", message: "legacy broke" },
  ]);
});
