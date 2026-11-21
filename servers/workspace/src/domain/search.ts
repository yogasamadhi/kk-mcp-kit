import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { commandExists, type KkConfig, runCommand } from "@kk-mcp-kit/core";

export interface SearchMatch {
  rootId: string;
  path: string;
  line: number;
  column: number;
  text: string;
}

async function searchWithRipgrep(
  config: KkConfig,
  query: string,
  rootIds: readonly string[],
): Promise<SearchMatch[]> {
  const roots = config.roots.filter((root) => rootIds.includes(root.id));
  const result = await runCommand(
    "rg",
    [
      "--json",
      "--fixed-strings",
      "--line-number",
      "--column",
      "--",
      query,
      ...roots.map((r) => r.path),
    ],
    {
      allowNonZero: true,
      timeoutMs: config.limits.defaultTimeoutMs,
      maxOutputBytes: config.limits.maxOutputBytes,
    },
  );
  const matches: SearchMatch[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const event = JSON.parse(line) as {
      type: string;
      data?: {
        path?: { text?: string };
        line_number?: number;
        submatches?: Array<{ start?: number }>;
        lines?: { text?: string };
      };
    };
    if (event.type !== "match" || !event.data?.path?.text) continue;
    const absolute = path.resolve(event.data.path.text);
    const root = roots.find((candidate) => {
      const relative = path.relative(candidate.path, absolute);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
    if (!root) continue;
    matches.push({
      rootId: root.id,
      path: path.relative(root.path, absolute).split(path.sep).join("/"),
      line: event.data.line_number ?? 1,
      column: (event.data.submatches?.[0]?.start ?? 0) + 1,
      text: event.data.lines?.text?.trimEnd() ?? "",
    });
    if (matches.length >= config.limits.maxItems) break;
  }
  return matches;
}

async function searchWithNode(
  config: KkConfig,
  query: string,
  rootIds: readonly string[],
): Promise<SearchMatch[]> {
  const ignored = new Set(config.servers.workspace.ignoredDirectories);
  const matches: SearchMatch[] = [];
  const maximumFileSize = 2 * 1024 * 1024;
  for (const root of config.roots.filter((candidate) => rootIds.includes(candidate.id))) {
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > root.maxDepth || matches.length >= config.limits.maxItems) return;
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (matches.length >= config.limits.maxItems) return;
        if (entry.name.startsWith(".") || ignored.has(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolute, depth + 1);
        } else if (entry.isFile()) {
          const info = await stat(absolute).catch(() => undefined);
          if (!info || info.size > maximumFileSize) continue;
          const buffer = await readFile(absolute).catch(() => undefined);
          if (!buffer || buffer.includes(0)) continue;
          const lines = buffer.toString("utf8").split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const column = lines[index]?.indexOf(query) ?? -1;
            if (column >= 0) {
              matches.push({
                rootId: root.id,
                path: path.relative(root.path, absolute).split(path.sep).join("/"),
                line: index + 1,
                column: column + 1,
                text: lines[index] ?? "",
              });
            }
          }
        }
      }
    };
    await visit(root.path, 0);
  }
  return matches;
}

export async function searchWorkspace(
  config: KkConfig,
  query: string,
  rootIds: readonly string[],
): Promise<{ backend: "ripgrep" | "node"; matches: SearchMatch[] }> {
  if (await commandExists("rg")) {
    return { backend: "ripgrep", matches: await searchWithRipgrep(config, query, rootIds) };
  }
  return { backend: "node", matches: await searchWithNode(config, query, rootIds) };
}
