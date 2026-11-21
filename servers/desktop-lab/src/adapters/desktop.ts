import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  commandExists,
  type DesktopApp,
  type KkConfig,
  KkError,
  redactText,
  runCommand,
} from "@kk-mcp-kit/core";

export interface AppProcess {
  pid: number;
  command: string;
  startedAt?: string;
}

async function powershell(): Promise<string> {
  if (await commandExists("powershell.exe")) return "powershell.exe";
  if (await commandExists("pwsh.exe")) return "pwsh.exe";
  throw new KkError("UNSUPPORTED_BACKEND", "PowerShell is not available");
}

export async function desktopCapabilities(): Promise<Record<string, unknown>> {
  if (process.platform === "darwin") {
    return {
      platform: "darwin",
      launch: await commandExists("open"),
      windows: await commandExists("osascript"),
      logs: await commandExists("log"),
      screenshot: await commandExists("screencapture"),
      screenshotBackend: "screencapture",
    };
  }
  if (process.platform === "win32") {
    const available = (await commandExists("powershell.exe")) || (await commandExists("pwsh.exe"));
    return {
      platform: "win32",
      launch: available,
      windows: available,
      logs: available,
      screenshot: available,
      screenshotBackend: available ? "PowerShell/.NET" : null,
    };
  }
  const screenshotBackend = (await commandExists("gnome-screenshot"))
    ? "gnome-screenshot"
    : (await commandExists("grim"))
      ? "grim"
      : (await commandExists("scrot"))
        ? "scrot"
        : null;
  const windowBackend = (await commandExists("swaymsg"))
    ? "swaymsg"
    : (await commandExists("hyprctl"))
      ? "hyprctl"
      : (await commandExists("wmctrl"))
        ? "wmctrl"
        : null;
  return {
    platform: "linux",
    launch: true,
    xdgOpen: await commandExists("xdg-open"),
    windows: Boolean(windowBackend),
    windowBackend,
    logs: await commandExists("journalctl"),
    screenshot: Boolean(screenshotBackend),
    screenshotBackend,
    sessionType: process.env.XDG_SESSION_TYPE ?? null,
  };
}

export async function appProcesses(app: DesktopApp): Promise<AppProcess[]> {
  if (process.platform === "win32") {
    const shell = await powershell();
    const script =
      '$match=$env:KK_MCP_APP_MATCH; Get-CimInstance Win32_Process | Where-Object { $_.Name -like "*$match*" -or $_.CommandLine -like "*$match*" } | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress';
    const result = await runCommand(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { KK_MCP_APP_MATCH: app.processMatch },
      environmentAllowlist: ["KK_MCP_APP_MATCH"],
      allowNonZero: true,
    });
    if (!result.stdout.trim()) return [];
    const parsed = JSON.parse(result.stdout) as Record<string, unknown> | Record<string, unknown>[];
    return (Array.isArray(parsed) ? parsed : [parsed]).map((record) => ({
      pid: Number(record.ProcessId),
      command: redactText(String(record.CommandLine ?? "")),
      ...(record.CreationDate
        ? { startedAt: new Date(String(record.CreationDate)).toISOString() }
        : {}),
    }));
  }
  const result = await runCommand("ps", ["-axo", "pid=,lstart=,command="], {
    maxOutputBytes: 4_194_304,
  });
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/,
    );
    if (!match?.[3]?.includes(app.processMatch)) return [];
    const started = new Date(match[2] ?? "");
    return [
      {
        pid: Number(match[1]),
        command: redactText(match[3]),
        ...(Number.isNaN(started.getTime()) ? {} : { startedAt: started.toISOString() }),
      },
    ];
  });
}

export function appProcessFingerprint(processes: readonly AppProcess[]): string {
  return processes
    .map((record) => `${record.pid}:${record.startedAt ?? "unknown"}:${record.command}`)
    .sort()
    .join("|");
}

export async function inspectWindows(app: DesktopApp): Promise<Record<string, unknown>> {
  if (process.platform === "darwin") {
    const script = `
      set targetName to system attribute "KK_MCP_APP_MATCH"
      tell application "System Events"
        set output to ""
        repeat with p in (every application process whose name contains targetName)
          repeat with w in windows of p
            set output to output & (name of p as text) & tab & (name of w as text) & tab & (position of w as text) & tab & (size of w as text) & linefeed
          end repeat
        end repeat
        return output
      end tell
    `;
    const result = await runCommand("osascript", ["-e", script], {
      env: { KK_MCP_APP_MATCH: app.processMatch },
      environmentAllowlist: ["KK_MCP_APP_MATCH"],
      allowNonZero: true,
    });
    if (result.exitCode !== 0) {
      throw new KkError(
        "PERMISSION_DENIED",
        "Window inspection requires Accessibility permission",
        {
          details: { stderr: result.stderr },
        },
      );
    }
    return {
      backend: "osascript",
      windows: result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.split("\t")),
    };
  }
  if (process.platform === "win32") {
    const shell = await powershell();
    const script =
      '$match=$env:KK_MCP_APP_MATCH; Get-Process | Where-Object { $_.ProcessName -like "*$match*" } | Select-Object Id,ProcessName,MainWindowTitle,MainWindowHandle | ConvertTo-Json -Compress';
    const result = await runCommand(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { KK_MCP_APP_MATCH: app.processMatch },
      environmentAllowlist: ["KK_MCP_APP_MATCH"],
      allowNonZero: true,
    });
    return {
      backend: "PowerShell",
      windows: result.stdout.trim() ? JSON.parse(result.stdout) : [],
    };
  }
  if (await commandExists("swaymsg")) {
    const result = await runCommand("swaymsg", ["-t", "get_tree", "-r"], { allowNonZero: true });
    const matches: Record<string, unknown>[] = [];
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      const summary = {
        id: record.id,
        name: record.name,
        appId: record.app_id,
        pid: record.pid,
        rect: record.rect,
      };
      if (JSON.stringify(summary).toLowerCase().includes(app.processMatch.toLowerCase())) {
        matches.push(summary);
      }
      for (const key of ["nodes", "floating_nodes"]) {
        if (Array.isArray(record[key])) for (const child of record[key]) visit(child);
      }
    };
    visit(JSON.parse(result.stdout));
    return { backend: "swaymsg", windows: matches.slice(0, 500) };
  }
  if (await commandExists("hyprctl")) {
    const result = await runCommand("hyprctl", ["clients", "-j"], { allowNonZero: true });
    const clients = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    return {
      backend: "hyprctl",
      windows: clients.filter((client) => JSON.stringify(client).includes(app.processMatch)),
    };
  }
  if (await commandExists("wmctrl")) {
    const result = await runCommand("wmctrl", ["-lpGx"], { allowNonZero: true });
    return {
      backend: "wmctrl",
      windows: result.stdout.split(/\r?\n/).filter((line) => line.includes(app.processMatch)),
    };
  }
  throw new KkError("UNSUPPORTED_BACKEND", "No supported Linux window inspection backend found");
}

export async function collectSystemLogs(
  config: KkConfig,
  app: DesktopApp,
  minutes: number,
): Promise<Record<string, unknown>> {
  if (process.platform === "darwin") {
    const result = await runCommand(
      "log",
      ["show", "--last", `${minutes}m`, "--style", "ndjson", "--process", app.processMatch],
      { allowNonZero: true, maxOutputBytes: config.limits.maxOutputBytes },
    );
    return {
      backend: "unified-log",
      output: redactText(result.stdout, config.audit.redactionPatterns),
      truncated: result.truncated,
    };
  }
  if (process.platform === "win32") {
    const shell = await powershell();
    const script = app.windowsEventProvider
      ? "$provider=$env:KK_MCP_PROVIDER; Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName=$provider; StartTime=(Get-Date).AddMinutes(-[int]$env:KK_MCP_MINUTES)} -ErrorAction SilentlyContinue | Select-Object -First 200 TimeCreated,LevelDisplayName,Message | ConvertTo-Json -Compress"
      : "$match=$env:KK_MCP_APP_MATCH; Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-[int]$env:KK_MCP_MINUTES)} -ErrorAction SilentlyContinue | Where-Object { $_.Message -like \"*$match*\" } | Select-Object -First 200 TimeCreated,LevelDisplayName,Message | ConvertTo-Json -Compress";
    const result = await runCommand(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        KK_MCP_APP_MATCH: app.processMatch,
        KK_MCP_MINUTES: String(minutes),
        KK_MCP_PROVIDER: app.windowsEventProvider,
      },
      environmentAllowlist: ["KK_MCP_APP_MATCH", "KK_MCP_MINUTES", "KK_MCP_PROVIDER"],
      allowNonZero: true,
      maxOutputBytes: config.limits.maxOutputBytes,
    });
    return {
      backend: "Windows Event Log",
      output: redactText(result.stdout, config.audit.redactionPatterns),
      truncated: result.truncated,
    };
  }
  if (!(await commandExists("journalctl"))) {
    throw new KkError("UNSUPPORTED_BACKEND", "journalctl is not available");
  }
  const result = await runCommand(
    "journalctl",
    ["--user", "--since", `${minutes} minutes ago`, "-o", "json", `_COMM=${app.processMatch}`],
    { allowNonZero: true, maxOutputBytes: config.limits.maxOutputBytes },
  );
  return {
    backend: "journalctl",
    output: redactText(result.stdout, config.audit.redactionPatterns),
    truncated: result.truncated,
  };
}

export async function collectCrashReports(
  config: KkConfig,
  app: DesktopApp,
): Promise<Record<string, unknown>> {
  if (app.crashPaths.length > 0 || process.platform === "darwin") {
    const directories = app.crashPaths.length
      ? app.crashPaths
      : [path.join(homedir(), "Library", "Logs", "DiagnosticReports")];
    const reports: Array<{ path: string; modifiedAt: string; size: number }> = [];
    for (const directory of directories) {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isFile() || !entry.name.toLowerCase().includes(app.processMatch.toLowerCase()))
          continue;
        const absolute = path.join(directory, entry.name);
        const info = await import("node:fs/promises").then(({ stat }) => stat(absolute));
        reports.push({ path: absolute, modifiedAt: info.mtime.toISOString(), size: info.size });
      }
    }
    return {
      backend: "crash-files",
      reports: reports.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 100),
    };
  }
  if (process.platform === "win32") {
    return collectSystemLogs(config, app, 1_440);
  }
  if (await commandExists("coredumpctl")) {
    const result = await runCommand("coredumpctl", ["--json=short", "list", app.processMatch], {
      allowNonZero: true,
    });
    return {
      backend: "coredumpctl",
      output: redactText(result.stdout, config.audit.redactionPatterns),
    };
  }
  throw new KkError("UNSUPPORTED_BACKEND", "No crash report backend found");
}

export async function captureScreenshot(): Promise<{ data: Uint8Array; backend: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "kk-mcp-desktop-"));
  const output = path.join(directory, "capture.png");
  try {
    let backend: string;
    if (process.platform === "darwin") {
      await runCommand("screencapture", ["-x", "-t", "png", output]);
      backend = "screencapture";
    } else if (process.platform === "win32") {
      const shell = await powershell();
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save($env:KK_MCP_SCREENSHOT,[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $i.Dispose()";
      await runCommand(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        env: { KK_MCP_SCREENSHOT: output },
        environmentAllowlist: ["KK_MCP_SCREENSHOT"],
      });
      backend = "PowerShell/.NET";
    } else if (await commandExists("gnome-screenshot")) {
      await runCommand("gnome-screenshot", ["-f", output]);
      backend = "gnome-screenshot";
    } else if (await commandExists("grim")) {
      await runCommand("grim", [output]);
      backend = "grim";
    } else if (await commandExists("scrot")) {
      await runCommand("scrot", [output]);
      backend = "scrot";
    } else {
      throw new KkError("UNSUPPORTED_BACKEND", "No supported screenshot backend found");
    }
    return { data: await readFile(output), backend };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function launchApp(app: DesktopApp): Promise<void> {
  if (process.platform === "darwin") {
    const args = app.bundleId
      ? ["-b", app.bundleId, "--args", ...app.args]
      : ["-a", app.executable, "--args", ...app.args];
    await runCommand("open", args);
    return;
  }
  if (process.platform === "win32") {
    const shell = await powershell();
    const script =
      "$argv=ConvertFrom-Json $env:KK_MCP_APP_ARGS; Start-Process -FilePath $env:KK_MCP_APP_EXECUTABLE -ArgumentList $argv";
    await runCommand(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        KK_MCP_APP_ARGS: JSON.stringify(app.args),
        KK_MCP_APP_EXECUTABLE: app.executable,
      },
      environmentAllowlist: ["KK_MCP_APP_ARGS", "KK_MCP_APP_EXECUTABLE"],
    });
    return;
  }
  if (
    (app.executable.endsWith(".desktop") || /^[a-z][a-z0-9+.-]*:/i.test(app.executable)) &&
    (await commandExists("xdg-open"))
  ) {
    await runCommand("xdg-open", [app.executable]);
    return;
  }
  const child = spawn(app.executable, app.args, {
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

export async function stopApp(processes: readonly AppProcess[]): Promise<void> {
  const criticalWindowsExecutables = new Set([
    "csrss.exe",
    "lsass.exe",
    "services.exe",
    "smss.exe",
    "wininit.exe",
    "winlogon.exe",
  ]);
  for (const record of processes) {
    if (record.pid <= 4 || record.pid === process.pid || record.pid === process.ppid) {
      throw new KkError("PERMISSION_DENIED", `Protected process: ${record.pid}`);
    }
    const executable = record.command.split(/\s+/)[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
    if (process.platform === "win32" && executable && criticalWindowsExecutables.has(executable)) {
      throw new KkError(
        "PERMISSION_DENIED",
        `Critical Windows process is protected: ${executable}`,
      );
    }
    process.kill(record.pid, "SIGTERM");
  }
}
