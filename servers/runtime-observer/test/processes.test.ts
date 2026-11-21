import { expect, test } from "bun:test";
import { assertStoppableProcess, inspectProcess } from "../src/adapters/processes.js";

test("inspects the current process but protects it from termination", async () => {
  const record = await inspectProcess(process.pid);
  expect(record.pid).toBe(process.pid);
  expect(() => assertStoppableProcess(record)).toThrow();
});
