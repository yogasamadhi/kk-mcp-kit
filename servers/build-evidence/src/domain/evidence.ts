import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ArtifactRecord,
  type ArtifactStore,
  assertAllowedAbsolutePath,
  commandExists,
  type KkConfig,
  KkError,
  readTextHead,
  redactText,
  repositoryStateFingerprint,
  runCommand,
  type VerificationProfile,
} from "@kk-mcp-kit/core";
import { XMLParser } from "fast-xml-parser";

export interface TestFailure {
  name: string;
  file?: string;
  line?: number;
  message: string;
}

export interface VerificationRun {
  id: string;
  profileId: string;
  repositoryRootId: string;
  repositoryRelativePath: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  status: "passed" | "failed";
  stdout: string;
  stderr: string;
  truncated: boolean;
  failures: TestFailure[];
  artifacts: ArtifactRecord[];
}

function many<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function parseJUnit(source: string): TestFailure[] {
  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(
    source,
  ) as {
    testsuite?: unknown;
    testsuites?: { testsuite?: unknown };
  };
  const suites = many(xml.testsuite ?? xml.testsuites?.testsuite) as Array<Record<string, unknown>>;
  const failures: TestFailure[] = [];
  for (const suite of suites) {
    for (const test of many(suite.testcase) as Array<Record<string, unknown>>) {
      const failure = test.failure ?? test.error;
      if (!failure) continue;
      const record = typeof failure === "object" ? (failure as Record<string, unknown>) : {};
      failures.push({
        name: `${String(test["@_classname"] ?? "")}${test["@_classname"] ? "." : ""}${String(test["@_name"] ?? "unknown")}`,
        ...(test["@_file"] ? { file: String(test["@_file"]) } : {}),
        ...(test["@_line"] ? { line: Number(test["@_line"]) } : {}),
        message: String(record["@_message"] ?? record["#text"] ?? failure),
      });
    }
  }
  return failures;
}

function parseGoJson(source: string): TestFailure[] {
  return source.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const event = JSON.parse(line) as {
        Action?: string;
        Test?: string;
        Package?: string;
        Output?: string;
      };
      if (event.Action !== "fail" || !event.Test) return [];
      return [
        {
          name: `${event.Package ?? "go"}:${event.Test}`,
          message: event.Output?.trim() || "Go test failed",
        },
      ];
    } catch {
      return [];
    }
  });
}

function parseCargo(source: string): TestFailure[] {
  return source.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^test\s+(.+?)\s+\.\.\.\s+FAILED$/);
    return match?.[1] ? [{ name: match[1], message: "Rust test failed" }] : [];
  });
}

function parseGeneric(stdout: string, stderr: string): TestFailure[] {
  return `${stdout}\n${stderr}`.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(.*?):(\d+)(?::\d+)?:\s*(?:error|fail(?:ed)?):?\s*(.+)$/i);
    if (!match) return [];
    return [
      {
        name: path.basename(match[1] ?? "failure"),
        file: match[1] ?? "",
        line: Number(match[2]),
        message: match[3] ?? line,
      },
    ];
  });
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "_value" in value) {
    const nested = (value as { _value?: unknown })._value;
    return typeof nested === "string" ? nested : undefined;
  }
  return undefined;
}

export function parseXcResult(source: string): TestFailure[] {
  const root = JSON.parse(source) as unknown;
  const failures = new Map<string, TestFailure>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const status = scalar(record.testStatus) ?? scalar(record.status);
    if (status && /fail/i.test(status)) {
      const name =
        scalar(record.name) ??
        scalar(record.identifier) ??
        scalar(record.testIdentifier) ??
        "unknown";
      const summaries = record.failureSummaries as
        | { _values?: Array<Record<string, unknown>> }
        | Array<Record<string, unknown>>
        | undefined;
      const rows = Array.isArray(summaries) ? summaries : (summaries?._values ?? []);
      const message =
        rows
          .map((summary) => scalar(summary.message) ?? scalar(summary.text))
          .filter((item): item is string => Boolean(item))
          .join("\n") || "XCTest failed";
      failures.set(name, { name, message });
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(root);
  return [...failures.values()];
}

function globRegex(pattern: string): RegExp {
  const normalized = pattern.split(path.sep).join("/");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&") ?? "";
  }
  return new RegExp(`${source}$`);
}

async function matchedFiles(
  root: string,
  patterns: readonly string[],
  maximum: number,
): Promise<string[]> {
  if (patterns.length === 0) return [];
  const regexes = patterns.map(globRegex);
  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 16 || files.length >= maximum) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if ([".git", "node_modules", ".types"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, depth + 1);
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (regexes.some((regex) => regex.test(relative))) files.push(absolute);
      }
    }
  };
  await visit(root, 0);
  return files;
}

function mimeFor(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return (
    {
      ".json": "application/json",
      ".xml": "application/xml",
      ".txt": "text/plain",
      ".log": "text/plain",
      ".html": "text/html",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
    }[extension] ?? "application/octet-stream"
  );
}

export class EvidenceDatabase {
  readonly #database: DatabaseSync;

  constructor(config: KkConfig) {
    const directory = path.join(config.stateDir, "build-evidence");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(path.join(directory, "evidence.sqlite"));
    this.#database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS verification_runs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        repository_root_id TEXT NOT NULL,
        repository_relative_path TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        exit_code INTEGER NOT NULL,
        status TEXT NOT NULL,
        stdout TEXT NOT NULL,
        stderr TEXT NOT NULL,
        truncated INTEGER NOT NULL,
        failures_json TEXT NOT NULL,
        artifacts_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS verification_profile_idx
        ON verification_runs(profile_id, started_at DESC);
    `);
  }

  insert(run: VerificationRun): void {
    this.#database
      .prepare(`INSERT INTO verification_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        run.id,
        run.profileId,
        run.repositoryRootId,
        run.repositoryRelativePath,
        run.startedAt,
        run.finishedAt,
        run.durationMs,
        run.exitCode,
        run.status,
        run.stdout,
        run.stderr,
        run.truncated ? 1 : 0,
        JSON.stringify(run.failures),
        JSON.stringify(run.artifacts),
      );
  }

  get(runId: string): VerificationRun {
    const row = this.#database.prepare("SELECT * FROM verification_runs WHERE id = ?").get(runId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new KkError("INVALID_ARGUMENT", `Unknown runId: ${runId}`);
    return this.#row(row);
  }

  listArtifacts(runId?: string): ArtifactRecord[] {
    if (runId) return this.get(runId).artifacts;
    const rows = this.#database
      .prepare("SELECT artifacts_json FROM verification_runs ORDER BY started_at DESC LIMIT 100")
      .all() as Array<{ artifacts_json: string }>;
    return rows.flatMap((row) => JSON.parse(row.artifacts_json) as ArtifactRecord[]);
  }

  compare(leftRunId: string, rightRunId: string): Record<string, unknown> {
    const left = this.get(leftRunId);
    const right = this.get(rightRunId);
    return {
      left: {
        id: left.id,
        status: left.status,
        durationMs: left.durationMs,
        failures: left.failures.length,
      },
      right: {
        id: right.id,
        status: right.status,
        durationMs: right.durationMs,
        failures: right.failures.length,
      },
      durationDeltaMs: right.durationMs - left.durationMs,
      newlyFailing: right.failures.filter(
        (failure) => !left.failures.some((candidate) => candidate.name === failure.name),
      ),
      fixed: left.failures.filter(
        (failure) => !right.failures.some((candidate) => candidate.name === failure.name),
      ),
    };
  }

  #row(row: Record<string, unknown>): VerificationRun {
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      repositoryRootId: String(row.repository_root_id),
      repositoryRelativePath: String(row.repository_relative_path),
      startedAt: String(row.started_at),
      finishedAt: String(row.finished_at),
      durationMs: Number(row.duration_ms),
      exitCode: Number(row.exit_code),
      status: String(row.status) as "passed" | "failed",
      stdout: String(row.stdout),
      stderr: String(row.stderr),
      truncated: Boolean(row.truncated),
      failures: JSON.parse(String(row.failures_json)) as TestFailure[],
      artifacts: JSON.parse(String(row.artifacts_json)) as ArtifactRecord[],
    };
  }
}

export async function verificationFingerprint(
  profile: VerificationProfile,
  repositoryPath: string,
): Promise<string> {
  return createHash("sha256")
    .update(JSON.stringify(profile))
    .update("\0")
    .update(await repositoryStateFingerprint(repositoryPath))
    .digest("hex");
}

export async function runVerification(
  config: KkConfig,
  profile: VerificationProfile,
  repositoryPath: string,
  database: EvidenceDatabase,
  artifactStore: ArtifactStore,
): Promise<VerificationRun> {
  if (profile.parser === "xcresult" && process.platform !== "darwin") {
    throw new KkError("UNSUPPORTED_PLATFORM", "XCResult collection is only available on macOS");
  }
  if (profile.parser === "xcresult" && !(await commandExists("xcrun"))) {
    throw new KkError("UNSUPPORTED_BACKEND", "xcrun is required for XCResult parsing");
  }
  const startedAt = new Date();
  const result = await runCommand(profile.command, profile.args, {
    cwd: repositoryPath,
    timeoutMs: profile.timeoutMs,
    maxOutputBytes: config.limits.maxOutputBytes,
    environmentAllowlist: profile.environmentAllowlist,
    allowNonZero: true,
  });
  const stdout = redactText(result.stdout, config.audit.redactionPatterns);
  const stderr = redactText(result.stderr, config.audit.redactionPatterns);
  let failures =
    profile.parser === "go-json"
      ? parseGoJson(stdout)
      : profile.parser === "cargo"
        ? parseCargo(`${stdout}\n${stderr}`)
        : parseGeneric(stdout, stderr);
  if (profile.parser === "junit") {
    failures = [];
    for (const resultPath of profile.resultPaths) {
      const absolute = await assertAllowedAbsolutePath(path.resolve(repositoryPath, resultPath), [
        repositoryPath,
      ]);
      const source = await readTextHead(absolute, config.limits.maxOutputBytes).catch(
        () => undefined,
      );
      if (source?.truncated) {
        throw new KkError("OUTPUT_LIMIT", `JUnit result exceeded maxOutputBytes: ${resultPath}`);
      }
      if (source) failures.push(...parseJUnit(source.text));
    }
  }
  if (profile.parser === "xcresult") {
    failures = [];
    for (const resultPath of profile.resultPaths) {
      const absolute = await assertAllowedAbsolutePath(path.resolve(repositoryPath, resultPath), [
        repositoryPath,
      ]);
      let source: string | undefined;
      if (resultPath.endsWith(".json")) {
        const bounded = await readTextHead(absolute, config.limits.maxOutputBytes).catch(
          () => undefined,
        );
        if (bounded?.truncated) {
          throw new KkError("OUTPUT_LIMIT", `XCResult JSON exceeded maxOutputBytes: ${resultPath}`);
        }
        source = bounded?.text;
      } else {
        let parsed = await runCommand(
          "xcrun",
          ["xcresulttool", "get", "test-results", "tests", "--path", absolute, "--format", "json"],
          {
            allowNonZero: true,
            timeoutMs: Math.min(profile.timeoutMs, 120_000),
            maxOutputBytes: config.limits.maxOutputBytes,
          },
        );
        if (parsed.exitCode !== 0) {
          parsed = await runCommand(
            "xcrun",
            ["xcresulttool", "get", "--path", absolute, "--format", "json", "--legacy"],
            {
              allowNonZero: true,
              timeoutMs: Math.min(profile.timeoutMs, 120_000),
              maxOutputBytes: config.limits.maxOutputBytes,
            },
          );
        }
        if (parsed.exitCode !== 0) {
          throw new KkError("CONFLICT", `xcresulttool could not parse ${resultPath}`, {
            details: { stderr: redactText(parsed.stderr, config.audit.redactionPatterns) },
          });
        }
        if (parsed.truncated) {
          throw new KkError("OUTPUT_LIMIT", `XCResult JSON exceeded maxOutputBytes: ${resultPath}`);
        }
        source = parsed.stdout;
      }
      if (source) failures.push(...parseXcResult(source));
    }
  }

  const artifacts: ArtifactRecord[] = [];
  for (const file of await matchedFiles(
    repositoryPath,
    [...profile.artifactGlobs, ...profile.resultPaths],
    config.limits.maxItems,
  )) {
    const fileStat = await stat(file).catch(() => undefined);
    if (!fileStat || fileStat.size > config.limits.maxArtifactBytes) continue;
    const data = await readFile(file);
    artifacts.push(
      await artifactStore.put(data, path.extname(file).slice(1) || "bin", mimeFor(file)),
    );
  }

  const finishedAt = new Date();
  const run: VerificationRun = {
    id: randomUUID(),
    profileId: profile.id,
    repositoryRootId: profile.repository.rootId,
    repositoryRelativePath: profile.repository.relativePath,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    status: result.exitCode === 0 && failures.length === 0 ? "passed" : "failed",
    stdout,
    stderr,
    truncated: result.truncated,
    failures,
    artifacts,
  };
  database.insert(run);
  return run;
}

export async function detectFrameworks(repositoryPath: string): Promise<string[]> {
  const files: string[] = await readdir(repositoryPath).catch(() => [] as string[]);
  const frameworks = new Set<string>();
  const packageSource = await readFile(path.join(repositoryPath, "package.json"), "utf8").catch(
    () => undefined,
  );
  if (packageSource) {
    const json = JSON.parse(packageSource) as Record<string, unknown>;
    const dependencies = JSON.stringify({
      dependencies: json.dependencies,
      devDependencies: json.devDependencies,
    });
    if (dependencies.includes("vitest")) frameworks.add("vitest");
    if (dependencies.includes("jest")) frameworks.add("jest");
  }
  if (files.includes("pyproject.toml") || files.includes("pytest.ini")) frameworks.add("pytest");
  if (files.includes("go.mod")) frameworks.add("go-test");
  if (files.includes("Cargo.toml")) frameworks.add("cargo-test");
  if (files.includes("pom.xml")) frameworks.add("maven");
  if (files.some((file) => file.startsWith("build.gradle"))) frameworks.add("gradle");
  if (files.some((file) => file.endsWith(".xcodeproj") || file.endsWith(".xcworkspace"))) {
    frameworks.add("xctest");
  }
  return [...frameworks].sort();
}
