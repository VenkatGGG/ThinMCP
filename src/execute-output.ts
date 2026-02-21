const MAX_STRING_CHARS = 4_000;
const MAX_ARRAY_ITEMS = 40;
const MAX_OBJECT_KEYS = 60;
const MAX_DEPTH = 7;
const BINARY_PREVIEW_CHARS = 96;

export function normalizeExecuteOutput(value: unknown): unknown {
  if (!isObject(value)) {
    return normalizeUnknown(value, 0);
  }

  if (!Array.isArray(value.content)) {
    return normalizeUnknown(value, 0);
  }

  const normalizedBase = normalizeUnknown(value, 0);
  const output: Record<string, unknown> = isObject(normalizedBase)
    ? { ...normalizedBase }
    : {};

  output.content = value.content
    .slice(0, MAX_ARRAY_ITEMS)
    .map((item) => normalizeContentItem(item));

  if (value.content.length > MAX_ARRAY_ITEMS) {
    output.contentTruncated = true;
    output.contentOriginalLength = value.content.length;
  }

  if ("structuredContent" in value) {
    output.structuredContent = normalizeUnknown(value.structuredContent, 0);
  }

  return output;
}

function normalizeContentItem(value: unknown): unknown {
  if (!isObject(value)) {
    return normalizeUnknown(value, 0);
  }

  const type = value.type;
  if (type === "text") {
    return {
      type: "text",
      text: truncateString(asString(value.text), MAX_STRING_CHARS),
    };
  }

  if (type === "image" || type === "audio") {
    const data = asString(value.data);
    return {
      type,
      mimeType: asString(value.mimeType),
      dataPreview: truncateString(data, BINARY_PREVIEW_CHARS),
      estimatedBytes: estimateBase64Bytes(data),
      dataTruncated: data.length > BINARY_PREVIEW_CHARS,
    };
  }

  if (type === "resource") {
    const resource = isObject(value.resource) ? value.resource : null;
    if (!resource) {
      return normalizeUnknown(value, 0);
    }

    const text = typeof resource.text === "string" ? resource.text : undefined;
    const blob = typeof resource.blob === "string" ? resource.blob : undefined;

    return {
      type: "resource",
      resource: {
        uri: asString(resource.uri),
        mimeType: asString(resource.mimeType),
        ...(text !== undefined
          ? {
              textPreview: truncateString(text, MAX_STRING_CHARS),
              textLength: text.length,
              textTruncated: text.length > MAX_STRING_CHARS,
            }
          : {}),
        ...(blob !== undefined
          ? {
              blobPreview: truncateString(blob, BINARY_PREVIEW_CHARS),
              estimatedBytes: estimateBase64Bytes(blob),
              blobTruncated: blob.length > BINARY_PREVIEW_CHARS,
            }
          : {}),
      },
    };
  }

  if (type === "resource_link") {
    return {
      type: "resource_link",
      uri: asString(value.uri),
      name: asString(value.name),
      mimeType: asString(value.mimeType),
      description: truncateString(asString(value.description), MAX_STRING_CHARS),
    };
  }

  return normalizeUnknown(value, 0);
}

function normalizeUnknown(value: unknown, depth: number): unknown {
  if (depth >= MAX_DEPTH) {
    return "[max_depth_reached]";
  }

  if (typeof value === "string") {
    return truncateString(value, MAX_STRING_CHARS);
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    const normalized = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => normalizeUnknown(entry, depth + 1));

    if (value.length > MAX_ARRAY_ITEMS) {
      normalized.push(`[${value.length - MAX_ARRAY_ITEMS} items truncated]`);
    }

    return normalized;
  }

  if (!isObject(value)) {
    return String(value);
  }

  const output: Record<string, unknown> = {};
  const keys = Object.keys(value);
  for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
    output[key] = normalizeUnknown(value[key], depth + 1);
  }

  if (keys.length > MAX_OBJECT_KEYS) {
    output.__truncatedKeys = keys.length - MAX_OBJECT_KEYS;
  }

  return output;
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 21))}[truncated:${value.length}]`;
}

function estimateBase64Bytes(base64: string): number {
  const cleaned = base64.trim();
  if (cleaned.length === 0) {
    return 0;
  }

  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((cleaned.length * 3) / 4) - padding);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
