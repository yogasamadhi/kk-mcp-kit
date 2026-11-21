import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type KkConfig, KkError, type RepositoryRef, redactText } from "@kk-mcp-kit/core";

export type MemoryKind = "decision" | "incident" | "verification" | "note" | "conversation";

export interface MemoryDraft {
  kind: MemoryKind;
  title: string;
  body: string;
  repository?: RepositoryRef;
  tags: string[];
  sources: string[];
}

export interface MemoryRecord extends MemoryDraft {
  id: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

function hashDraft(draft: MemoryDraft): string {
  return createHash("sha256")
    .update(draft.kind)
    .update("\0")
    .update(draft.title)
    .update("\0")
    .update(draft.body)
    .update("\0")
    .update(JSON.stringify(draft.repository ?? null))
    .digest("hex");
}

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  const rootId = row.repository_root_id ? String(row.repository_root_id) : undefined;
  const relativePath = row.repository_relative_path
    ? String(row.repository_relative_path)
    : undefined;
  return {
    id: String(row.id),
    kind: String(row.kind) as MemoryKind,
    title: String(row.title),
    body: String(row.body),
    ...(rootId && relativePath ? { repository: { rootId, relativePath } } : {}),
    tags: JSON.parse(String(row.tags_json ?? "[]")) as string[],
    sources: JSON.parse(String(row.sources_json ?? "[]")) as string[],
    contentHash: String(row.content_hash),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class MemoryDatabase {
  readonly #database: DatabaseSync;

  constructor(config: KkConfig) {
    const directory = path.join(config.stateDir, "project-memory");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(path.join(directory, "memory.sqlite"));
    this.#database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        repository_root_id TEXT,
        repository_relative_path TEXT,
        tags_json TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_repository_idx
        ON memories(repository_root_id, repository_relative_path, created_at DESC);
      CREATE INDEX IF NOT EXISTS memories_kind_idx ON memories(kind, created_at DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        title, body, tags, content='memories', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, body, tags)
        VALUES (new.rowid, new.title, new.body, new.tags_json);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, body, tags)
        VALUES ('delete', old.rowid, old.title, old.body, old.tags_json);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, body, tags)
        VALUES ('delete', old.rowid, old.title, old.body, old.tags_json);
        INSERT INTO memories_fts(rowid, title, body, tags)
        VALUES (new.rowid, new.title, new.body, new.tags_json);
      END;
    `);
  }

  hasHash(contentHash: string): boolean {
    return Boolean(
      this.#database
        .prepare("SELECT 1 AS found FROM memories WHERE content_hash = ?")
        .get(contentHash),
    );
  }

  insert(draft: MemoryDraft): MemoryRecord {
    const contentHash = hashDraft(draft);
    const existing = this.#database
      .prepare("SELECT * FROM memories WHERE content_hash = ?")
      .get(contentHash) as Record<string, unknown> | undefined;
    if (existing) return rowToRecord(existing);
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      ...draft,
      id: randomUUID(),
      contentHash,
      createdAt: now,
      updatedAt: now,
    };
    this.#database
      .prepare(
        `INSERT INTO memories(
          id, kind, title, body, repository_root_id, repository_relative_path,
          tags_json, sources_json, content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.kind,
        record.title,
        record.body,
        record.repository?.rootId ?? null,
        record.repository?.relativePath ?? null,
        JSON.stringify(record.tags),
        JSON.stringify(record.sources),
        record.contentHash,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  link(memoryId: string, repository: RepositoryRef): MemoryRecord {
    const existing = this.#database.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId) as
      | Record<string, unknown>
      | undefined;
    if (!existing) throw new KkError("INVALID_ARGUMENT", `Unknown memoryId: ${memoryId}`);
    const record = rowToRecord(existing);
    const contentHash = hashDraft({ ...record, repository });
    try {
      this.#database
        .prepare(
          "UPDATE memories SET repository_root_id = ?, repository_relative_path = ?, content_hash = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          repository.rootId,
          repository.relativePath,
          contentHash,
          new Date().toISOString(),
          memoryId,
        );
    } catch (error) {
      throw new KkError("CONFLICT", "Link would duplicate an existing memory record", {
        cause: error,
      });
    }
    return rowToRecord(
      this.#database.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId) as Record<
        string,
        unknown
      >,
    );
  }

  search(input: {
    query: string;
    repository?: RepositoryRef;
    kinds?: MemoryKind[];
    tags?: string[];
    since?: string;
    limit: number;
  }): MemoryRecord[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    let join = "";
    if (input.query.trim()) {
      const query = input.query
        .trim()
        .split(/\s+/)
        .map((token) => `"${token.replaceAll('"', '""')}"`)
        .join(" AND ");
      join = "JOIN memories_fts ON memories_fts.rowid = m.rowid";
      clauses.push("memories_fts MATCH ?");
      values.push(query);
    }
    if (input.repository) {
      clauses.push("m.repository_root_id = ? AND m.repository_relative_path = ?");
      values.push(input.repository.rootId, input.repository.relativePath);
    }
    if (input.kinds?.length) {
      clauses.push(`m.kind IN (${input.kinds.map(() => "?").join(",")})`);
      values.push(...input.kinds);
    }
    for (const tag of input.tags ?? []) {
      clauses.push("m.tags_json LIKE ?");
      values.push(`%${tag}%`);
    }
    if (input.since) {
      clauses.push("m.created_at >= ?");
      values.push(input.since);
    }
    values.push(input.limit);
    const sql = `SELECT m.* FROM memories m ${join} ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY m.created_at DESC LIMIT ?`;
    return (this.#database.prepare(sql).all(...values) as Record<string, unknown>[]).map(
      rowToRecord,
    );
  }

  context(repository: RepositoryRef, limit: number): MemoryRecord[] {
    return (
      this.#database
        .prepare(
          `SELECT * FROM memories
           WHERE repository_root_id = ? AND repository_relative_path = ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(repository.rootId, repository.relativePath, limit) as Record<string, unknown>[]
    ).map(rowToRecord);
  }

  stats(): Record<string, unknown> {
    const total = this.#database.prepare("SELECT COUNT(*) AS count FROM memories").get() as {
      count: number;
    };
    const byKind = this.#database
      .prepare("SELECT kind, COUNT(*) AS count FROM memories GROUP BY kind ORDER BY kind")
      .all();
    return { total: total.count, byKind };
  }
}

function textFromCodexRecord(
  record: Record<string, unknown>,
): { role: string; text: string } | null {
  const payload = (record.payload as Record<string, unknown> | undefined) ?? record;
  const role = String(payload.role ?? payload.type ?? record.type ?? "conversation");
  const direct = payload.message ?? payload.text ?? payload.content;
  if (typeof direct === "string" && direct.trim()) return { role, text: direct };
  if (Array.isArray(direct)) {
    const text = direct
      .flatMap((item) => {
        if (typeof item === "string") return [item];
        if (!item || typeof item !== "object") return [];
        const entry = item as Record<string, unknown>;
        const value = entry.text ?? entry.input_text ?? entry.output_text;
        return typeof value === "string" ? [value] : [];
      })
      .join("\n");
    if (text.trim()) return { role, text };
  }
  return null;
}

function draftFromObject(
  object: Record<string, unknown>,
  source: string,
  repository?: RepositoryRef,
): MemoryDraft | null {
  const codex = textFromCodexRecord(object);
  const title = String(
    object.title ?? (codex ? `${codex.role} from ${path.basename(source)}` : ""),
  );
  const body = String(object.body ?? object.summary ?? object.content ?? codex?.text ?? "");
  if (!body.trim()) return null;
  const kindValue = String(object.kind ?? (codex ? "conversation" : "note"));
  const kind: MemoryKind = [
    "decision",
    "incident",
    "verification",
    "note",
    "conversation",
  ].includes(kindValue)
    ? (kindValue as MemoryKind)
    : "note";
  return {
    kind,
    title: title || path.basename(source),
    body,
    ...(repository ? { repository } : {}),
    tags: Array.isArray(object.tags) ? object.tags.map(String) : [],
    sources: [source],
  };
}

export function importDrafts(
  config: KkConfig,
  file: string,
  format: "auto" | "markdown" | "json" | "jsonl" | "codex-jsonl",
  repository?: RepositoryRef,
): MemoryDraft[] {
  let source: string;
  try {
    const size = statSync(file).size;
    if (size > config.limits.maxArtifactBytes) {
      throw new KkError("OUTPUT_LIMIT", "Memory import exceeds configured size limit", {
        details: { size, limit: config.limits.maxArtifactBytes },
      });
    }
    source = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof KkError) throw error;
    throw new KkError("INVALID_ARGUMENT", `Cannot read memory import file: ${file}`, {
      cause: error,
    });
  }
  const selected =
    format === "auto"
      ? file.endsWith(".md")
        ? "markdown"
        : file.endsWith(".jsonl")
          ? "jsonl"
          : "json"
      : format;
  let drafts: MemoryDraft[];
  if (selected === "markdown") {
    const title = source.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(file);
    drafts = [
      {
        kind: "note",
        title,
        body: source,
        ...(repository ? { repository } : {}),
        tags: [],
        sources: [file],
      },
    ];
  } else if (selected === "json") {
    let json: Record<string, unknown> | Record<string, unknown>[];
    try {
      json = JSON.parse(source) as Record<string, unknown> | Record<string, unknown>[];
    } catch (error) {
      throw new KkError("INVALID_ARGUMENT", `Invalid JSON memory import: ${file}`, {
        cause: error,
      });
    }
    drafts = (Array.isArray(json) ? json : [json]).flatMap((object) => {
      const draft = draftFromObject(object, file, repository);
      return draft ? [draft] : [];
    });
  } else {
    drafts = source.split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return [];
      let object: Record<string, unknown>;
      try {
        object = JSON.parse(line) as Record<string, unknown>;
      } catch (error) {
        throw new KkError("INVALID_ARGUMENT", `Invalid JSONL at ${file}:${index + 1}`, {
          cause: error,
        });
      }
      if (selected === "codex-jsonl") {
        const recordType = String(object.type ?? "");
        const supported = new Set([
          "compacted",
          "event_msg",
          "response_item",
          "session_meta",
          "turn_context",
        ]);
        if (!supported.has(recordType)) {
          throw new KkError(
            "INVALID_ARGUMENT",
            `Unsupported Codex rollout record type at ${file}:${index + 1}: ${recordType || "missing"}`,
          );
        }
      }
      const draft = draftFromObject(object, `${file}#L${index + 1}`, repository);
      return draft ? [draft] : [];
    });
  }
  if (selected === "codex-jsonl" && drafts.length === 0) {
    throw new KkError("INVALID_ARGUMENT", "Codex rollout contained no supported textual records");
  }
  return drafts.map((draft) => ({
    ...draft,
    title: redactText(draft.title, config.audit.redactionPatterns).slice(0, 500),
    body: redactText(draft.body, config.audit.redactionPatterns).slice(0, 524_288),
  }));
}

export function memoryContentHash(draft: MemoryDraft): string {
  return hashDraft(draft);
}
