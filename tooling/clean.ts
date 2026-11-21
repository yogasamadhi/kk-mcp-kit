import { rm } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
for (const relativePath of [
  ".types",
  "packages/core/dist",
  "packages/testkit/dist",
  "servers/workspace/dist",
  "servers/git-guardian/dist",
  "servers/runtime-observer/dist",
  "servers/project-memory/dist",
  "servers/build-evidence/dist",
  "servers/desktop-lab/dist",
  "servers/network-forensics/dist",
]) {
  await rm(path.join(repositoryRoot, relativePath), { recursive: true, force: true });
}
