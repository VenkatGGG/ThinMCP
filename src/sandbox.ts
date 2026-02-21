import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export interface SandboxOptions {
  code: string;
  timeoutMs: number;
  maxCodeLength: number;
  globals: Record<string, unknown>;
}

interface SandboxFunctionToken {
  __thinmcpFn: string;
}

type SerializableValue =
  | null
  | string
  | number
  | boolean
  | SerializableValue[]
  | { [key: string]: SerializableValue }
  | SandboxFunctionToken;

interface StartMessage {
  type: "start";
  code: string;
  timeoutMs: number;
  maxCodeLength: number;
  globals: SerializableValue;
}

interface HostCallMessage {
  type: "call";
  callId: string;
  fnId: string;
  args: unknown[];
}

interface HostCallResultMessage {
  type: "callResult";
  callId: string;
  result: unknown;
}

interface HostCallErrorMessage {
  type: "callError";
  callId: string;
  error: string;
}

interface WorkerResultMessage {
  type: "result";
  result: unknown;
}

interface WorkerErrorMessage {
  type: "error";
  error: string;
}

type WorkerMessage =
  | HostCallMessage
  | WorkerResultMessage
  | WorkerErrorMessage;

export async function runSandboxedCode<T>(options: SandboxOptions): Promise<T> {
  const code = options.code.trim();

  if (!code) {
    throw new Error("Code cannot be empty");
  }

  if (code.length > options.maxCodeLength) {
    throw new Error(
      `Code length ${code.length} exceeds maxCodeLength ${options.maxCodeLength}`,
    );
  }

  const functionRegistry = new Map<string, (...args: unknown[]) => unknown>();
  const serializedGlobals = serializeValue(options.globals, [], functionRegistry);
  const workerPath = resolveWorkerPath();

  return new Promise<T>((resolve, reject) => {
    let completed = false;

    const worker = new Worker(workerPath, {
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
      ...(workerPath.endsWith(".ts") ? { execArgv: ["--import", "tsx"] } : {}),
    });

    const timeoutHandle = setTimeout(() => {
      finishWithError(
        new Error(`Code execution timed out after ${options.timeoutMs}ms`),
      );
    }, options.timeoutMs + 25);

    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "call") {
        void handleHostCall(worker, functionRegistry, message);
        return;
      }

      if (message.type === "result") {
        finishWithResult(message.result as T);
        return;
      }

      if (message.type === "error") {
        finishWithError(new Error(message.error));
      }
    });

    worker.on("error", (error) => {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      finishWithError(wrapped);
    });

    worker.on("exit", (code) => {
      if (!completed && code !== 0) {
        finishWithError(new Error(`Sandbox worker exited with code ${code}`));
      }
    });

    const startMessage: StartMessage = {
      type: "start",
      code,
      timeoutMs: options.timeoutMs,
      maxCodeLength: options.maxCodeLength,
      globals: serializedGlobals,
    };

    worker.postMessage(startMessage);

    function finishWithResult(value: T): void {
      if (completed) {
        return;
      }

      completed = true;
      clearTimeout(timeoutHandle);
      void worker.terminate();
      resolve(value);
    }

    function finishWithError(error: Error): void {
      if (completed) {
        return;
      }

      completed = true;
      clearTimeout(timeoutHandle);
      void worker.terminate();
      reject(error);
    }
  });
}

export function serializeWithLimit(value: unknown, maxChars: number): string {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized.length <= maxChars) {
    return serialized;
  }

  const suffix = `\n... [truncated to ${maxChars} chars]`;
  return serialized.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

async function handleHostCall(
  worker: Worker,
  registry: Map<string, (...args: unknown[]) => unknown>,
  message: HostCallMessage,
): Promise<void> {
  const fn = registry.get(message.fnId);
  if (!fn) {
    const payload: HostCallErrorMessage = {
      type: "callError",
      callId: message.callId,
      error: `Unknown host function id '${message.fnId}'`,
    };
    worker.postMessage(payload);
    return;
  }

  try {
    const value = await Promise.resolve(fn(...message.args));
    const payload: HostCallResultMessage = {
      type: "callResult",
      callId: message.callId,
      result: cloneSafe(value),
    };
    worker.postMessage(payload);
  } catch (error: unknown) {
    const payload: HostCallErrorMessage = {
      type: "callError",
      callId: message.callId,
      error: error instanceof Error ? error.message : String(error),
    };
    worker.postMessage(payload);
  }
}

function serializeValue(
  value: unknown,
  pathParts: string[],
  registry: Map<string, (...args: unknown[]) => unknown>,
): SerializableValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "function") {
    const fnId = pathParts.join(".") || "root";
    registry.set(fnId, value as (...args: unknown[]) => unknown);
    return { __thinmcpFn: fnId };
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      serializeValue(item, [...pathParts, String(index)], registry),
    );
  }

  if (!value || typeof value !== "object") {
    return String(value);
  }

  const output: Record<string, SerializableValue> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = serializeValue(nested, [...pathParts, key], registry);
  }

  return output;
}

function cloneSafe(value: unknown, depth = 0): unknown {
  if (depth >= 8) {
    return "[max_depth_reached]";
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => cloneSafe(item, depth + 1));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = cloneSafe(nested, depth + 1);
    }
    return output;
  }

  return String(value);
}

function resolveWorkerPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const ext = path.extname(thisFile);
  const workerFile = `sandbox-worker${ext}`;
  return fileURLToPath(new URL(`./${workerFile}`, import.meta.url));
}
