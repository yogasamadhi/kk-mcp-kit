import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const serverNames = [
  "workspace",
  "git-guardian",
  "runtime-observer",
  "project-memory",
  "build-evidence",
  "desktop-lab",
  "network-forensics",
];
const roots = [
  path.join(repositoryRoot, "packages/core/src"),
  ...serverNames.map((server) => path.join(repositoryRoot, "servers", server, "src")),
];
const violations: string[] = [];

async function visit(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "dist") await visit(child);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const source = await readFile(child, "utf8");
    const checks = [
      [/\bBun\s*\./, "Bun global"],
      [/from\s+["']bun(?::|["'])/, "bun import"],
      [/console\.log\s*\(/, "console.log"],
    ] as const;
    for (const [pattern, label] of checks) {
      if (pattern.test(source))
        violations.push(`${path.relative(repositoryRoot, child)}: ${label}`);
    }
  }
}

for (const root of roots) await visit(root);
if (violations.length > 0) {
  throw new Error(`Runtime portability violations:\n${violations.join("\n")}`);
}

console.error("Runtime sources contain no Bun-only APIs or stdout logging.");
