import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand, type VendorConfig } from "@kk-mcp-kit/core";
import { applyVendorSync, gitFingerprint, prepareVendorSync } from "../src/domain/git.js";

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await runCommand("git", ["-C", directory, ...args], {
    maxOutputBytes: 1_048_576,
  });
  return result.stdout.trim();
}

async function commitAll(directory: string, message: string): Promise<string> {
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", message);
  return git(directory, "rev-parse", "HEAD");
}

test("plans and applies submodule/vendor-lock sync and rolls back a failed apply", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kk-mcp-git-test-"));
  try {
    const remote = path.join(directory, "vendor-remote");
    const parent = path.join(directory, "parent");
    await mkdir(remote);
    await mkdir(parent);
    for (const repository of [remote, parent]) {
      await git(repository, "init", "-b", "main");
      await git(repository, "config", "user.email", "test@example.invalid");
      await git(repository, "config", "user.name", "kk-mcp test");
    }
    await writeFile(
      path.join(remote, "package.json"),
      JSON.stringify({ name: "vendor", version: "1.0.0" }),
    );
    const firstRevision = await commitAll(remote, "v1");
    await runCommand("git", [
      "-c",
      "protocol.file.allow=always",
      "-C",
      parent,
      "submodule",
      "add",
      remote,
      "vendor/lib",
    ]);
    await writeFile(
      path.join(parent, "vendor-lock.json"),
      `${JSON.stringify({ schemaVersion: 1, vendors: { lib: { revision: firstRevision, version: "1.0.0", artifactSha256: { old: "hash" } } } }, null, 2)}\n`,
    );
    await commitAll(parent, "add vendor");

    await writeFile(
      path.join(remote, "package.json"),
      JSON.stringify({ name: "vendor", version: "2.0.0" }),
    );
    const secondRevision = await commitAll(remote, "v2");
    const vendor: VendorConfig = {
      id: "lib",
      repository: { rootId: "repo", relativePath: "." },
      path: "vendor/lib",
      lockFile: "vendor-lock.json",
      remote: "origin",
    };
    const prepared = await prepareVendorSync(vendor, parent);
    expect(prepared.payload.currentRevision).toBe(firstRevision);
    expect(prepared.payload.targetRevision).toBe(secondRevision);
    const before = await gitFingerprint(parent);
    expect(prepared.fingerprint).toBe(before);

    const applied = await applyVendorSync(prepared.payload);
    expect(applied.changed).toBeTrue();
    expect(await git(path.join(parent, "vendor/lib"), "rev-parse", "HEAD")).toBe(secondRevision);
    const lock = JSON.parse(await readFile(path.join(parent, "vendor-lock.json"), "utf8")) as {
      vendors: { lib: { revision: string; version: string; artifactSha256: object } };
    };
    expect(lock.vendors.lib).toMatchObject({
      revision: secondRevision,
      version: "2.0.0",
      artifactSha256: {},
    });

    await git(path.join(parent, "vendor/lib"), "checkout", "--detach", firstRevision);
    await writeFile(path.join(parent, "vendor-lock.json"), prepared.payload.previousLock);
    await expect(
      applyVendorSync({
        ...prepared.payload,
        lockPath: path.join(parent, "missing", "vendor-lock.json"),
      }),
    ).rejects.toBeDefined();
    expect(await git(path.join(parent, "vendor/lib"), "rev-parse", "HEAD")).toBe(firstRevision);
    await writeFile(path.join(parent, "vendor-lock.json"), "dirty-state-one");
    const dirtyFingerprint = await gitFingerprint(parent);
    await writeFile(path.join(parent, "vendor-lock.json"), "dirty-state-two");
    expect(await gitFingerprint(parent)).not.toBe(dirtyFingerprint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
