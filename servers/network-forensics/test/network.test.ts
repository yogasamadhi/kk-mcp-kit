import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KkConfig } from "@kk-mcp-kit/core";
import { assertAllowedHost, inspectDns, traceHttp } from "../src/domain/network.js";

function config(directory: string): KkConfig {
  return {
    version: 1,
    stateDir: path.join(directory, "state"),
    roots: [{ id: "repo", path: directory, maxDepth: 8 }],
    limits: {
      defaultTimeoutMs: 5_000,
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
      networkForensics: { activeProbe: true },
    },
    servers: {
      workspace: { ignoredDirectories: [] },
      gitGuardian: { vendors: [] },
      runtimeObserver: { services: [] },
      projectMemory: { importRoots: [] },
      buildEvidence: { profiles: [] },
      desktopLab: { apps: [] },
      networkForensics: { allowedHosts: ["localhost", "127.0.0.1"], profiles: [] },
    },
  };
}

test("pins and traces an allowed local HTTP endpoint without returning its body", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kk-mcp-network-test-"));
  await mkdir(path.join(directory, "state"));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain", "x-secret": "never-return" });
    response.end("private response body");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const testConfig = config(directory);
    const dns = await inspectDns(testConfig, "127.0.0.1", "ipv4");
    expect(dns.addresses).toEqual([{ address: "127.0.0.1", family: 4 }]);
    const trace = await traceHttp(
      testConfig,
      `http://127.0.0.1:${address.port}/private`,
      "GET",
      "ipv4",
    );
    expect(JSON.stringify(trace)).not.toContain("private response body");
    expect(JSON.stringify(trace)).not.toContain("never-return");
    expect(() => assertAllowedHost(testConfig, "example.com")).toThrow();
    await expect(
      traceHttp(testConfig, `http://127.0.0.1:${address.port}/?token=secret`, "HEAD", "ipv4"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
