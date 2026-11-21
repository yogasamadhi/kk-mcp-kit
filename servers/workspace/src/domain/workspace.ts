import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  assertAllowedAbsolutePath,
  type KkConfig,
  type RepositoryRef,
  readTextHead,
  redactText,
  runCommand,
} from "@kk-mcp-kit/core";
import { XMLParser } from "fast-xml-parser";
import { parse as parseToml } from "smol-toml";

export interface RepositorySummary extends RepositoryRef {
  id: string;
  name: string;
  absolutePath: string;
  manifests: string[];
  ecosystems: string[];
  branch?: string;
  dirty?: boolean;
}

const MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "pom.xml",
  "settings.gradle",
  "settings.gradle.kts",
];

function posixRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join("/") || ".";
}

async function exists(candidate: string): Promise<boolean> {
  return stat(candidate).then(
    () => true,
    () => false,
  );
}

async function inspectGit(directory: string): Promise<{ branch?: string; dirty?: boolean }> {
  const result = await runCommand(
    "git",
    ["-C", directory, "status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
    { allowNonZero: true, timeoutMs: 10_000 },
  ).catch(() => undefined);
  if (result?.exitCode !== 0) return {};
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const header = lines[0]?.replace(/^##\s*/, "") ?? "";
  const branch = header.split("...")[0]?.trim() || undefined;
  return { ...(branch ? { branch } : {}), dirty: lines.length > 1 };
}

export async function summarizeRepository(
  rootId: string,
  rootPath: string,
  directory: string,
): Promise<RepositorySummary> {
  const manifests: string[] = [];
  for (const manifest of MANIFESTS) {
    if (await exists(path.join(directory, manifest))) manifests.push(manifest);
  }
  const ecosystemByManifest: Record<string, string> = {
    "package.json": "javascript",
    "Cargo.toml": "rust",
    "go.mod": "go",
    "pyproject.toml": "python",
    "pom.xml": "maven",
    "settings.gradle": "gradle",
    "settings.gradle.kts": "gradle",
  };
  const git = await inspectGit(directory);
  const relativePath = posixRelative(rootPath, directory);
  return {
    id: `${rootId}:${relativePath}`,
    rootId,
    relativePath,
    name: path.basename(directory),
    absolutePath: directory,
    manifests,
    ecosystems: [
      ...new Set(manifests.map((manifest) => ecosystemByManifest[manifest] ?? "unknown")),
    ],
    ...git,
  };
}

export async function discoverRepositories(
  config: KkConfig,
  selectedRootIds?: readonly string[],
): Promise<RepositorySummary[]> {
  const ignored = new Set(config.servers.workspace.ignoredDirectories);
  const repositories: RepositorySummary[] = [];
  for (const root of config.roots) {
    if (selectedRootIds && !selectedRootIds.includes(root.id)) continue;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > root.maxDepth || repositories.length >= config.limits.maxItems) return;
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      const isRepository = entries.some((entry) => entry.name === ".git");
      if (isRepository) {
        repositories.push(await summarizeRepository(root.id, root.path, directory));
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || ignored.has(entry.name) || entry.name.startsWith(".")) continue;
        await visit(path.join(directory, entry.name), depth + 1);
      }
    };
    await visit(root.path, 0);
  }
  return repositories.sort((left, right) => left.id.localeCompare(right.id));
}

export async function projectInstructions(
  repositoryPath: string,
): Promise<Array<{ path: string; size: number; content: string; truncated: boolean }>> {
  const candidates = [
    "AGENTS.md",
    "README.md",
    "CLAUDE.md",
    path.join("docs", "README.md"),
    path.join(".github", "copilot-instructions.md"),
  ];
  const records: Array<{ path: string; size: number; content: string; truncated: boolean }> = [];
  for (const candidate of candidates) {
    const absolute = await assertAllowedAbsolutePath(path.join(repositoryPath, candidate), [
      repositoryPath,
    ]).catch(() => undefined);
    if (!absolute) continue;
    const source = await readTextHead(absolute, 32_768).catch(() => undefined);
    if (!source) continue;
    records.push({
      path: candidate.split(path.sep).join("/"),
      size: source.size,
      content: source.text,
      truncated: source.truncated,
    });
  }
  return records;
}

export async function inspectRepository(
  repository: RepositorySummary,
): Promise<Record<string, unknown>> {
  const statusResult = await runCommand(
    "git",
    ["-C", repository.absolutePath, "status", "--short", "--branch"],
    { allowNonZero: true },
  ).catch(() => undefined);
  const remoteResult = await runCommand("git", ["-C", repository.absolutePath, "remote", "-v"], {
    allowNonZero: true,
  }).catch(() => undefined);
  const packagePath = await assertAllowedAbsolutePath(
    path.join(repository.absolutePath, "package.json"),
    [repository.absolutePath],
  ).catch(() => undefined);
  const packageJson = packagePath
    ? await readTextHead(packagePath, 2_097_152)
        .then((source) =>
          source.truncated ? undefined : (JSON.parse(source.text) as Record<string, unknown>),
        )
        .catch(() => undefined)
    : undefined;
  return {
    ...repository,
    package: packageJson
      ? {
          name: packageJson.name,
          version: packageJson.version,
          packageManager: packageJson.packageManager,
          workspaces: packageJson.workspaces,
          scripts: packageJson.scripts,
        }
      : undefined,
    git: {
      status: statusResult?.stdout.trim() ?? null,
      remotes:
        remoteResult?.stdout
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((remote) => redactText(remote)) ?? [],
    },
    instructions: await projectInstructions(repository.absolutePath),
  };
}

interface GraphNode {
  id: string;
  ecosystem: string;
  name: string;
  manifest: string;
  dependencies: string[];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

async function manifestNode(repository: RepositorySummary, manifest: string): Promise<GraphNode> {
  const absolute = await assertAllowedAbsolutePath(path.join(repository.absolutePath, manifest), [
    repository.absolutePath,
  ]);
  const bounded = await readTextHead(absolute, 4_194_304);
  if (bounded.truncated) throw new Error(`Manifest exceeds 4 MiB: ${manifest}`);
  const source = bounded.text;
  if (manifest === "package.json") {
    const json = JSON.parse(source) as Record<string, unknown>;
    const dependencyMaps = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ];
    const dependencies = dependencyMaps.flatMap((key) =>
      Object.keys((json[key] as Record<string, string> | undefined) ?? {}),
    );
    return {
      id: `${repository.id}:npm`,
      ecosystem: "javascript",
      name: typeof json.name === "string" ? json.name : repository.name,
      manifest,
      dependencies: [...new Set(dependencies)].sort(),
    };
  }
  if (manifest === "Cargo.toml" || manifest === "pyproject.toml") {
    const toml = parseToml(source) as Record<string, unknown>;
    if (manifest === "Cargo.toml") {
      const pkg = (toml.package as Record<string, unknown> | undefined) ?? {};
      const dependencies = Object.keys(
        (toml.dependencies as Record<string, unknown> | undefined) ?? {},
      );
      return {
        id: `${repository.id}:cargo`,
        ecosystem: "rust",
        name: typeof pkg.name === "string" ? pkg.name : repository.name,
        manifest,
        dependencies,
      };
    }
    const project = (toml.project as Record<string, unknown> | undefined) ?? {};
    return {
      id: `${repository.id}:python`,
      ecosystem: "python",
      name: typeof project.name === "string" ? project.name : repository.name,
      manifest,
      dependencies: arrayValue(project.dependencies).map(String),
    };
  }
  if (manifest === "go.mod") {
    const moduleName = source.match(/^module\s+(.+)$/m)?.[1]?.trim() ?? repository.name;
    const dependencies = [...source.matchAll(/^\s*([^\s()]+)\s+v[^\s]+/gm)].map(
      (match) => match[1] ?? "",
    );
    return {
      id: `${repository.id}:go`,
      ecosystem: "go",
      name: moduleName,
      manifest,
      dependencies: dependencies.filter(Boolean),
    };
  }
  if (manifest === "pom.xml") {
    const xml = new XMLParser({ ignoreAttributes: false }).parse(source) as Record<string, unknown>;
    const project = (xml.project as Record<string, unknown> | undefined) ?? {};
    const dependencyContainer = (project.dependencies as Record<string, unknown> | undefined) ?? {};
    const dependencies = arrayValue(dependencyContainer.dependency).map((dependency) => {
      const record = dependency as Record<string, unknown>;
      return `${String(record.groupId ?? "")}:${String(record.artifactId ?? "")}`;
    });
    return {
      id: `${repository.id}:maven`,
      ecosystem: "maven",
      name: String(project.artifactId ?? repository.name),
      manifest,
      dependencies,
    };
  }
  const projects = [...source.matchAll(/project\(["'](:[^"']+)["']\)/g)].map(
    (match) => match[1] ?? "",
  );
  return {
    id: `${repository.id}:gradle`,
    ecosystem: "gradle",
    name: repository.name,
    manifest,
    dependencies: projects.filter(Boolean),
  };
}

export async function dependencyGraph(repositories: readonly RepositorySummary[]): Promise<{
  nodes: GraphNode[];
  edges: Array<{ from: string; to: string; dependency: string }>;
}> {
  const nodes: GraphNode[] = [];
  for (const repository of repositories) {
    for (const manifest of repository.manifests) {
      nodes.push(await manifestNode(repository, manifest));
    }
  }
  const byName = new Map(nodes.map((node) => [node.name, node.id]));
  const edges = nodes.flatMap((node) =>
    node.dependencies.flatMap((dependency) => {
      const target = byName.get(dependency.replace(/^workspace:/, ""));
      return target ? [{ from: node.id, to: target, dependency }] : [];
    }),
  );
  return { nodes, edges };
}
