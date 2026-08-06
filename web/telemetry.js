/*
 * Agentic Application Gateway — client-side telemetry store.
 *
 * Every field recorded here is COPIED FROM A REAL RESPONSE (the FinalReport the backend returned,
 * its `trace` of AgentStep records, the HTTP status, and a client-measured round-trip). Nothing is
 * synthesized, estimated or back-filled — a dashboard that invents numbers is worse than no
 * dashboard. When a value is absent from the response it stays absent here, and the dashboard
 * renders an empty state rather than a zero.
 *
 * Scope: this browser. Records live in localStorage as a capped ring buffer, so the dashboard
 * survives reloads and logouts of the same user on the same machine. The server-side equivalent
 * (fedline.request_log + GET /v1/metrics) is the durable, org-wide source; when it is available the
 * dashboard prefers it and this store becomes the offline fallback — see `source` in dashboard.js.
 */
(() => {
  "use strict";

  const KEY = "ra.telemetry.v1";
  const BACKTEST_KEY = "ra.telemetry.backtest.v1";
  /** Ring-buffer cap. ~300 records × ~1.5 KB stays far below the ~5 MB localStorage budget. */
  const MAX_RECORDS = 300;

  /** Time ranges the dashboard filter offers. `ms: null` means "everything retained". */
  const RANGES = [
    { id: "1h", short: "1h", label: "Last hour", ms: 60 * 60 * 1000 },
    { id: "24h", short: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
    { id: "7d", short: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
    { id: "30d", short: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
    { id: "all", short: "All", label: "All recorded", ms: null },
  ];

  let cache = null; // in-memory mirror of the persisted array (ascending by ts)

  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
      cache = Array.isArray(raw) ? raw.filter((r) => r && typeof r.ts === "number") : [];
    } catch {
      cache = [];
    }
    return cache;
  }

  /**
   * Persist, shedding the oldest half if the browser rejects the write. A full quota must never
   * break the chat — telemetry is strictly secondary, so every failure path here is silent.
   */
  function save(records) {
    try {
      localStorage.setItem(KEY, JSON.stringify(records));
    } catch {
      try {
        const trimmed = records.slice(Math.floor(records.length / 2));
        cache = trimmed;
        localStorage.setItem(KEY, JSON.stringify(trimmed));
      } catch { /* give up quietly */ }
    }
  }

  const newId = () => Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

  /** Keep only the trace fields the dashboard actually charts, so stored records stay small. */
  function slimTrace(trace) {
    if (!Array.isArray(trace)) return [];
    return trace.map((s) => ({
      stage: s.stage,
      agent: s.agent,
      engine: s.engine,
      status: s.status,
      model: s.model,
      confidence: typeof s.confidence === "number" ? s.confidence : undefined,
      latencyMs: typeof s.latencyMs === "number" ? s.latencyMs : undefined,
    }));
  }

  /** Per-section row counts + use-case identity — the "what did the backends actually return" axis. */
  function slimSections(report) {
    return (report.sections || []).map((sec) => ({
      useCase: sec.useCase || sec.heading || "unknown",
      rows: Array.isArray(sec.rows) ? sec.rows.length : 0,
      endpoint: (sec.meta && sec.meta.endpoint) || undefined,
      httpMethod: (sec.meta && sec.meta.httpMethod) || undefined,
      backend: (sec.meta && (sec.meta.backendId || sec.meta.backend)) || undefined,
    }));
  }

  /** RAG provenance, when the answer came from the knowledge base. */
  function kbOf(report) {
    if (!report || report.type !== "KB") return undefined;
    const sec = (report.sections || []).find((s) => s.meta && (s.meta.retrieval !== undefined || s.meta.answer !== undefined));
    const meta = (sec && sec.meta) || {};
    return {
      retrieval: typeof meta.retrieval === "string" ? meta.retrieval : undefined,
      matched: typeof meta.matched === "number" ? meta.matched : sec && sec.rows ? sec.rows.length : 0,
      citations: Array.isArray(meta.citations) ? meta.citations.length : 0,
    };
  }

  /**
   * Build a record from one completed /v1/ask attempt.
   *
   * @param {object} o
   * @param {string} o.question       what the user asked
   * @param {number} o.latencyMs      client-measured round-trip (fetch start → body parsed)
   * @param {number} [o.httpStatus]   HTTP status, absent on a network/abort failure
   * @param {object} [o.report]       the FinalReport, when the call succeeded
   * @param {string} [o.error]        server error string or client failure reason
   * @param {string} [o.errorKind]    "http" | "network" | "timeout" | "auth"
   * @param {string} [o.traceId]
   * @param {boolean} [o.hadFile]     the request carried a file upload (gateway submit path)
   * @param {string} [o.exportFormat] a format the user explicitly asked for (pdf/excel/csv/json)
   */
  function record(o) {
    const records = load();
    const report = o.report || null;
    const trace = slimTrace(report && report.trace);
    const sections = report ? slimSections(report) : [];

    const entry = {
      id: newId(),
      ts: Date.now(),
      question: String(o.question || "").slice(0, 400),
      ok: Boolean(report),
      httpStatus: typeof o.httpStatus === "number" ? o.httpStatus : undefined,
      latencyMs: Math.max(0, Math.round(o.latencyMs || 0)),
      error: o.error ? String(o.error).slice(0, 300) : undefined,
      errorKind: o.errorKind,
      traceId: o.traceId,
      hadFile: Boolean(o.hadFile),
      exportFormat: o.exportFormat || undefined,
      // ── Report-shaped fields (present only on success) ──
      type: report ? report.type : undefined,
      reportId: report ? report.reportId : undefined,
      orchestrated: report && report.routing ? Boolean(report.routing.requiresOrchestration) : undefined,
      rows: sections.reduce((a, s) => a + s.rows, 0),
      sections,
      trace,
      kb: kbOf(report),
    };

    records.push(entry);
    // Ring buffer: oldest out first.
    while (records.length > MAX_RECORDS) records.shift();
    cache = records;
    save(records);
    listeners.forEach((fn) => { try { fn(entry); } catch { /* a bad listener must not break send() */ } });
    return entry;
  }

  const listeners = new Set();

  // ---------- Backtest: last known validation verdict ----------
  // The backtest is expensive (full mode calls the model per case), so the dashboard shows the last
  // run with its timestamp rather than firing one on every mount.
  function setBacktest(summary, mode) {
    try {
      localStorage.setItem(BACKTEST_KEY, JSON.stringify({ ranAt: Date.now(), mode, summary }));
    } catch { /* non-fatal */ }
  }
  function getBacktest() {
    try {
      const v = JSON.parse(localStorage.getItem(BACKTEST_KEY) || "null");
      return v && v.summary ? v : null;
    } catch {
      return null;
    }
  }
  /** Discard the stored verdict. Only the retained result goes — no sweep is run and no server
   *  state is touched; the card returns to its "not run yet" state. */
  function clearBacktest() {
    try { localStorage.removeItem(BACKTEST_KEY); } catch { /* non-fatal */ }
  }

  // ---------- Aggregation helpers ----------
  // Pure functions over a record array. The dashboard owns presentation; these own arithmetic.

  /** Records whose ts falls in [from, to). `from = null` means unbounded. */
  function inWindow(records, from, to) {
    return records.filter((r) => (from === null || r.ts >= from) && r.ts < to);
  }

  /** Linear-interpolated percentile over a numeric array. Returns null for an empty input. */
  function percentile(values, p) {
    const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
    if (!xs.length) return null;
    if (xs.length === 1) return xs[0];
    const idx = (xs.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
  }

  /** Count records into `key → count`, skipping undefined keys. Returns entries sorted desc. */
  function countBy(records, keyFn) {
    const m = new Map();
    for (const r of records) {
      const k = keyFn(r);
      if (k === undefined || k === null || k === "") continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
  }

  /** Sum a numeric extractor into `key → total`. Returns entries sorted desc. */
  function sumBy(records, keyFn, valFn) {
    const m = new Map();
    for (const r of records) {
      const k = keyFn(r);
      if (k === undefined || k === null || k === "") continue;
      m.set(k, (m.get(k) || 0) + (valFn(r) || 0));
    }
    return [...m.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
  }

  /**
   * Split [from, to) into `count` equal buckets and drop each record into one.
   * Bucket boundaries are derived from the range, not the data, so an empty bucket stays visible —
   * a gap in traffic is information, and collapsing it would misstate the time axis.
   */
  function bucketize(records, from, to, count) {
    const width = Math.max(1, (to - from) / count);
    const buckets = Array.from({ length: count }, (_, i) => ({
      from: from + i * width,
      to: from + (i + 1) * width,
      records: [],
    }));
    for (const r of records) {
      const i = Math.min(count - 1, Math.max(0, Math.floor((r.ts - from) / width)));
      buckets[i].records.push(r);
    }
    return buckets;
  }

  /** Every trace step across the given records, flattened. */
  const steps = (records) => records.flatMap((r) => r.trace || []);

  /** Every report section across the given records, flattened. */
  const allSections = (records) => records.flatMap((r) => r.sections || []);

  // ---------- Local aggregation ----------
  /*
   * Produces the SAME payload shape the server computes in SQL (src/shared/request-metrics.ts), so
   * the dashboard has exactly one thing to render and the choice of source changes only where the
   * arithmetic happened — never what a metric means.
   *
   * Keep these definitions in lockstep with the SQL. The load-bearing ones:
   *   · percentiles are linear-interpolated over latencyMs > 0 (percentile_cont);
   *   · a model invocation is engine 'llm' AND status 'ran';
   *   · an empty bucket has total 0 but NULL latency — no observation, so the line breaks.
   */
  const FAILURE_ROWS = 8;
  const ACTIVITY_ROWS = 40;

  const rowDigest = (r) => ({
    id: r.id, ts: r.ts, userName: r.userName ?? null, question: r.question, ok: r.ok,
    httpStatus: r.httpStatus ?? null, latencyMs: r.latencyMs, type: r.type ?? null,
    rows: r.rows || 0, error: r.error ?? null, errorKind: r.errorKind ?? null,
    steps: (r.trace || []).filter((s) => s.status === "ran").length,
    llmSteps: (r.trace || []).filter((s) => s.engine === "llm" && s.status === "ran").length,
  });

  function totalsOf(recs) {
    const lat = recs.map((r) => r.latencyMs).filter((v) => v > 0);
    const st = steps(recs);
    return {
      requests: recs.length,
      succeeded: recs.filter((r) => r.ok).length,
      failed: recs.filter((r) => !r.ok).length,
      medianMs: percentile(lat, 0.5),
      p95Ms: percentile(lat, 0.95),
      modelInvocations: st.filter((s) => s.engine === "llm" && s.status === "ran").length,
      fallbacks: st.filter((s) => s.status === "fallback").length,
      rowsReturned: recs.reduce((a, r) => a + (r.rows || 0), 0),
      orchestrated: recs.filter((r) => r.orchestrated).length,
    };
  }

  const groupSum = (items, keyFn, valFn) => {
    const m = new Map();
    for (const it of items) {
      const k = keyFn(it);
      if (k === undefined || k === null || k === "") continue;
      const cur = m.get(k) || { n: 0, sum: 0 };
      cur.n += 1;
      cur.sum += valFn ? valFn(it) || 0 : 0;
      m.set(k, cur);
    }
    return m;
  };
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  function aggregateLocal(records, win) {
    // Sort defensively: the local store appends oldest-first but a caller may hand us a newest-first
    // page. The row lists below take a tail-slice, so trusting the caller's order silently reverses
    // "most recent 40" into "oldest 40" — a wrong list that still looks plausible.
    const cur = inWindow(records, win.from, win.to).slice().sort((a, b) => a.ts - b.ts);
    const prevAvailable = win.prevFrom !== null && win.prevFrom !== undefined;
    const prevRecs = prevAvailable ? inWindow(records, win.prevFrom, win.prevTo) : [];
    // 'ran' AND 'fallback' both executed; only 'skipped' never happened. Matches the SQL.
    const executed = steps(cur).filter((s) => s.status !== "skipped");
    const secs = allSections(cur);
    const kbRecs = cur.filter((r) => r.kb);

    const series = bucketize(cur, win.from, win.to, win.buckets).map((b) => {
      const lat = b.records.map((r) => r.latencyMs).filter((v) => v > 0);
      return {
        t: b.from,
        total: b.records.length,
        ok: b.records.filter((r) => r.ok).length,
        failed: b.records.filter((r) => !r.ok).length,
        medianMs: percentile(lat, 0.5),
        p95Ms: percentile(lat, 0.95),
        rowsReturned: b.records.reduce((a, r) => a + (r.rows || 0), 0),
        modelInvocations: steps(b.records).filter((s) => s.engine === "llm" && s.status === "ran").length,
        successRate: b.records.length ? (b.records.filter((r) => r.ok).length / b.records.length) * 100 : null,
      };
    });

    const stageMap = new Map();
    for (const s of executed) {
      if (!s.stage || typeof s.latencyMs !== "number") continue;
      const e = stageMap.get(s.stage) || { ms: [], steps: 0 };
      e.steps += 1;
      e.ms.push(s.latencyMs);
      stageMap.set(s.stage, e);
    }
    const modelMap = new Map();
    for (const s of executed) {
      if (!s.model) continue;
      const e = modelMap.get(s.model) || { steps: 0, conf: [], ms: [] };
      e.steps += 1;
      if (typeof s.confidence === "number") e.conf.push(s.confidence);
      if (typeof s.latencyMs === "number") e.ms.push(s.latencyMs);
      modelMap.set(s.model, e);
    }
    const opMap = new Map();
    for (const s of secs) {
      if (!s.endpoint) continue;
      const k = `${s.httpMethod || ""} ${s.endpoint} ${s.backend || ""}`;
      const e = opMap.get(k) || { method: s.httpMethod ?? null, path: s.endpoint, backend: s.backend ?? null, calls: 0, rows: 0 };
      e.calls += 1;
      e.rows += s.rows || 0;
      opMap.set(k, e);
    }
    const useMap = groupSum(secs, (s) => s.useCase, (s) => s.rows);

    return {
      window: { from: win.from, to: win.to, prevFrom: prevAvailable ? win.prevFrom : null, prevTo: prevAvailable ? win.prevTo : null, buckets: win.buckets },
      totals: totalsOf(cur),
      // Matches the SQL: no prior window, or a prior window with nothing in it, yields no baseline
      // and the UI omits the delta rather than inventing one.
      prev: prevAvailable && prevRecs.length ? totalsOf(prevRecs) : null,
      series,
      routing: countBy(cur.filter((r) => r.ok), (r) => r.type).map((e) => ({ type: e.key, n: e.value })),
      engines: countBy(executed, (s) => s.engine).map((e) => ({ engine: e.key, steps: e.value })),
      stepsExecuted: executed.length,
      stages: [...stageMap.entries()]
        .map(([stage, v]) => ({ stage, avgMs: mean(v.ms), steps: v.steps }))
        .sort((a, b) => (b.avgMs ?? -1) - (a.avgMs ?? -1)),
      models: [...modelMap.entries()]
        .map(([model, v]) => ({ model, steps: v.steps, avgConfidence: mean(v.conf), medianMs: percentile(v.ms, 0.5) }))
        .sort((a, b) => b.steps - a.steps),
      useCases: [...useMap.entries()]
        .map(([useCase, v]) => ({ useCase, rows: v.sum, calls: v.n }))
        .sort((a, b) => b.rows - a.rows || String(a.useCase).localeCompare(String(b.useCase))),
      operations: [...opMap.values()].sort((a, b) => b.calls - a.calls || b.rows - a.rows || a.path.localeCompare(b.path)),
      kb: {
        answers: kbRecs.length,
        avgMatched: mean(kbRecs.map((r) => r.kb.matched).filter((v) => typeof v === "number")),
        avgCitations: mean(kbRecs.map((r) => r.kb.citations).filter((v) => typeof v === "number")),
        stores: countBy(kbRecs, (r) => r.kb.retrieval).map((e) => ({ store: e.key, n: e.value })),
      },
      exports: {
        formats: countBy(cur, (r) => r.exportFormat).map((e) => ({ format: e.key, n: e.value })),
        uploads: cur.filter((r) => r.hadFile).length,
      },
      failures: cur.filter((r) => !r.ok).slice(-FAILURE_ROWS).reverse().map(rowDigest),
      activity: cur.slice(-ACTIVITY_ROWS).reverse().map(rowDigest),
    };
  }

  window.Telemetry = {
    RANGES,
    MAX_RECORDS,
    record,
    all: () => load().slice(),
    clear() {
      cache = [];
      try { localStorage.removeItem(KEY); } catch { /* non-fatal */ }
    },
    onRecord(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setBacktest,
    getBacktest,
    clearBacktest,
    aggregateLocal,
    agg: { inWindow, percentile, countBy, sumBy, bucketize, steps, allSections },
  };
})();
