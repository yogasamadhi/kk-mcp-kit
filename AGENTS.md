# Repository guidance

- Use Bun 1.4 for dependency management, development, tests, and builds.
- Runtime code under `servers/` and `packages/core/` must run unchanged on Node.js 22.13+
  and Bun 1.4+; do not use `Bun.*`, `bun:*`, or Bun-only globals there.
- Build distributable ESM with Bun's `target: "node"`; keep the Node shebang on CLI entries.
- Keep each MCP Server independent under `servers/<name>/`. Shared security and protocol
  primitives belong in `packages/core/`; domain behavior does not.
- Use semantic, allowlisted operations. Never expose an arbitrary shell or command tool.
- Inspection and planning are safe defaults. System mutations require an enabled capability,
  a short-lived plan, state revalidation, and an audit record.
- STDIO stdout is the MCP protocol channel. Runtime diagnostics must go to stderr.
- Use TypeScript for all repository code. Add no Python helpers.
- Run `bun run check` before handing off changes.
