/** Minimal structured logger — JSON lines, level-gated, CloudWatch friendly. */
type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return ORDER[lvl] ?? ORDER.info;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(level: Level, base: Record<string, unknown>, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...base, ...fields });
  // eslint-disable-next-line no-console
  (level === "error" ? console.error : console.log)(line);
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, f) => emit("debug", bindings, m, f),
    info: (m, f) => emit("info", bindings, m, f),
    warn: (m, f) => emit("warn", bindings, m, f),
    error: (m, f) => emit("error", bindings, m, f),
    child: (b) => createLogger({ ...bindings, ...b }),
  };
}
