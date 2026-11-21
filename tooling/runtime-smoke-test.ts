import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectStdio } from "../packages/testkit/src/index.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const artifactRoot = process.argv[2] ? path.resolve(process.argv[2]) : repositoryRoot;
const servers: Record<string, string[]> = {
  workspace: [
    "discover_repositories",
    "inspect_repository",
    "inspect_workspace",
    "find_project_instructions",
    "analyze_dependency_graph",
    "search_workspace",
    "get_capabilities",
  ],
  "git-guardian": [
    "inspect_git_state",
    "compare_git_refs",
    "inspect_submodules",
    "inspect_vendor_lock",
    "inspect_subtree",
    "plan_vendor_sync",
    "apply_vendor_sync",
    "plan_commit",
    "verify_commit_scope",
    "get_capabilities",
  ],
  "runtime-observer": [
    "list_dev_processes",
    "find_process_by_port",
    "inspect_process",
    "list_services",
    "inspect_service_health",
    "tail_service_log",
    "plan_stop_process",
    "apply_stop_process",
    "get_capabilities",
  ],
  "project-memory": [
    "search_project_memory",
    "get_project_context",
    "plan_record_decision",
    "plan_record_incident",
    "plan_record_verification",
    "plan_link_memory",
    "plan_import_memory",
    "apply_memory_plan",
    "get_capabilities",
  ],
  "build-evidence": [
    "list_verification_profiles",
    "detect_test_frameworks",
    "plan_verification",
    "run_verification",
    "get_verification_run",
    "get_failed_tests",
    "compare_verification_runs",
    "list_build_artifacts",
    "inspect_build_artifact",
    "get_capabilities",
  ],
  "desktop-lab": [
    "list_desktop_capabilities",
    "list_configured_apps",
    "inspect_app_process",
    "inspect_window_state",
    "collect_app_logs",
    "collect_crash_reports",
    "capture_app_screenshot",
    "plan_launch_app",
    "apply_launch_app",
    "plan_stop_app",
    "apply_stop_app",
    "get_capabilities",
  ],
  "network-forensics": [
    "list_network_capabilities",
    "inspect_proxy_environment",
    "inspect_dns",
    "inspect_tls",
    "trace_http_request",
    "trace_route",
    "diagnose_endpoint",
    "compare_network_paths",
    "get_capabilities",
  ],
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const directory = await mkdtemp(path.join(tmpdir(), "kk-mcp-runtime-smoke-"));
try {
  const configPath = path.join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      stateDir: path.join(directory, "state"),
      roots: [{ id: "kit", path: directory }],
    }),
  );

  for (const runtime of ["node", "bun"] as const) {
    const command =
      runtime === "node" ? (process.env.NODE_BINARY ?? "node") : (process.env.BUN_BINARY ?? "bun");
    const workspaceCli = path.join(artifactRoot, "servers", "workspace", "dist", "cli.mjs");
    const checkPath = path.join(directory, `check-${runtime}.json`);
    const checkState = path.join(directory, `check-${runtime}-state`);
    const checkConfig = {
      version: 1,
      stateDir: checkState,
      roots: [{ id: "kit", path: directory }],
    };
    await writeFile(checkPath, JSON.stringify(checkConfig));
    const check = spawnSync(command, [workspaceCli, "--config", checkPath, "--check-config"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert(
      check.status === 0 && check.stdout.includes("Configuration valid"),
      `${runtime}: config check failed`,
    );
    const stateCreated = await lstat(checkState).then(
      () => true,
      (error) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    );
    assert(!stateCreated, `${runtime}: config check created a state directory`);
    await writeFile(
      checkPath,
      JSON.stringify({
        ...checkConfig,
        roots: [{ id: "kit", path: path.join(directory, "nonexistent-root") }],
      }),
    );
    const invalid = spawnSync(command, [workspaceCli, "--config", checkPath, "--check-config"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert(
      invalid.status === 1 && invalid.stderr.includes("CONFIG_ERROR"),
      `${runtime}: unknown root passed config check`,
    );

    for (const [serverName, expectedTools] of Object.entries(servers)) {
      const cli = path.join(artifactRoot, "servers", serverName, "dist", "cli.mjs");
      const connection = await connectStdio(command, [cli, "--config", configPath], directory);
      try {
        const listed = await connection.client.listTools();
        const actual = listed.tools.map((tool) => tool.name).sort();
        assert(
          JSON.stringify(actual) === JSON.stringify([...expectedTools].sort()),
          `${runtime}/${serverName}: unexpected tools ${JSON.stringify(actual)}`,
        );
        const capabilities = await connection.client.callTool({
          name: "get_capabilities",
          arguments: {},
        });
        assert(!capabilities.isError, `${runtime}/${serverName}: get_capabilities failed`);
        assert(
          capabilities.structuredContent !== undefined,
          `${runtime}/${serverName}: missing structured output`,
        );
        if (serverName === "workspace") {
          const resource = await connection.client.readResource({ uri: "workspace://roots" });
          assert(resource.contents.length === 1, `${runtime}/workspace: resource read failed`);
        }
        if (serverName === "project-memory") {
          const resource = await connection.client.readResource({ uri: "project-memory://stats" });
          assert(resource.contents.length === 1, `${runtime}/project-memory: resource read failed`);
        }
        if (serverName === "network-forensics") {
          const disabled = await connection.client.callTool({
            name: "inspect_dns",
            arguments: { hostname: "localhost" },
          });
          const structured = disabled.structuredContent as
            | { error?: { code?: string } }
            | undefined;
          assert(
            structured?.error?.code === "CAPABILITY_DISABLED",
            "Default active probe was not denied",
          );
        }
        if (serverName === "build-evidence" || serverName === "desktop-lab") {
          const templates = await connection.client.listResourceTemplates();
          assert(
            templates.resourceTemplates.length === 1,
            `${runtime}/${serverName}: artifact resource template missing`,
          );
        }
      } finally {
        await connection.client.close();
      }
    }
  }
  console.error(
    `Node and Bun STDIO protocol smoke tests passed for all ${Object.keys(servers).length} servers.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
