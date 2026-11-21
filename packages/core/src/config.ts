import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { KkError } from "./errors.js";

export const RepositoryRefSchema = z.object({
  rootId: z.string().min(1),
  relativePath: z.string().default("."),
});

const RootSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  path: z.string().min(1),
  maxDepth: z.number().int().min(1).max(32).default(8),
});

const LimitsSchema = z
  .object({
    defaultTimeoutMs: z.number().int().min(100).max(300_000).default(30_000),
    maxOutputBytes: z.number().int().min(1_024).max(16_777_216).default(262_144),
    maxArtifactBytes: z.number().int().min(1_024).max(104_857_600).default(10_485_760),
    maxItems: z.number().int().min(1).max(10_000).default(500),
    planTtlMs: z.number().int().min(10_000).max(1_800_000).default(300_000),
  })
  .prefault({});

const AuditSchema = z
  .object({
    enabled: z.boolean().default(true),
    redactionPatterns: z.array(z.string()).default([]),
  })
  .prefault({});

const CapabilitiesSchema = z
  .object({
    gitGuardian: z
      .object({ applyVendorSync: z.boolean().default(false) })
      .default({ applyVendorSync: false }),
    runtimeObserver: z
      .object({ stopProcess: z.boolean().default(false) })
      .default({ stopProcess: false }),
    projectMemory: z
      .object({
        write: z.boolean().default(false),
        import: z.boolean().default(false),
      })
      .default({ write: false, import: false }),
    buildEvidence: z.object({ run: z.boolean().default(false) }).default({ run: false }),
    desktopLab: z
      .object({
        launch: z.boolean().default(false),
        stop: z.boolean().default(false),
        capture: z.boolean().default(false),
      })
      .default({ launch: false, stop: false, capture: false }),
    networkForensics: z
      .object({ activeProbe: z.boolean().default(false) })
      .default({ activeProbe: false }),
  })
  .prefault({});

const VendorSchema = z.object({
  id: z.string().min(1),
  repository: RepositoryRefSchema,
  path: z.string().min(1),
  lockFile: z.string().default("vendor-lock.json"),
  remote: z.string().default("origin"),
  versionFile: z.string().optional(),
});

const ServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  repository: RepositoryRefSchema.optional(),
  executable: z.string().optional(),
  processMatch: z.string().optional(),
  pid: z.number().int().positive().optional(),
  pidFile: z.string().optional(),
  healthUrl: z.string().url().optional(),
  logPaths: z.array(z.string()).default([]),
  composeService: z.string().optional(),
});

const VerificationProfileSchema = z.object({
  id: z.string().min(1),
  repository: RepositoryRefSchema,
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(100).max(1_800_000).default(600_000),
  environmentAllowlist: z.array(z.string()).default([]),
  parser: z.enum(["generic", "junit", "go-json", "cargo", "xcresult"]).default("generic"),
  resultPaths: z.array(z.string()).default([]),
  artifactGlobs: z.array(z.string()).default([]),
});

const DesktopAppSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  processMatch: z.string().min(1),
  bundleId: z.string().optional(),
  logPaths: z.array(z.string()).default([]),
  crashPaths: z.array(z.string()).default([]),
  windowsEventProvider: z.string().optional(),
});

const NetworkProfileSchema = z.object({
  id: z.string().min(1),
  proxyUrl: z.string().url().optional(),
  family: z.enum(["auto", "ipv4", "ipv6"]).default("auto"),
});

const ServersSchema = z
  .object({
    workspace: z
      .object({
        ignoredDirectories: z
          .array(z.string())
          .default([".git", "node_modules", "dist", "build", "target"]),
      })
      .prefault({}),
    gitGuardian: z.object({ vendors: z.array(VendorSchema).default([]) }).prefault({}),
    runtimeObserver: z.object({ services: z.array(ServiceSchema).default([]) }).prefault({}),
    projectMemory: z.object({ importRoots: z.array(z.string()).default([]) }).prefault({}),
    buildEvidence: z
      .object({ profiles: z.array(VerificationProfileSchema).default([]) })
      .prefault({}),
    desktopLab: z.object({ apps: z.array(DesktopAppSchema).default([]) }).prefault({}),
    networkForensics: z
      .object({
        allowedHosts: z.array(z.string()).default(["localhost", "127.0.0.1", "::1"]),
        profiles: z.array(NetworkProfileSchema).default([]),
      })
      .prefault({}),
  })
  .prefault({});

export const KkConfigSchema = z.object({
  version: z.literal(1),
  stateDir: z.string().min(1),
  roots: z.array(RootSchema).min(1),
  limits: LimitsSchema,
  audit: AuditSchema,
  capabilities: CapabilitiesSchema,
  servers: ServersSchema,
});

export type KkConfig = z.infer<typeof KkConfigSchema>;
export type RootConfig = KkConfig["roots"][number];
export type VerificationProfile = KkConfig["servers"]["buildEvidence"]["profiles"][number];
export type DesktopApp = KkConfig["servers"]["desktopLab"]["apps"][number];
export type RuntimeService = KkConfig["servers"]["runtimeObserver"]["services"][number];
export type VendorConfig = KkConfig["servers"]["gitGuardian"]["vendors"][number];

function validateAbsolutePaths(config: KkConfig): void {
  const paths: Array<[string, string]> = [
    ["stateDir", config.stateDir],
    ...config.roots.map((root): [string, string] => [`roots.${root.id}.path`, root.path]),
    ...config.servers.projectMemory.importRoots.map(
      (value, index) => [`servers.projectMemory.importRoots.${index}`, value] as [string, string],
    ),
  ];
  for (const [label, value] of paths) {
    if (!path.isAbsolute(value)) {
      throw new KkError("CONFIG_ERROR", `${label} must be an absolute path`);
    }
  }

  const rootIds = new Set<string>();
  for (const root of config.roots) {
    if (rootIds.has(root.id)) throw new KkError("CONFIG_ERROR", `Duplicate root id: ${root.id}`);
    rootIds.add(root.id);
  }

  const assertReference = (
    label: string,
    reference: { rootId: string; relativePath?: string },
  ): void => {
    if (!rootIds.has(reference.rootId)) {
      throw new KkError("CONFIG_ERROR", `${label} references unknown rootId: ${reference.rootId}`);
    }
    if (reference.relativePath) assertSafeRelative(`${label}.relativePath`, reference.relativePath);
  };
  const assertSafeRelative = (label: string, value: string): void => {
    if (
      path.posix.isAbsolute(value) ||
      path.win32.isAbsolute(value) ||
      value.split(/[\\/]/).includes("..") ||
      value.includes("\0")
    ) {
      throw new KkError("CONFIG_ERROR", `${label} must be a non-escaping relative path`);
    }
  };
  const assertUniqueIds = (label: string, records: readonly { id: string }[]): void => {
    const ids = new Set<string>();
    for (const record of records) {
      if (ids.has(record.id))
        throw new KkError("CONFIG_ERROR", `Duplicate ${label} id: ${record.id}`);
      ids.add(record.id);
    }
  };

  assertUniqueIds("vendor", config.servers.gitGuardian.vendors);
  for (const vendor of config.servers.gitGuardian.vendors) {
    assertReference(`servers.gitGuardian.vendors.${vendor.id}`, vendor.repository);
    assertSafeRelative(`vendor ${vendor.id} path`, vendor.path);
    assertSafeRelative(`vendor ${vendor.id} lockFile`, vendor.lockFile);
    if (vendor.versionFile)
      assertSafeRelative(`vendor ${vendor.id} versionFile`, vendor.versionFile);
  }

  assertUniqueIds("service", config.servers.runtimeObserver.services);
  for (const service of config.servers.runtimeObserver.services) {
    if (service.repository) assertReference(`service ${service.id}`, service.repository);
    if (service.pidFile && !path.isAbsolute(service.pidFile) && !service.repository) {
      throw new KkError(
        "CONFIG_ERROR",
        `service ${service.id} relative pidFile requires repository`,
      );
    }
    if (service.pidFile && !path.isAbsolute(service.pidFile)) {
      assertSafeRelative(`service ${service.id} pidFile`, service.pidFile);
    }
    if (service.healthUrl) {
      const url = new URL(service.healthUrl);
      if (url.username || url.password) {
        throw new KkError(
          "CONFIG_ERROR",
          `service ${service.id} healthUrl cannot contain credentials`,
        );
      }
    }
    for (const logPath of service.logPaths) {
      if (!path.isAbsolute(logPath) && !service.repository) {
        throw new KkError(
          "CONFIG_ERROR",
          `service ${service.id} relative logPath requires repository`,
        );
      }
      if (!path.isAbsolute(logPath)) assertSafeRelative(`service ${service.id} logPath`, logPath);
    }
  }

  assertUniqueIds("verification profile", config.servers.buildEvidence.profiles);
  for (const profile of config.servers.buildEvidence.profiles) {
    assertReference(`verification profile ${profile.id}`, profile.repository);
    if (
      profile.command.includes("\0") ||
      profile.args.some((argument) => argument.includes("\0"))
    ) {
      throw new KkError("CONFIG_ERROR", `verification profile ${profile.id} contains NUL bytes`);
    }
    for (const resultPath of profile.resultPaths) {
      assertSafeRelative(`verification profile ${profile.id} resultPath`, resultPath);
    }
    for (const artifactGlob of profile.artifactGlobs) {
      assertSafeRelative(`verification profile ${profile.id} artifactGlob`, artifactGlob);
    }
  }

  assertUniqueIds("desktop app", config.servers.desktopLab.apps);
  for (const app of config.servers.desktopLab.apps) {
    if (app.executable.includes("\0") || app.args.some((argument) => argument.includes("\0"))) {
      throw new KkError("CONFIG_ERROR", `desktop app ${app.id} contains NUL bytes`);
    }
    for (const configuredPath of [...app.logPaths, ...app.crashPaths]) {
      if (!path.isAbsolute(configuredPath)) {
        throw new KkError("CONFIG_ERROR", `desktop app ${app.id} paths must be absolute`);
      }
    }
  }

  assertUniqueIds("network profile", config.servers.networkForensics.profiles);
  for (const host of config.servers.networkForensics.allowedHosts) {
    if (
      !host.trim() ||
      host === "*." ||
      /[/@?#]/.test(host) ||
      (host.includes("*") && !host.startsWith("*."))
    ) {
      throw new KkError("CONFIG_ERROR", `Invalid allowedHosts pattern: ${host}`);
    }
  }
  for (const profile of config.servers.networkForensics.profiles) {
    if (profile.proxyUrl) {
      const url = new URL(profile.proxyUrl);
      if (url.username || url.password) {
        throw new KkError(
          "CONFIG_ERROR",
          `network profile ${profile.id} proxyUrl cannot contain credentials`,
        );
      }
    }
  }
  for (const pattern of config.audit.redactionPatterns) {
    try {
      new RegExp(pattern);
    } catch {
      throw new KkError("CONFIG_ERROR", `Invalid audit redaction pattern: ${pattern}`);
    }
  }
}

export async function loadConfig(
  configPath: string,
  { createStateDir = true }: { createStateDir?: boolean } = {},
): Promise<KkConfig> {
  if (!path.isAbsolute(configPath)) {
    throw new KkError("CONFIG_ERROR", "--config must be an absolute path");
  }
  const source = await readFile(configPath, "utf8").catch((error) => {
    throw new KkError("CONFIG_ERROR", `Cannot read config: ${configPath}`, { cause: error });
  });
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (error) {
    throw new KkError("CONFIG_ERROR", `Config is not valid JSON: ${configPath}`, { cause: error });
  }
  const parsed = KkConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new KkError("CONFIG_ERROR", "Config validation failed", {
      details: { issues: parsed.error.issues },
    });
  }
  validateAbsolutePaths(parsed.data);
  if (createStateDir) await mkdir(parsed.data.stateDir, { recursive: true, mode: 0o700 });
  return parsed.data;
}
