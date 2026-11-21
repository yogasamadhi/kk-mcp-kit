import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { KkConfig, RootConfig } from "./config.js";
import { KkError } from "./errors.js";
import type { RepositoryRef } from "./types.js";

function normalized(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(normalized(root), normalized(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function nearestExisting(candidate: string): Promise<{ existing: string; tail: string[] }> {
  const tail: string[] = [];
  let cursor = candidate;
  while (true) {
    try {
      await stat(cursor);
      return { existing: cursor, tail };
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor)
        throw new KkError("PATH_OUTSIDE_ROOT", `Path does not exist: ${candidate}`);
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function rootById(config: KkConfig, rootId: string): RootConfig {
  const root = config.roots.find((candidate) => candidate.id === rootId);
  if (!root) throw new KkError("INVALID_ARGUMENT", `Unknown rootId: ${rootId}`);
  return root;
}

export async function resolveWithinRoot(
  config: KkConfig,
  rootId: string,
  relativePath: string,
): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new KkError("PATH_OUTSIDE_ROOT", "relativePath must not be absolute");
  }
  const root = rootById(config, rootId);
  const rootReal = await realpath(root.path).catch(() => {
    throw new KkError("CONFIG_ERROR", `Configured root does not exist: ${root.path}`);
  });
  const lexical = path.resolve(rootReal, relativePath || ".");
  if (!contains(rootReal, lexical)) {
    throw new KkError("PATH_OUTSIDE_ROOT", `${relativePath} escapes root ${rootId}`);
  }
  const { existing, tail } = await nearestExisting(lexical);
  const existingReal = await realpath(existing);
  if (!contains(rootReal, existingReal)) {
    throw new KkError("PATH_OUTSIDE_ROOT", `${relativePath} resolves outside root ${rootId}`);
  }
  return path.join(existingReal, ...tail);
}

export async function resolveRepository(
  config: KkConfig,
  reference: RepositoryRef,
): Promise<string> {
  return resolveWithinRoot(config, reference.rootId, reference.relativePath);
}

export async function assertAllowedAbsolutePath(
  candidate: string,
  allowedRoots: readonly string[],
): Promise<string> {
  if (!path.isAbsolute(candidate)) throw new KkError("INVALID_ARGUMENT", "Path must be absolute");
  const { existing, tail } = await nearestExisting(path.resolve(candidate));
  const real = path.join(await realpath(existing), ...tail);
  for (const allowed of allowedRoots) {
    const allowedReal = await realpath(allowed).catch(() => path.resolve(allowed));
    if (contains(allowedReal, real)) return real;
  }
  throw new KkError("PATH_OUTSIDE_ROOT", `Path is not in an allowed root: ${candidate}`);
}
