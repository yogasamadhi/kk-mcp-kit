import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  KkError,
  loadConfig,
  PlanStore,
  redactText,
  repositoryStateFingerprint,
  resolveWithinRoot,
  runCommand,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "kk-mcp-core-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("configuration", () => {
  test("loads defaults and keeps every executing capability disabled", async () => {
    const directory = await temporaryDirectory();
    const root = path.join(directory, "root");
    await mkdir(root);
    const configPath = path.join(directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        stateDir: path.join(directory, "state"),
        roots: [{ id: "test", path: root }],
      }),
    );
    const config = await loadConfig(configPath);
    expect(config.limits.maxOutputBytes).toBe(262_144);
    expect(config.capabilities.gitGuardian.applyVendorSync).toBeFalse();
    expect(config.capabilities.runtimeObserver.stopProcess).toBeFalse();
    expect(config.capabilities.projectMemory.write).toBeFalse();
    expect(config.capabilities.projectMemory.import).toBeFalse();
    expect(config.capabilities.buildEvidence.run).toBeFalse();
    expect(config.capabilities.desktopLab.launch).toBeFalse();
    expect(config.capabilities.desktopLab.stop).toBeFalse();
    expect(config.capabilities.desktopLab.capture).toBeFalse();
    expect(config.capabilities.networkForensics.activeProbe).toBeFalse();
  });

  test("rejects relative config paths", async () => {
    await expect(loadConfig("config.json")).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});

describe("path policy", () => {
  test("rejects lexical and symbolic-link root escapes", async () => {
    const directory = await temporaryDirectory();
    const root = path.join(directory, "root");
    const outside = path.join(directory, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(
      outside,
      path.join(root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const config = {
      roots: [{ id: "test", path: root, maxDepth: 8 }],
    } as Parameters<typeof resolveWithinRoot>[0];
    await expect(resolveWithinRoot(config, "test", "../outside")).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
    });
    await expect(resolveWithinRoot(config, "test", "escape/file.txt")).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
    });
  });
});

describe("plans and processes", () => {
  test("consumes opaque plans exactly once", () => {
    const plans = new PlanStore();
    const plan = plans.create({ kind: "test", fingerprint: "state", summary: "test", payload: 1 });
    expect(plan.planId).toMatch(/^[0-9a-f-]{36}$/);
    expect(plans.consume<number>(plan.planId, "test").payload).toBe(1);
    expect(() => plans.get(plan.planId)).toThrow(KkError);
  });

  test("executes without a shell and truncates bounded output", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(10000))"],
      {
        maxOutputBytes: 1_024,
      },
    );
    expect(result.stdout.length).toBe(1_024);
    expect(result.truncated).toBeTrue();
  });
});

test("repository fingerprints detect same-path content drift outside Git", async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, "state.txt");
  await writeFile(file, "one");
  const before = await repositoryStateFingerprint(directory);
  await writeFile(file, "two");
  expect(await repositoryStateFingerprint(directory)).not.toBe(before);
});

test("redacts common secret formats", () => {
  expect(redactText("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization: [REDACTED]");
  expect(redactText("--token super-secret-value")).toBe("--token [REDACTED]");
  expect(redactText("https://user:password@example.invalid/repo.git")).toContain(":[REDACTED]@");
});
