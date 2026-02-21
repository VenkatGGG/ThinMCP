import vm from "node:vm";

export interface SandboxOptions {
  code: string;
  timeoutMs: number;
  maxCodeLength: number;
  globals: Record<string, unknown>;
}

export async function runSandboxedCode<T>(
  options: SandboxOptions,
): Promise<T> {
  const code = options.code.trim();

  if (!code) {
    throw new Error("Code cannot be empty");
  }

  if (code.length > options.maxCodeLength) {
    throw new Error(
      `Code length ${code.length} exceeds maxCodeLength ${options.maxCodeLength}`,
    );
  }

  const context = vm.createContext(
    Object.freeze({
      ...options.globals,
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
    timeout: options.timeoutMs,
  });

  if (typeof maybeFunction !== "function") {
    throw new Error(
      "Code must evaluate to an async arrow function, for example: async () => ({ ok: true })",
    );
  }

  const result = await withTimeout(
    Promise.resolve(maybeFunction()),
    options.timeoutMs,
  );

  return result as T;
}

export function serializeWithLimit(
  value: unknown,
  maxChars: number,
): string {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized.length <= maxChars) {
    return serialized;
  }

  const suffix = `\n... [truncated to ${maxChars} chars]`;
  return serialized.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Code execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
