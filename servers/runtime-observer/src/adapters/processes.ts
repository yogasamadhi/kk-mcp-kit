import { commandExists, KkError, redactText, runCommand } from "@kk-mcp-kit/core";

export interface ProcessRecord {
  pid: number;
  ppid: number;
  startedAt: string | null;
  executable: string | null;
  command: string;
}

async function windowsPowerShell(): Promise<string> {
  if (await commandExists("powershell.exe")) return "powershell.exe";
  if (await commandExists("pwsh.exe")) return "pwsh.exe";
  throw new KkError("UNSUPPORTED_BACKEND", "PowerShell is required on Windows");
}

async function listWindowsProcesses(): Promise<ProcessRecord[]> {
  const powershell = await windowsPowerShell();
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  const result = await runCommand(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeoutMs: 30_000 },
  );
  const parsed = JSON.parse(result.stdout || "[]") as
    | Record<string, unknown>
    | Record<string, unknown>[];
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records.map((record) => ({
    pid: Number(record.ProcessId),
    ppid: Number(record.ParentProcessId),
    startedAt: record.CreationDate ? new Date(String(record.CreationDate)).toISOString() : null,
    executable: record.ExecutablePath ? String(record.ExecutablePath) : null,
    command: redactText(String(record.CommandLine ?? record.ExecutablePath ?? "")),
  }));
}

async function listPosixProcesses(): Promise<ProcessRecord[]> {
  const result = await runCommand("ps", ["-axo", "pid=,ppid=,lstart=,command="], {
    timeoutMs: 30_000,
    maxOutputBytes: 4_194_304,
  });
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/,
    );
    if (!match) return [];
    const command = redactText(match[4] ?? "");
    const started = new Date(match[3] ?? "");
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        startedAt: Number.isNaN(started.getTime()) ? null : started.toISOString(),
        executable: command.split(/\s+/)[0] ?? null,
        command,
      },
    ];
  });
}

export async function listProcesses(): Promise<ProcessRecord[]> {
  return process.platform === "win32" ? listWindowsProcesses() : listPosixProcesses();
}

export async function inspectProcess(pid: number): Promise<ProcessRecord> {
  const processRecord = (await listProcesses()).find((candidate) => candidate.pid === pid);
  if (!processRecord) throw new KkError("INVALID_ARGUMENT", `Process ${pid} does not exist`);
  return processRecord;
}

export async function findPortOwners(port: number): Promise<{
  backend: string;
  owners: Array<{ pid: number; command?: string; endpoint?: string }>;
}> {
  if (process.platform === "win32") {
    const powershell = await windowsPowerShell();
    const script = `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object OwningProcess,LocalAddress,LocalPort | ConvertTo-Json -Compress`;
    const result = await runCommand(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { allowNonZero: true },
    );
    const parsed = result.stdout.trim()
      ? (JSON.parse(result.stdout) as Record<string, unknown> | Record<string, unknown>[])
      : [];
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return {
      backend: "Get-NetTCPConnection",
      owners: records.map((record) => ({
        pid: Number(record.OwningProcess),
        endpoint: `${String(record.LocalAddress)}:${String(record.LocalPort)}`,
      })),
    };
  }
  if (process.platform === "darwin") {
    if (!(await commandExists("lsof"))) {
      throw new KkError("UNSUPPORTED_BACKEND", "lsof is not available");
    }
    const result = await runCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcn"], {
      allowNonZero: true,
    });
    const owners: Array<{ pid: number; command?: string; endpoint?: string }> = [];
    let current: { pid: number; command?: string; endpoint?: string } | undefined;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith("p")) {
        current = { pid: Number(line.slice(1)) };
        owners.push(current);
      } else if (current && line.startsWith("c")) current.command = line.slice(1);
      else if (current && line.startsWith("n")) current.endpoint = line.slice(1);
    }
    return { backend: "lsof", owners };
  }
  if (!(await commandExists("ss"))) {
    throw new KkError("UNSUPPORTED_BACKEND", "ss is not available");
  }
  const result = await runCommand("ss", ["-ltnp", "sport", "=", `:${port}`], {
    allowNonZero: true,
  });
  const owners = result.stdout.split(/\r?\n/).flatMap((line) => {
    const pid = line.match(/pid=(\d+)/)?.[1];
    const endpoint = line.trim().split(/\s+/)[3];
    return pid ? [{ pid: Number(pid), ...(endpoint ? { endpoint } : {}) }] : [];
  });
  return { backend: "ss", owners };
}

export function processFingerprint(record: ProcessRecord): string {
  return `${record.pid}:${record.startedAt ?? "unknown"}:${record.executable ?? record.command}`;
}

const CRITICAL_WINDOWS_EXECUTABLES = new Set([
  "csrss.exe",
  "lsass.exe",
  "registry",
  "services.exe",
  "smss.exe",
  "system",
  "wininit.exe",
  "winlogon.exe",
]);

export function assertStoppableProcess(record: ProcessRecord): void {
  if (record.pid <= 4 || record.pid === process.pid || record.pid === process.ppid) {
    throw new KkError("PERMISSION_DENIED", `Process ${record.pid} is protected`);
  }
  if (process.platform === "win32") {
    const executable = (record.executable ?? record.command.split(/\s+/)[0] ?? "")
      .split(/[\\/]/)
      .at(-1)
      ?.toLowerCase();
    if (executable && CRITICAL_WINDOWS_EXECUTABLES.has(executable)) {
      throw new KkError(
        "PERMISSION_DENIED",
        `Critical Windows process is protected: ${executable}`,
      );
    }
  }
}
