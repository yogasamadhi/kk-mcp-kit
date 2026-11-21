import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertAllowedAbsolutePath,
  KkError,
  type RepositoryRef,
  redactText,
  repositoryStateFingerprint,
  runCommand,
  type VendorConfig,
} from "@kk-mcp-kit/core";

async function git(repositoryPath: string, args: readonly string[], allowNonZero = false) {
  return runCommand("git", ["-C", repositoryPath, ...args], {
    allowNonZero,
    timeoutMs: 60_000,
    maxOutputBytes: 1_048_576,
    environmentAllowlist: ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSH_AUTH_SOCK"],
  });
}

export async function assertGitRepository(repositoryPath: string): Promise<void> {
  const result = await git(repositoryPath, ["rev-parse", "--is-inside-work-tree"], true);
  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new KkError("INVALID_ARGUMENT", `Not a Git repository: ${repositoryPath}`);
  }
}

export async function gitFingerprint(repositoryPath: string): Promise<string> {
  const [state, submodules] = await Promise.all([
    repositoryStateFingerprint(repositoryPath),
    git(repositoryPath, ["submodule", "status", "--recursive"], true),
  ]);
  return createHash("sha256").update(state).update("\0").update(submodules.stdout).digest("hex");
}

export async function inspectGitState(repositoryPath: string): Promise<Record<string, unknown>> {
  await assertGitRepository(repositoryPath);
  const [status, branch, head, remotes, upstream] = await Promise.all([
    git(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(repositoryPath, ["branch", "--show-current"], true),
    git(repositoryPath, ["rev-parse", "HEAD"]),
    git(repositoryPath, ["remote", "-v"], true),
    git(repositoryPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true),
  ]);
  const changes = status.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
  return {
    branch: branch.stdout.trim() || null,
    head: head.stdout.trim(),
    upstream: upstream.exitCode === 0 ? upstream.stdout.trim() : null,
    dirty: changes.length > 0,
    changes,
    remotes: remotes.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((remote) => redactText(remote)),
    fingerprint: await gitFingerprint(repositoryPath),
  };
}

export async function compareRefs(
  repositoryPath: string,
  left: string,
  right: string,
): Promise<Record<string, unknown>> {
  const counts = await git(repositoryPath, [
    "rev-list",
    "--left-right",
    "--count",
    `${left}...${right}`,
  ]);
  const [leftOnly, rightOnly] = counts.stdout.trim().split(/\s+/).map(Number);
  const mergeBase = await git(repositoryPath, ["merge-base", left, right], true);
  const changes = await git(repositoryPath, ["diff", "--name-status", `${left}...${right}`], true);
  return {
    left,
    right,
    leftOnly: leftOnly ?? 0,
    rightOnly: rightOnly ?? 0,
    mergeBase: mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : null,
    changes: changes.stdout.split(/\r?\n/).filter(Boolean),
  };
}

interface SubmoduleRecord {
  name: string;
  path: string;
  url?: string;
  expectedCommit?: string;
  actualCommit?: string;
  dirty: boolean;
  initialized: boolean;
}

export async function inspectSubmodules(repositoryPath: string): Promise<SubmoduleRecord[]> {
  const modulesFile = path.join(repositoryPath, ".gitmodules");
  const source = await readFile(modulesFile, "utf8").catch(() => undefined);
  if (!source) return [];
  const records: SubmoduleRecord[] = [];
  const sections = [...source.matchAll(/\[submodule\s+"([^"]+)"\]([\s\S]*?)(?=\n\[|$)/g)];
  for (const section of sections) {
    const name = section[1] ?? "unknown";
    const body = section[2] ?? "";
    const relativePath = body.match(/^\s*path\s*=\s*(.+)$/m)?.[1]?.trim();
    if (!relativePath) continue;
    const url = body.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim();
    const absolute = await assertAllowedAbsolutePath(path.resolve(repositoryPath, relativePath), [
      repositoryPath,
    ]);
    const expected = await git(repositoryPath, ["ls-tree", "HEAD", relativePath], true);
    const expectedCommit = expected.stdout.trim().split(/\s+/)[2];
    const actual = await git(absolute, ["rev-parse", "HEAD"], true);
    const status = await git(absolute, ["status", "--porcelain"], true);
    records.push({
      name,
      path: relativePath,
      ...(url ? { url } : {}),
      ...(expectedCommit ? { expectedCommit } : {}),
      ...(actual.exitCode === 0 ? { actualCommit: actual.stdout.trim() } : {}),
      dirty: status.exitCode === 0 && status.stdout.trim().length > 0,
      initialized: actual.exitCode === 0,
    });
  }
  return records;
}

export async function inspectVendorLock(
  repositoryPath: string,
  lockFile = "vendor-lock.json",
): Promise<Record<string, unknown>> {
  const absolute = await assertAllowedAbsolutePath(path.resolve(repositoryPath, lockFile), [
    repositoryPath,
  ]);
  const source = await readFile(absolute, "utf8").catch(() => {
    throw new KkError("INVALID_ARGUMENT", `Vendor lock file not found: ${lockFile}`);
  });
  if (Buffer.byteLength(source) > 10_485_760) {
    throw new KkError("OUTPUT_LIMIT", `Vendor lock file exceeds 10 MiB: ${lockFile}`);
  }
  const parsed = JSON.parse(source) as Record<string, unknown>;
  return {
    path: lockFile,
    sha256: createHash("sha256").update(source).digest("hex"),
    schemaVersion: parsed.schemaVersion ?? null,
    generatedAt: parsed.generatedAt ?? null,
    vendors: parsed.vendors ?? {},
    components: parsed.components ?? {},
  };
}

export async function inspectSubtree(
  repositoryPath: string,
  prefix?: string,
): Promise<Record<string, unknown>> {
  const args = ["log", "--all", "--format=%H%x09%B", "--grep=git-subtree-dir:", "-n", "100"];
  const result = await git(repositoryPath, args, true);
  const entries = result.stdout.split(/\n(?=[0-9a-f]{40}\t)/).flatMap((record) => {
    const commit = record.match(/^([0-9a-f]{40})\t/)?.[1];
    const directory = record.match(/git-subtree-dir:\s*(.+)/)?.[1]?.trim();
    const split = record.match(/git-subtree-split:\s*([0-9a-f]+)/)?.[1];
    if (!commit || !directory || (prefix && directory !== prefix)) return [];
    return [{ commit, prefix: directory, split: split ?? null }];
  });
  return {
    supportedForApply: false,
    entries,
    recommendation:
      "Subtree updates are inspection-only in v0.1; perform a reviewed Git workflow outside this MCP.",
  };
}

export interface VendorSyncPayload {
  vendorId: string;
  repository: RepositoryRef;
  repositoryPath: string;
  vendorPath: string;
  lockPath: string;
  remote: string;
  currentRevision: string;
  targetRevision: string;
  previousLock: string;
  versionFile?: string;
}

export async function prepareVendorSync(
  vendor: VendorConfig,
  repositoryPath: string,
): Promise<{ payload: VendorSyncPayload; fingerprint: string; lock: Record<string, unknown> }> {
  await assertGitRepository(repositoryPath);
  const vendorPath = await assertAllowedAbsolutePath(path.resolve(repositoryPath, vendor.path), [
    repositoryPath,
  ]);
  const lockPath = await assertAllowedAbsolutePath(path.resolve(repositoryPath, vendor.lockFile), [
    repositoryPath,
  ]);
  const status = await git(vendorPath, ["status", "--porcelain"], true);
  if (status.exitCode !== 0) {
    throw new KkError("CONFLICT", `Vendor submodule is not initialized: ${vendor.path}`);
  }
  if (status.stdout.trim()) {
    throw new KkError("CONFLICT", `Vendor submodule is dirty: ${vendor.path}`);
  }
  const current = await git(vendorPath, ["rev-parse", "HEAD"]);
  const remote = await git(vendorPath, ["ls-remote", "--symref", vendor.remote, "HEAD"]);
  const targetRevision = remote.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^([0-9a-f]{40})\s+HEAD$/)?.[1])
    .find(Boolean);
  if (!targetRevision) throw new KkError("CONFLICT", `Cannot resolve ${vendor.remote}/HEAD`);
  const previousLock = await readFile(lockPath, "utf8");
  const lock = JSON.parse(previousLock) as Record<string, unknown>;
  const vendors = lock.vendors as Record<string, unknown> | undefined;
  if (!vendors?.[vendor.id]) {
    throw new KkError("CONFLICT", `vendor-lock does not contain vendors.${vendor.id}`);
  }
  return {
    payload: {
      vendorId: vendor.id,
      repository: vendor.repository,
      repositoryPath,
      vendorPath,
      lockPath,
      remote: vendor.remote,
      currentRevision: current.stdout.trim(),
      targetRevision,
      previousLock,
      ...(vendor.versionFile ? { versionFile: vendor.versionFile } : {}),
    },
    fingerprint: await gitFingerprint(repositoryPath),
    lock,
  };
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.kk-mcp-tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

export async function applyVendorSync(
  payload: VendorSyncPayload,
): Promise<Record<string, unknown>> {
  const current = await git(payload.vendorPath, ["rev-parse", "HEAD"]);
  if (current.stdout.trim() !== payload.currentRevision) {
    throw new KkError("STALE_PLAN", "Vendor revision changed after planning");
  }
  if (payload.currentRevision === payload.targetRevision) {
    return { changed: false, revision: payload.currentRevision };
  }
  try {
    await git(payload.vendorPath, [
      "fetch",
      "--depth",
      "1",
      payload.remote,
      payload.targetRevision,
    ]);
    await git(payload.vendorPath, ["checkout", "--detach", payload.targetRevision]);
    const lock = JSON.parse(payload.previousLock) as Record<string, unknown>;
    const vendors = lock.vendors as Record<string, Record<string, unknown>>;
    const entry = vendors[payload.vendorId];
    if (!entry) throw new KkError("CONFLICT", `Missing vendor lock entry: ${payload.vendorId}`);
    entry.revision = payload.targetRevision;
    entry.artifactSha256 = {};
    const versionPath = payload.versionFile
      ? await assertAllowedAbsolutePath(path.resolve(payload.vendorPath, payload.versionFile), [
          payload.vendorPath,
        ])
      : path.resolve(payload.vendorPath, "package.json");
    const version = await readFile(versionPath, "utf8")
      .then((source) => (JSON.parse(source) as { version?: string }).version)
      .catch(() => undefined);
    if (version) entry.version = version;
    lock.generatedAt = new Date().toISOString();
    await writeAtomic(payload.lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    return {
      changed: true,
      previousRevision: payload.currentRevision,
      revision: payload.targetRevision,
      version: version ?? null,
    };
  } catch (error) {
    await git(payload.vendorPath, ["checkout", "--detach", payload.currentRevision], true);
    await writeAtomic(payload.lockPath, payload.previousLock).catch(() => undefined);
    throw error;
  }
}

export async function commitScope(repositoryPath: string): Promise<{
  fingerprint: string;
  paths: string[];
  status: Array<{ code: string; path: string }>;
}> {
  const result = await git(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const status = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
  return {
    fingerprint: await gitFingerprint(repositoryPath),
    paths: status.map((entry) => entry.path),
    status,
  };
}
