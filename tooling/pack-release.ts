import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const [tag, destination, ...extra] = process.argv.slice(2);
if (!tag || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag) || !destination || extra.length) {
  console.error("Usage: bun run release:pack <vX.Y.Z[-suffix]> <new-output-directory>");
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(destination);
const filename = `kk-mcp-kit-${tag}.zip`;
const archive = path.join(output, filename);

// Reserve a new directory so a retry cannot overwrite an earlier candidate.
await mkdir(output);
try {
  execFileSync(process.execPath, ["tooling/build.ts"], { cwd: root, stdio: "inherit" });
  const work = await mkdtemp(path.join(tmpdir(), "kk-mcp-release-"));
  try {
    const stage = path.join(work, "stage");
    const unpacked = path.join(work, "unpacked");
    const entries = execFileSync(
      "git",
      [
        "ls-files",
        "-z",
        "--",
        "LICENSE",
        "README.md",
        "curated/README.md",
        "docs",
        "examples",
        "servers/README.md",
        ":(glob)servers/*/README.md",
      ],
      { cwd: root, encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean);
    const servers = await readdir(path.join(root, "servers"), { withFileTypes: true });
    for (const server of servers.filter((entry) => entry.isDirectory())) {
      for (const file of ["cli.mjs", "cli.mjs.map", "index.mjs", "index.mjs.map"]) {
        entries.push(`servers/${server.name}/dist/${file}`);
      }
    }
    for (const entry of [...new Set(entries)].sort()) {
      const source = path.join(root, entry);
      if (!(await lstat(source)).isFile()) {
        throw new Error(`Expected a regular file: ${entry}`);
      }
      const target = path.join(stage, entry);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    execFileSync("zip", ["-q", "-X", "-D", "-r", archive, "."], { cwd: stage, stdio: "inherit" });
    execFileSync("unzip", ["-q", archive, "-d", unpacked], { stdio: "inherit" });
    execFileSync(process.execPath, ["tooling/runtime-smoke-test.ts", unpacked], {
      cwd: root,
      stdio: "inherit",
    });

    const hash = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    await writeFile(path.join(output, "SHA256SUMS.txt"), `${hash}  ${filename}\n`);
    console.error(`Verified ${archive}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
}
