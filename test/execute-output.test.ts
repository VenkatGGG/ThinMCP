import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExecuteOutput } from "../src/execute-output.js";

test("normalizeExecuteOutput compresses large image payloads", () => {
  const source = {
    content: [
      {
        type: "image",
        mimeType: "image/png",
        data: "a".repeat(2048),
      },
    ],
  };

  const normalized = normalizeExecuteOutput(source) as {
    content: Array<Record<string, unknown>>;
  };

  assert.equal(normalized.content.length, 1);
  assert.equal(normalized.content[0].type, "image");
  assert.equal(typeof normalized.content[0].dataPreview, "string");
  assert.equal(normalized.content[0].dataTruncated, true);
  assert.equal((normalized.content[0] as Record<string, unknown>).data, undefined);
});

test("normalizeExecuteOutput truncates huge text", () => {
  const hugeText = "x".repeat(10_000);
  const source = {
    content: [
      {
        type: "text",
        text: hugeText,
      },
    ],
  };

  const normalized = normalizeExecuteOutput(source) as {
    content: Array<Record<string, unknown>>;
  };

  const text = normalized.content[0].text as string;
  assert.ok(text.length < hugeText.length);
  assert.match(text, /truncated/);
});
