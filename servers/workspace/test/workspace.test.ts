import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, runCommand } from "@kk-mcp-kit/core";
import { dependencyGraph, discoverRepositories } from "../src/domain/workspace.js";

test("discovers repositories and links local JavaScript dependencies", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kk-mcp-workspace-test-"));
  try {
    const root = path.join(directory, "projects");
    await mkdir(root);
    for (const [name, dependencies] of [
      ["alpha", { beta: "workspace:*" }],
      ["beta", {}],
    ] as const) {
      const repository = path.join(root, name);
      await mkdir(repository);
      await runCommand("git", ["-C", repository, "init"]);
      await writeFile(
        path.join(repository, "package.json"),
        JSON.stringify({ name, version: "1.0.0", dependencies }),
      );
    }
    const configPath = path.join(directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        stateDir: path.join(directory, "state"),
        roots: [{ id: "projects", path: root }],
      }),
    );
    const config = await loadConfig(configPath);
    const repositories = await discoverRepositories(config);
    expect(repositories).toHaveLength(2);
    const graph = await dependencyGraph(repositories);
    expect(graph.edges).toEqual([
      {
        from: "projects:alpha:npm",
        to: "projects:beta:npm",
        dependency: "beta",
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
