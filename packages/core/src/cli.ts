import type { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type KkConfig, loadConfig } from "./config.js";
import { asKkError, KkError } from "./errors.js";
import { createLogger, type LogLevel } from "./logger.js";

interface CliOptions {
  configPath: string;
  logLevel: LogLevel;
}

function parseCli(argv: readonly string[]): CliOptions {
  let configPath: string | undefined;
  let logLevel: LogLevel = "info";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      configPath = argv[index + 1];
      index += 1;
    } else if (argument?.startsWith("--config=")) {
      configPath = argument.slice("--config=".length);
    } else if (argument === "--log-level") {
      const value = argv[index + 1] as LogLevel | undefined;
      if (!value || !["debug", "info", "warn", "error"].includes(value)) {
        throw new KkError("INVALID_ARGUMENT", "Invalid --log-level");
      }
      logLevel = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: <server> --config /absolute/path/to/kk-mcp.config.json\n");
      process.exit(0);
    } else if (argument === "--version") {
      process.stdout.write("0.1.0\n");
      process.exit(0);
    } else {
      throw new KkError("INVALID_ARGUMENT", `Unknown argument: ${argument}`);
    }
  }
  if (!configPath) throw new KkError("CONFIG_ERROR", "Missing required --config argument");
  return { configPath, logLevel };
}

export async function runServerCli(
  name: string,
  createServer: (config: KkConfig) => McpServer,
): Promise<void> {
  try {
    const options = parseCli(process.argv.slice(2));
    const config = await loadConfig(options.configPath);
    const logger = createLogger(name, options.logLevel, config.audit.redactionPatterns);
    const handle = serveStdio(() => createServer(config), {
      onerror: (error) => logger.error("STDIO transport error", { error: error.message }),
    });
    const shutdown = async () => {
      await handle.close().catch(() => undefined);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    logger.info("MCP server starting", { transport: "stdio" });
  } catch (error) {
    const normalized = asKkError(error);
    process.stderr.write(`${normalized.code}: ${normalized.message}\n`);
    process.exitCode = 1;
  }
}
