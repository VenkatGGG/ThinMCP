export function logInfo(message: string, details?: Record<string, unknown>): void {
  write("INFO", message, details);
}

export function logWarn(message: string, details?: Record<string, unknown>): void {
  write("WARN", message, details);
}

export function logError(message: string, details?: Record<string, unknown>): void {
  write("ERROR", message, details);
}

function write(level: string, message: string, details?: Record<string, unknown>): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(details ?? {}),
  };

  // JSON logs keep downstream parsing simple.
  console.error(JSON.stringify(payload));
}
