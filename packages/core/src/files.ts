import { open } from "node:fs/promises";

export async function readTextTail(
  file: string,
  maximumBytes: number,
): Promise<{ text: string; size: number; truncated: boolean }> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, maximumBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, Math.max(0, info.size - length));
    return { text: buffer.toString("utf8"), size: info.size, truncated: info.size > length };
  } finally {
    await handle.close();
  }
}

export async function readTextHead(
  file: string,
  maximumBytes: number,
): Promise<{ text: string; size: number; truncated: boolean }> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, maximumBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, 0);
    return { text: buffer.toString("utf8"), size: info.size, truncated: info.size > length };
  } finally {
    await handle.close();
  }
}
