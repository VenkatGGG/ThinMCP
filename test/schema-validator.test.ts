import test from "node:test";
import assert from "node:assert/strict";
import { ToolInputValidator } from "../src/schema-validator.js";
import type { ToolRecord } from "../src/catalog-store.js";

function toolWithSchema(): ToolRecord {
  return {
    serverId: "cloudflare",
    serverName: "Cloudflare",
    serverUrl: "https://mcp.cloudflare.com/mcp",
    toolName: "zones.list",
    title: "List zones",
    description: "Lists zones",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
      },
      required: ["account_id"],
      additionalProperties: false,
    },
    outputSchema: null,
    annotations: null,
    snapshotHash: "abc123",
  };
}

test("ToolInputValidator accepts valid arguments", () => {
  const validator = new ToolInputValidator();
  const tool = toolWithSchema();

  assert.doesNotThrow(() => {
    validator.validate(tool, { account_id: "acct-1" });
  });
});

test("ToolInputValidator rejects invalid arguments", () => {
  const validator = new ToolInputValidator();
  const tool = toolWithSchema();

  assert.throws(
    () => {
      validator.validate(tool, {});
    },
    (error: unknown) => {
      assert.match(String(error), /account_id/);
      return true;
    },
  );
});
