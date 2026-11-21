import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./process.js";

async function hashPath(
  hasher: ReturnType<typeof createHash>,
  repositoryPath: string,
  file: string,
): Promise<void> {
  const absolute = path.resolve(repositoryPath, file);
  const relative = path.relative(repositoryPath, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    hasher.update("outside-root");
    return;
  }
  const info = await lstat(absolute).catch(() => undefined);
  if (!info) {
    hasher.update("missing");
    return;
  }
  if (info.isSymbolicLink()) {
    hasher.update("symlink\0").update(await readlink(absolute));
    return;
  }
  if (info.isFile()) {
    hasher.update(`file\0${info.size}\0`);
    if (info.size > 16_777_216) {
      hasher.update(`large\0${info.mtimeMs}`);
      return;
    }
    for await (const chunk of createReadStream(absolute)) hasher.update(chunk);
    return;
  }
  if (info.isDirectory()) {
    const head = await runCommand("git", ["-C", absolute, "rev-parse", "HEAD"], {
      allowNonZero: true,
      timeoutMs: 10_000,
    }).catch(() => undefined);
    hasher.update(`directory\0${head?.stdout ?? "not-git"}`);
    return;
  }
  hasher.update(`special\0${info.mode}\0${info.size}`);
}

async function hashDirectoryState(
  hasher: ReturnType<typeof createHash>,
  repositoryPath: string,
): Promise<void> {
  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 16 || files.length >= 5_000) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if ([".git", ".types", "node_modules"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, depth + 1);
      else files.push(path.relative(repositoryPath, absolute));
      if (files.length >= 5_000) break;
    }
  };
  await visit(repositoryPath, 0);
  for (const file of files.sort()) {
    hasher.update("\0").update(file).update("\0");
    await hashPath(hasher, repositoryPath, file);
  }
  if (files.length >= 5_000) hasher.update("\0item-limit");
}

function changedPaths(status: string): string[] {
  const entries = status.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) index += 1;
  }
  return [...new Set(files)].sort();
}

export async function repositoryStateFingerprint(repositoryPath: string): Promise<string> {
  const [head, status] = await Promise.all([
    runCommand("git", ["-C", repositoryPath, "rev-parse", "HEAD"], {
      allowNonZero: true,
      timeoutMs: 10_000,
    }).catch(() => undefined),
    runCommand(
      "git",
      ["-C", repositoryPath, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { allowNonZero: true, timeoutMs: 10_000, maxOutputBytes: 4_194_304 },
    ).catch(() => undefined),
  ]);
  const hasher = createHash("sha256")
    .update(head?.stdout ?? "not-git")
    .update("\0")
    .update(status?.stdout ?? "not-git");
  if (head?.exitCode !== 0 || status?.exitCode !== 0 || status?.truncated) {
    await hashDirectoryState(hasher, repositoryPath);
    return hasher.digest("hex");
  }
  for (const file of changedPaths(status?.stdout ?? "")) {
    hasher.update("\0").update(file).update("\0");
    await hashPath(hasher, repositoryPath, file);
  }
  return hasher.digest("hex");
}
