import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export interface RuntimeInvocation {
  runtime: "node" | "bun";
  server: string;
  toolCount: number;
}

export async function connectStdio(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ client: Client; transport: StdioClientTransport; stderr: string[] }> {
  const stderr: string[] = [];
  const transport = new StdioClientTransport({ command, args, cwd, stderr: "pipe" });
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const client = new Client({ name: "kk-mcp-kit-testkit", version: "0.2.0" });
  await client.connect(transport);
  return { client, transport, stderr };
}
