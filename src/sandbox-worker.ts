import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { parentPort } from "node:worker_threads";

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

interface CallMessage {
  type: "call";
  callId: string;
  fnId: string;
  args: unknown[];
}

interface CallResultMessage {
  type: "callResult";
  callId: string;
  result: unknown;
}

interface CallErrorMessage {
  type: "callError";
  callId: string;
  error: string;
}

type IncomingMessage = StartMessage | CallResultMessage | CallErrorMessage;

const port = getParentPort();

const pendingCalls = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

port.on("message", (message: IncomingMessage) => {
  if (message.type === "start") {
    void runUserCode(message);
    return;
  }

  const pending = pendingCalls.get(message.callId);
  if (!pending) {
    return;
  }

  pendingCalls.delete(message.callId);

  if (message.type === "callResult") {
    pending.resolve(message.result);
    return;
  }

  pending.reject(new Error(message.error));
});

async function runUserCode(message: StartMessage): Promise<void> {
  try {
    const code = message.code.trim();

    if (!code) {
      throw new Error("Code cannot be empty");
    }

    if (code.length > message.maxCodeLength) {
      throw new Error(
        `Code length ${code.length} exceeds maxCodeLength ${message.maxCodeLength}`,
      );
    }

    const globals = buildRuntimeGlobals(message.globals);
    const runtimeGlobals =
      globals && typeof globals === "object" && !Array.isArray(globals)
        ? (globals as Record<string, unknown>)
        : {};
    const context = vm.createContext(
      deepFreeze({
        ...runtimeGlobals,
        console: undefined,
        process: undefined,
        global: undefined,
        require: undefined,
        module: undefined,
        exports: undefined,
      }),
      {
        codeGeneration: {
          strings: false,
          wasm: false,
        },
      },
    );

    const script = new vm.Script(`(${code})`, {
      filename: "thinmcp-user-code.js",
    });

    const maybeFunction = script.runInContext(context, {
      timeout: message.timeoutMs,
    });

    if (typeof maybeFunction !== "function") {
      throw new Error(
        "Code must evaluate to an async arrow function, for example: async () => ({ ok: true })",
      );
    }

    const result = await Promise.resolve(maybeFunction());
    port.postMessage({ type: "result", result: transferSafe(result) });
  } catch (error: unknown) {
    port.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildRuntimeGlobals(value: SerializableValue): unknown {
  if (isFunctionToken(value)) {
    return async (...args: unknown[]) => invokeHost(value.__thinmcpFn, args);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => buildRuntimeGlobals(entry));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = buildRuntimeGlobals(nested);
    }

    return output;
  }

  return value;
}

function isFunctionToken(value: SerializableValue): value is SandboxFunctionToken {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "__thinmcpFn" in value
  );
}

async function invokeHost(fnId: string, args: unknown[]): Promise<unknown> {
  const callId = randomUUID();

  const pendingPromise = new Promise<unknown>((resolve, reject) => {
    pendingCalls.set(callId, { resolve, reject });
  });

  const message: CallMessage = {
    type: "call",
    callId,
    fnId,
    args: transferSafe(args) as unknown[],
  };

  port.postMessage(message);
  return pendingPromise;
}

function transferSafe(value: unknown, depth = 0): unknown {
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
    return value.map((item) => transferSafe(item, depth + 1));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = transferSafe(nested, depth + 1);
    }

    return output;
  }

  return String(value);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const key of Object.getOwnPropertyNames(value)) {
    const nested = (value as Record<string, unknown>)[key];
    deepFreeze(nested);
  }

  return value;
}

function getParentPort() {
  if (!parentPort) {
    throw new Error("Sandbox worker must run with a parent port");
  }

  return parentPort;
}
