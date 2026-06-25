/**
 * Helper for reading Bedrock Flow *Lambda node* inputs.
 *
 * A flow Lambda node may deliver its mapped inputs as an `inputs: [{ name, type, value }]`
 * array (named multi-input nodes) or, in some paths, as the single mapped value directly.
 * This helper normalises both so handlers can ask for a named input and fall back to the
 * single value. Keeping it here means the analytics/report/dispatch nodes share one contract.
 */
export interface FlowInputs {
  /** Value of a named node input, or undefined if not present. */
  get(name: string): unknown;
  /** The single/primary input value (for single-input nodes). */
  single<T = unknown>(): T;
}

export function readFlowInputs(event: unknown): FlowInputs {
  const e = (event ?? {}) as Record<string, unknown>;
  const map: Record<string, unknown> = {};
  let single: unknown = e;

  if (Array.isArray(e.inputs)) {
    for (const item of e.inputs as Array<Record<string, unknown>>) {
      if (item && typeof item.name === "string") map[item.name] = item.value;
    }
    const vals = Object.values(map);
    single = vals.length === 1 ? vals[0] : map;
  } else {
    // Direct delivery: the value may be the event itself or wrapped.
    single = e.document ?? e.input ?? e;
  }

  return {
    get: (name: string) => (name in map ? map[name] : undefined),
    single: <T = unknown>() => single as T,
  };
}
