import test from "node:test";
import assert from "node:assert/strict";
import { runSandboxedCode } from "../src/sandbox.js";

test("runSandboxedCode can call host APIs through worker bridge", async () => {
  const result = await runSandboxedCode<{ count: number }>({
    code: `async () => {
      const servers = await catalog.listServers();
      return { count: servers.length };
    }`,
    timeoutMs: 1_000,
    maxCodeLength: 10_000,
    globals: {
      catalog: {
        listServers: async () => [{ id: "a" }, { id: "b" }],
      },
    },
  });

  assert.deepEqual(result, { count: 2 });
});

test("runSandboxedCode enforces timeout", async () => {
  await assert.rejects(
    () =>
      runSandboxedCode({
        code: `async () => {
          await new Promise(() => {});
          return { ok: true };
        }`,
        timeoutMs: 100,
        maxCodeLength: 10_000,
        globals: {},
      }),
    /timed out/i,
  );
});
