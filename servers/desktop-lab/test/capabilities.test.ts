import { expect, test } from "bun:test";
import { desktopCapabilities } from "../src/adapters/desktop.js";

test("desktop capability detection is structured and does not require a backend", async () => {
  const capabilities = await desktopCapabilities();
  expect(capabilities.platform).toBe(process.platform);
  expect(typeof capabilities.launch).toBe("boolean");
  expect(typeof capabilities.screenshot).toBe("boolean");
});
