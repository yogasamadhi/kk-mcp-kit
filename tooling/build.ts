import { rm } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const packageDirectories = [
  "packages/core",
  "packages/testkit",
  "servers/workspace",
  "servers/git-guardian",
  "servers/runtime-observer",
  "servers/project-memory",
  "servers/build-evidence",
  "servers/desktop-lab",
  "servers/network-forensics",
];

for (const packageDirectory of packageDirectories) {
  const packageRoot = path.join(repositoryRoot, packageDirectory);
  const outdir = path.join(packageRoot, "dist");
  await rm(outdir, { recursive: true, force: true });

  const entrypoints = packageDirectory.startsWith("servers/")
    ? [path.join(packageRoot, "src/cli.ts"), path.join(packageRoot, "src/index.ts")]
    : [path.join(packageRoot, "src/index.ts")];

  const result = await Bun.build({
    entrypoints,
    outdir,
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    naming: "[name].mjs",
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Failed to build ${packageDirectory}`);
  }
}

console.error(`Built ${packageDirectories.length} workspace packages.`);
