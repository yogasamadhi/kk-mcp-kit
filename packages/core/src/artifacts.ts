import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KkConfig } from "./config.js";
import { KkError } from "./errors.js";
import type { ArtifactRecord } from "./types.js";

export class ArtifactStore {
  readonly #config: KkConfig;
  readonly #server: string;
  readonly #scheme: string;

  constructor(config: KkConfig, server: string, scheme = server) {
    this.#config = config;
    this.#server = server;
    this.#scheme = scheme;
  }

  async put(data: Uint8Array, extension: string, mimeType: string): Promise<ArtifactRecord> {
    if (data.byteLength > this.#config.limits.maxArtifactBytes) {
      throw new KkError("OUTPUT_LIMIT", "Artifact exceeds configured size limit", {
        details: { size: data.byteLength, limit: this.#config.limits.maxArtifactBytes },
      });
    }
    const id = randomUUID();
    const safeExtension = extension.replace(/[^a-zA-Z0-9.]/g, "").replace(/^\.+/, "") || "bin";
    const relativePath = path.join(this.#server, `${id}.${safeExtension}`);
    const absolutePath = path.join(this.#config.stateDir, "artifacts", relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
    await writeFile(absolutePath, data, { mode: 0o600 });
    const record: ArtifactRecord = {
      id,
      server: this.#server,
      relativePath,
      mimeType,
      size: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
      createdAt: new Date().toISOString(),
      uri: `${this.#scheme}://artifacts/${id}`,
    };
    const recordsDirectory = path.join(
      this.#config.stateDir,
      "artifacts",
      this.#server,
      ".records",
    );
    await mkdir(recordsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(recordsDirectory, `${id}.json`), JSON.stringify(record), {
      encoding: "utf8",
      mode: 0o600,
    });
    return record;
  }

  async read(record: ArtifactRecord): Promise<Uint8Array> {
    if (record.server !== this.#server)
      throw new KkError("PERMISSION_DENIED", "Wrong artifact owner");
    const data = await readFile(path.join(this.#config.stateDir, "artifacts", record.relativePath));
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (data.byteLength !== record.size || sha256 !== record.sha256) {
      throw new KkError("CONFLICT", "Artifact content no longer matches its metadata", {
        details: { id: record.id },
      });
    }
    return data;
  }

  async get(id: string): Promise<ArtifactRecord> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new KkError("INVALID_ARGUMENT", "Invalid artifact id");
    const file = path.join(
      this.#config.stateDir,
      "artifacts",
      this.#server,
      ".records",
      `${id}.json`,
    );
    const record = await readFile(file, "utf8")
      .then((source) => JSON.parse(source) as ArtifactRecord)
      .catch(() => {
        throw new KkError("INVALID_ARGUMENT", `Unknown artifact id: ${id}`);
      });
    if (record.server !== this.#server || record.id !== id) {
      throw new KkError("PERMISSION_DENIED", "Artifact metadata owner mismatch");
    }
    return record;
  }

  async list(): Promise<ArtifactRecord[]> {
    const recordsDirectory = path.join(
      this.#config.stateDir,
      "artifacts",
      this.#server,
      ".records",
    );
    const entries = await readdir(recordsDirectory).catch(() => []);
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => this.get(entry.slice(0, -5)).catch(() => undefined)),
    );
    return records
      .filter((record): record is ArtifactRecord => Boolean(record))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}
