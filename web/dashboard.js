/*
 * Agentic Application Gateway — operations dashboard.
 *
 * A second view alongside the chat, built from the telemetry the chat records (see telemetry.js).
 * Every number on this page is derived from a real /v1/ask response or a real /v1/backtest run;
 * when there is nothing to show the card says so instead of drawing a zero.
 *
 * Structure: one filter row scopes the whole page (never per-card filters), then a hero + KPI row,
 * then four sections — agent operations, backends & reports, health & validation, live activity.
 * Every chart card ships a table-view twin, so no value is reachable only by hovering.
 */
(() => {
  "use strict";

  const C = window.Charts;
  const T = window.Telemetry;
  const h = C.h;

  /** Wired by app.js — the dashboard never touches the session or the endpoint directly. */
  let bridge = null;
  let root = null;
  let rangeId = "24h";
  let visible = false;
  let backtestBusy = false;
  let backtestMode = "data"; // "data" (table checks only) | "full" (adds routing + grounding)
  let backtestError = null;
  let resizeTimer = 0;

  // ---------- Data source ----------
  // Two producers of ONE payload shape (see src/shared/request-metrics.ts and the mirror in
  // telemetry.js `aggregateLocal`):
  //   · server — Postgres aggregates fedline.request_log in SQL over the WHOLE window;
  //   · local  — this browser's own records, aggregated in JS with the same definitions.
  // The server is preferred and the fallback is silent in behaviour but never in labelling — the
  // badge in the filter row always names the source actually in use, because the two answer
  // different questions (a deployment vs one browser) and must never be conflated.
  //
  // The dashboard no longer pulls raw rows to add up itself. That capped every KPI at the fetch
  // limit, so a "requests in range" of 2000 could really mean "2000 and we stopped counting".
  let sourceMode = "auto"; // "auto" | "server" | "local"
  let dataset = { source: "local", metrics: null, note: null };
  let loading = false;

  /** Server latency is server-side processing; local latency is the caller's whole round trip. */
  const latencySubtitle = () =>
    dataset.source === "server"
      ? "Server processing time — median and 95th percentile"
      : "Client-measured round trip — median and 95th percentile";

  /** The window the UI is asking about. The payload echoes back the window actually served. */
  function requestedWindow() {
    const to = Date.now();
    const range = T.RANGES.find((r) => r.id === rangeId) || T.RANGES[1];
    const buckets = BUCKETS[rangeId] || 12;
    if (range.ms === null) {
      // "All recorded": locally that means back to the oldest record we hold; the server clamps to
      // its own retention and tells us what it used.
      const recs = T.all();
      const first = recs.length ? recs[0].ts : to - 60 * 60 * 1000;
      const from = Math.min(first, to - 60 * 1000);
      return { from, to, prevFrom: null, prevTo: null, buckets, rangeMs: MAX_SERVER_RANGE_MS };
    }
    return { from: to - range.ms, to, prevFrom: to - 2 * range.ms, prevTo: to - range.ms, buckets, rangeMs: range.ms };
  }

  const localMetrics = (win) => T.aggregateLocal(T.all(), win);

  async function loadData() {
    const win = requestedWindow();
    if (sourceMode === "local") {
      dataset = { source: "local", metrics: localMetrics(win), note: null };
      return;
    }
    try {
      loading = true;
      // Ask for aggregates, not rows: the database does the arithmetic over every matching row.
      const res = await bridge.fetchMetrics({ rangeMs: win.rangeMs, buckets: win.buckets });
      if (res && res.ok && res.source === "postgres" && res.totals && res.window) {
        dataset = { source: "server", metrics: res, note: null };
        return;
      }
      dataset = {
        source: "local",
        metrics: localMetrics(win),
        note: sourceMode === "server" ? "The deployment-wide request log is not available on this deployment." : null,
      };
    } catch (err) {
      dataset = {
        source: "local",
        metrics: localMetrics(win),
        note: "Could not reach the request log — showing this browser's own records. " + (err && err.message ? err.message : ""),
      };
    } finally {
      loading = false;
    }
  }

  /** Reload from the active source, then repaint. */
  async function refresh() {
    if (!visible) return;
    await loadData();
    render();
  }

  // ---------- Design tokens ----------
  // Resolved from CSS custom properties at render time so light/dark (and any future theme) swap in
  // one place. Charts receive concrete hex; chrome and text are styled by class.
  function tokens() {
    const cs = getComputedStyle(root);
    const v = (name) => cs.getPropertyValue(name).trim();
    return {
      s1: v("--viz-1"), s2: v("--viz-2"), s3: v("--viz-3"),
      good: v("--viz-good"), warning: v("--viz-warning"), serious: v("--viz-serious"), critical: v("--viz-critical"),
      track: v("--viz-track"), muted: v("--viz-muted"), surface: v("--viz-surface"),
    };
  }

  // ---------- Layout constants (mirror dashboard.css) ----------
  const MIN_CARD = 340; // .dash-grid minmax floor
  const GRID_GAP = 16;  // .dash-grid gap
  const CARD_PAD = 34;  // .dash-card horizontal padding, both sides

  // ---------- Time window ----------
  /** Bucket counts chosen so each bucket is a round-ish unit and labels never crowd. */
  const BUCKETS = { "1h": 12, "24h": 12, "7d": 14, "30d": 15, all: 12 };
  /** Mirrors MAX_RANGE_MS in the telemetry Lambda — the widest window the server will serve. */
  const MAX_SERVER_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

  const two = (n) => String(n).padStart(2, "0");
  function bucketLabel(ts, spanMs) {
    const d = new Date(ts);
    if (spanMs <= 36 * 60 * 60 * 1000) return `${two(d.getHours())}:${two(d.getMinutes())}`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  const stamp = (ts) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  function ago(ts) {
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return secs + "s ago";
    if (secs < 3600) return Math.round(secs / 60) + "m ago";
    if (secs < 86400) return Math.round(secs / 3600) + "h ago";
    return Math.round(secs / 86400) + "d ago";
  }

  // ---------- Card shell ----------
  /**
   * @param {object} o
   * @param {string} o.title · @param {string} [o.subtitle]
   * @param {Node|null} o.body      the chart (or null → empty state)
   * @param {Node} [o.legend]
   * @param {()=>Node} [o.table]    the table-view twin; adds the Chart/Table toggle
   * @param {string} [o.empty]      empty-state copy used when `body` is null
   * @param {string} [o.span]       "wide" to span the grid
   */
  function card(o) {
    const bodyWrap = h("div", { class: "dash-card-body" });
    const hasData = Boolean(o.body);
    if (hasData) {
      bodyWrap.appendChild(o.body);
      if (o.legend) bodyWrap.appendChild(o.legend);
    } else {
      bodyWrap.appendChild(h("div", { class: "dash-empty", text: o.empty || "No data in this range yet." }));
    }

    const head = h("div", { class: "dash-card-head" }, [
      h("div", {}, [
        h("h4", { class: "dash-card-title", text: o.title }),
        o.subtitle ? h("p", { class: "dash-card-sub", text: o.subtitle }) : null,
      ]),
    ]);

    if (hasData && o.table) {
      let showingTable = false;
      const toggle = h("button", {
        class: "dash-toggle", type: "button", text: "Table",
        title: "Switch between the chart and its table view",
        onclick: () => {
          showingTable = !showingTable;
          bodyWrap.replaceChildren(showingTable ? o.table() : o.body);
          if (!showingTable && o.legend) bodyWrap.appendChild(o.legend);
          toggle.textContent = showingTable ? "Chart" : "Table";
          toggle.classList.toggle("active", showingTable);
        },
      });
      head.appendChild(toggle);
    }

    return h("section", { class: "dash-card" + (o.span === "wide" ? " wide" : "") }, [head, bodyWrap]);
  }

  /** Stat tile: label · value · optional signed delta vs the previous period · optional sparkline. */
  function statTile(o) {
    const parts = [
      h("div", { class: "stat-label", text: o.label }),
      h("div", { class: "stat-value", text: o.value }),
    ];
    const foot = h("div", { class: "stat-foot" });
    if (o.delta !== null && o.delta !== undefined && Number.isFinite(o.delta)) {
      const up = o.delta > 0;
      const flat = Math.abs(o.delta) < 0.05;
      // Direction × whether up is good decides the color; the arrow glyph carries it too, so the
      // meaning never rests on color alone.
      const kind = flat ? "flat" : (up === Boolean(o.upIsGood) ? "good" : "bad");
      foot.appendChild(h("span", { class: "stat-delta " + kind }, [
        h("span", { class: "stat-arrow", text: flat ? "→" : up ? "↑" : "↓" }),
        h("span", { text: (flat ? "" : (up ? "+" : "−")) + o.deltaText }),
      ]));
      foot.appendChild(h("span", { class: "stat-delta-note", text: "vs previous period" }));
    } else if (o.note) {
      foot.appendChild(h("span", { class: "stat-delta-note", text: o.note }));
    }
    parts.push(foot);
    const tile = h("div", { class: "stat-tile" }, parts);
    if (o.spark) tile.appendChild(o.spark);
    return tile;
  }

  // ---------- Sections ----------
  /*
   * Everything below renders a MetricsPayload — the aggregates, already computed. There is no
   * summarize()/bucketize() step here any more: the arithmetic happens once, in whichever producer
   * owns the data, and the view only formats it.
   */
  const succRate = (t) => (t && t.requests ? (t.succeeded / t.requests) * 100 : null);

  function heroRow(M, tk, width) {
    const cur = M.totals;
    const prev = M.prev;
    const spark = (vals, accent) => C.sparkline({ values: vals, accent, width: 104, height: 26 });
    const col = (key) => M.series.map((b) => b[key] ?? 0);
    const delta = (a, b) => (prev === null || b === null || b === undefined || !Number.isFinite(b) || b === 0 ? null : ((a - b) / b) * 100);
    const curRate = succRate(cur);
    const prevRate = succRate(prev);

    const hero = h("div", { class: "dash-hero" }, [
      h("div", { class: "hero-block" }, [
        h("div", { class: "hero-label", text: "Requests in range" }),
        h("div", { class: "hero-figure", text: cur.requests.toLocaleString() }),
        h("div", { class: "hero-note", text: cur.requests ? `${cur.succeeded.toLocaleString()} succeeded · ${cur.failed.toLocaleString()} failed` : "No requests recorded in this range" }),
      ]),
      spark(col("total"), tk.s1),
    ]);

    const tiles = h("div", { class: "stat-row" }, [
      statTile({
        label: "Success rate",
        value: curRate === null ? "—" : C.pct(curRate, curRate % 1 ? 1 : 0),
        delta: curRate !== null && prevRate !== null ? curRate - prevRate : null,
        deltaText: curRate !== null && prevRate !== null ? Math.abs(curRate - prevRate).toFixed(1) + " pts" : "",
        upIsGood: true,
        note: prev === null ? "no comparable prior window" : undefined,
        spark: spark(M.series.map((b) => b.successRate ?? 0), tk.s1),
      }),
      statTile({
        label: "Median response",
        value: C.ms(cur.medianMs),
        delta: delta(cur.medianMs || 0, prev ? prev.medianMs : null),
        deltaText: Math.abs(delta(cur.medianMs || 0, prev ? prev.medianMs : null) || 0).toFixed(0) + "%",
        upIsGood: false,
        note: prev === null ? (dataset.source === "server" ? "server processing time" : "client-measured round trip") : undefined,
        spark: spark(M.series.map((b) => b.medianMs ?? 0), tk.s1),
      }),
      statTile({
        label: "95th percentile",
        value: C.ms(cur.p95Ms),
        delta: delta(cur.p95Ms || 0, prev ? prev.p95Ms : null),
        deltaText: Math.abs(delta(cur.p95Ms || 0, prev ? prev.p95Ms : null) || 0).toFixed(0) + "%",
        upIsGood: false,
        note: prev === null ? "slowest 1 in 20 requests" : undefined,
        spark: spark(M.series.map((b) => b.p95Ms ?? 0), tk.s1),
      }),
      statTile({
        label: "Model invocations",
        value: C.compact(cur.modelInvocations),
        delta: delta(cur.modelInvocations, prev ? prev.modelInvocations : null),
        deltaText: Math.abs(delta(cur.modelInvocations, prev ? prev.modelInvocations : null) || 0).toFixed(0) + "%",
        upIsGood: true,
        note: prev === null ? "agent steps that really called a model" : undefined,
        spark: spark(col("modelInvocations"), tk.s1),
      }),
      statTile({
        label: "Rows returned",
        value: C.compact(cur.rowsReturned),
        delta: delta(cur.rowsReturned, prev ? prev.rowsReturned : null),
        deltaText: Math.abs(delta(cur.rowsReturned, prev ? prev.rowsReturned : null) || 0).toFixed(0) + "%",
        upIsGood: true,
        note: prev === null ? "across every report section" : undefined,
        spark: spark(col("rowsReturned"), tk.s1),
      }),
    ]);

    return h("div", { class: "dash-top" }, [hero, tiles]);
  }

  function opsSection(M, tk, w) {
    const win = M.window;
    const span = win.to - win.from;
    const has = M.totals.requests > 0;

    // ── Request volume: succeeded vs failed per bucket. "Failed" is a state, not an identity, so it
    //    wears the critical status color rather than a categorical slot.
    const volBuckets = M.series.map((b) => ({
      label: bucketLabel(b.t, span),
      segments: [
        { name: "Succeeded", color: tk.s1, value: b.ok },
        { name: "Failed", color: tk.critical, value: b.failed },
      ],
    }));
    const volume = card({
      title: "Request volume",
      subtitle: "Every /v1/ask attempt, bucketed over the selected range",
      body: has ? C.columns({ width: w, height: 190, buckets: volBuckets }) : null,
      legend: C.legend([{ name: "Succeeded", color: tk.s1 }, { name: "Failed", color: tk.critical }]),
      empty: "No requests recorded in this range. Ask something in Chat and it appears here.",
      table: () => C.table(
        [{ key: "t", label: "Bucket" }, { key: "ok", label: "Succeeded", num: true }, { key: "failed", label: "Failed", num: true }],
        M.series.map((b) => ({ t: stamp(b.t), ok: b.ok, failed: b.failed })),
      ),
    });

    // ── Response time: p50 and p95 on ONE axis (both are milliseconds, so they share a scale).
    //    A bucket with no timed request contributes null, which the line renders as a gap.
    const pts = (key) => M.series.map((b) => ({ x: b.t, y: b[key] }));
    const latency = card({
      title: "Response time",
      subtitle: latencySubtitle(),
      body: has
        ? C.line({
            width: w, height: 190,
            series: [
              { name: "Median", color: tk.s1, points: pts("medianMs") },
              { name: "95th percentile", color: tk.s2, points: pts("p95Ms") },
            ],
            xTicks: [
              { x: win.from, label: bucketLabel(win.from, span) },
              { x: win.from + span / 2, label: bucketLabel(win.from + span / 2, span) },
              { x: win.to, label: bucketLabel(win.to, span) },
            ],
            yFmt: (v) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "s" : Math.round(v) + "ms"),
            xFmt: (x) => stamp(x),
          })
        : null,
      legend: C.legend([{ name: "Median", color: tk.s1 }, { name: "95th percentile", color: tk.s2 }]),
      empty: "No timing samples in this range.",
      table: () => C.table(
        [{ key: "t", label: "Bucket" }, { key: "p50", label: "Median", num: true }, { key: "p95", label: "95th pct", num: true }, { key: "n", label: "Requests", num: true }],
        M.series.map((b) => ({
          t: stamp(b.t),
          p50: b.medianMs === null ? "—" : C.ms(b.medianMs),
          p95: b.p95Ms === null ? "—" : C.ms(b.p95Ms),
          n: b.total,
        })),
      ),
    });

    // ── Routing: which collaborator the supervisor picked. One series → one color for every bar.
    const routing = card({
      title: "Routing by agent type",
      subtitle: "Which collaborator the supervisor selected",
      body: M.routing.length ? C.bars({ width: w, items: M.routing.map((e) => ({ label: e.type, value: e.n })), color: tk.s1, seriesName: "requests" }) : null,
      empty: "No successful routes in this range.",
      table: () => C.table([{ key: "type", label: "Agent type" }, { key: "n", label: "Requests", num: true }], M.routing),
    });

    // ── Engine mix: of the steps that actually executed, how many were a model call vs deterministic
    //    code vs the HTTP proxy. This is the evidence the path is genuinely agent-driven.
    const engineMeta = {
      llm: { name: "Model call", color: tk.s1 },
      deterministic: { name: "Deterministic", color: tk.s2 },
      proxy: { name: "HTTP proxy", color: tk.s3 },
    };
    const engineSegs = ["llm", "deterministic", "proxy"]
      .map((key) => {
        const found = M.engines.find((e) => e.engine === key);
        return { name: engineMeta[key].name, color: engineMeta[key].color, value: found ? found.steps : 0 };
      })
      .filter((sg) => sg.value > 0);
    const executed = M.stepsExecuted || 0;
    const engineBody = engineSegs.length
      ? h("div", { class: "dash-stack-block" }, [
          h("div", { class: "dash-stack-total", text: `${executed.toLocaleString()} steps executed` }),
          C.stack({ width: w, height: 16, segments: engineSegs }),
          h("div", { class: "dash-stack-note", text: M.totals.fallbacks ? `${M.totals.fallbacks} step(s) fell back to deterministic after a model failure.` : "No step fell back to deterministic." }),
        ])
      : null;
    const engines = card({
      title: "Execution engine mix",
      subtitle: "How each recorded step was executed",
      body: engineBody,
      legend: C.legend(engineSegs.map((sg) => ({ name: sg.name, color: sg.color }))),
      empty: "No execution steps recorded in this range.",
      table: () => C.table(
        [{ key: "name", label: "Engine" }, { key: "value", label: "Steps", num: true }, { key: "share", label: "Share", num: true }],
        engineSegs.map((sg) => ({ name: sg.name, value: sg.value, share: executed ? C.pct((sg.value / executed) * 100) : "—" })),
      ),
    });

    // ── Where the time goes, per pipeline stage.
    const stageItems = M.stages
      .filter((st) => typeof st.avgMs === "number")
      .map((st) => ({ label: st.stage, value: Math.round(st.avgMs), note: `${st.steps} step(s)` }));
    const stages = card({
      title: "Average latency by stage",
      subtitle: "Server-reported step time — route, gateway, dispatch, analytics, report",
      body: stageItems.length ? C.bars({ width: w, items: stageItems, color: tk.s1, valueFmt: C.ms, seriesName: "avg" }) : null,
      empty: "No per-step timings in this range.",
      table: () => C.table(
        [{ key: "label", label: "Stage" }, { key: "value", label: "Average", num: true }, { key: "note", label: "Detail" }],
        stageItems.map((i) => ({ ...i, value: C.ms(i.value) })),
      ),
    });

    // ── Model usage. Model ids are long identifiers — a table reads them better than any chart.
    const modelRows = M.models.map((m) => ({
      model: m.model,
      calls: m.steps,
      conf: m.avgConfidence === null ? "—" : C.pct(m.avgConfidence * 100),
      lat: m.medianMs === null ? "—" : C.ms(m.medianMs),
    }));
    const models = card({
      title: "Foundation model usage",
      subtitle: "Steps whose engine reported a model id",
      body: modelRows.length
        ? C.table(
            [{ key: "model", label: "Model" }, { key: "calls", label: "Steps", num: true }, { key: "conf", label: "Avg confidence", num: true }, { key: "lat", label: "Median step", num: true }],
            modelRows,
          )
        : null,
      empty: "No model-backed steps in this range — the deterministic path handled every request.",
    });

    return [volume, latency, routing, engines, stages, models];
  }

  function backendSection(M, tk, w) {
    const rowsCard = card({
      title: "Rows returned by use case",
      subtitle: "Volume each backend operation actually produced",
      body: M.useCases.length
        ? C.bars({ width: w, items: M.useCases.map((e) => ({ label: e.useCase, value: Number(e.rows) })), color: tk.s1, seriesName: "rows" })
        : null,
      empty: "No report sections in this range.",
      table: () => C.table(
        [{ key: "useCase", label: "Use case" }, { key: "rows", label: "Rows", num: true }, { key: "calls", label: "Calls", num: true }],
        M.useCases.map((e) => ({ ...e, rows: Number(e.rows) })),
      ),
    });

    const epRows = M.operations.map((o) => ({
      endpoint: `${o.method || "GET"} ${o.path}`,
      backend: o.backend || "—",
      calls: o.calls,
      rows: Number(o.rows),
    }));
    const endpoints = card({
      title: "Backend operations called",
      subtitle: "The concrete HTTP operation behind each section",
      body: epRows.length
        ? C.table(
            [{ key: "endpoint", label: "Operation", mono: true }, { key: "backend", label: "Backend" }, { key: "calls", label: "Calls", num: true }, { key: "rows", label: "Rows", num: true }],
            epRows,
          )
        : null,
      empty: "No responses carried endpoint metadata in this range.",
      span: "wide",
    });

    // ── Knowledge base (RAG): how often retrieval answered, and from where.
    const storeMeta = { postgres: { name: "pgvector", color: tk.s1 }, memory: { name: "In-code corpus", color: tk.s2 } };
    const retrievalSegs = M.kb.stores.map((st) => ({
      name: (storeMeta[st.store] && storeMeta[st.store].name) || st.store,
      color: (storeMeta[st.store] && storeMeta[st.store].color) || tk.s3,
      value: st.n,
    }));
    const kbBody = M.kb.answers
      ? h("div", { class: "dash-stack-block" }, [
          h("div", { class: "dash-kv-row" }, [
            h("div", { class: "dash-kv" }, [h("span", { class: "kv-v", text: String(M.kb.answers) }), h("span", { class: "kv-k", text: "RAG answers" })]),
            h("div", { class: "dash-kv" }, [h("span", { class: "kv-v", text: M.kb.avgMatched === null ? "—" : Number(M.kb.avgMatched).toFixed(1) }), h("span", { class: "kv-k", text: "avg passages" })]),
            h("div", { class: "dash-kv" }, [h("span", { class: "kv-v", text: C.pct((M.kb.answers / Math.max(1, M.totals.requests)) * 100) }), h("span", { class: "kv-k", text: "of all requests" })]),
          ]),
          // A one-segment bar carries no comparison and gets no legend (a single series never does),
          // which would leave the store unnamed — say it in words instead.
          retrievalSegs.length > 1 ? C.stack({ width: w, height: 14, segments: retrievalSegs }) : null,
          retrievalSegs.length === 1
            ? h("div", { class: "dash-stack-note" }, [
                h("span", { class: "viz-legend-swatch", style: `background:${retrievalSegs[0].color};display:inline-block;margin-right:6px` }),
                h("span", { text: `All ${retrievalSegs[0].value} answer(s) served by ${retrievalSegs[0].name}.` }),
              ])
            : null,
        ])
      : null;
    const kb = card({
      title: "Knowledge base retrieval",
      subtitle: "Requests answered from the vector store, and which store served them",
      body: kbBody,
      legend: retrievalSegs.length > 1 ? C.legend(retrievalSegs.map((sg) => ({ name: sg.name, color: sg.color }))) : null,
      empty: "No knowledge-base answers in this range.",
    });

    // The requested export FORMAT is a browser-side signal (the download happens in the client), so
    // it is absent from server records. Say so rather than letting an empty chart imply zero exports.
    const formats = M.exports.formats;
    const uploads = M.exports.uploads;
    const onServer = dataset.source === "server";
    const exportCard = card({
      title: "Export & upload activity",
      subtitle: "Explicit format requests and gateway file submissions",
      body: formats.length || uploads
        ? h("div", { class: "dash-stack-block" }, [
            formats.length ? C.bars({ width: w, items: formats.map((e) => ({ label: String(e.format).toUpperCase(), value: e.n })), color: tk.s1, seriesName: "exports" }) : null,
            h("div", { class: "dash-stack-note", text: `${uploads} request(s) carried a file upload.` }),
            onServer && !formats.length
              ? h("div", { class: "dash-stack-note", text: "Export formats are recorded by the browser only — switch the source to “This browser” to see them." })
              : null,
          ])
        : null,
      empty: onServer
        ? "No uploads in this range. Export formats are recorded by the browser only — switch the source to “This browser” to see them."
        : "No exports or uploads in this range.",
      table: () => C.table([{ key: "format", label: "Format" }, { key: "n", label: "Requests", num: true }], formats),
    });

    return [rowsCard, kb, exportCard, endpoints];
  }

  // ---------- Health & validation ----------
  // ---------- Fedline response validation ----------
  // The sweep replays every registered Fedline operation through the backend's real dispatch path.
  // Moved here from a modal: it is an operations concern, and its verdict belongs beside the other
  // health cards rather than behind a dialog. app.js still owns the call (it holds the token).
  // The four counters map 1:1 to the failure kinds the SERVER classifies (shared/backtest/types.ts) —
  // nothing is re-derived or re-labelled on this side.
  function countPill(label, value, kind) {
    return h("div", { class: "bt-count" + (value > 0 ? " bt-count-hit bt-" + kind : "") }, [
      h("div", { class: "bt-count-value", text: String(value) }),
      h("div", { class: "bt-count-label", text: label }),
    ]);
  }

  function renderCheck(check) {
    const status = check.status || "pass";
    const row = h("div", { class: "bt-check bt-check-" + status });
    row.appendChild(h("span", { class: "bt-check-status", text: status === "pass" ? "✓" : status === "skip" ? "–" : "✕" }));
    const text = h("div", { class: "bt-check-text" }, [
      h("div", { class: "bt-check-id", text: check.id }),
      h("div", { class: "bt-check-detail", text: check.detail || "" }),
    ]);
    if (check.failureKind) {
      text.appendChild(h("span", { class: "bt-kind bt-" + check.failureKind, text: check.failureKind.replace(/_/g, " ") }));
    }
    row.appendChild(text);
    return row;
  }

  function renderCase(c) {
    const failed = (c.checks || []).filter((k) => k.status === "fail");
    const skipped = (c.checks || []).filter((k) => k.status === "skip");
    const details = h("details", { class: "bt-case bt-case-" + c.status });
    // Anything that is not a clean pass opens by default — failures should never need a click to see.
    if (c.status !== "pass") details.open = true;

    const meta = [
      c.rowCount + " row" + (c.rowCount === 1 ? "" : "s"),
      (c.checks || []).length + " checks",
      failed.length + " failed",
    ];
    if (skipped.length) meta.push(skipped.length + " skipped");
    if (typeof c.latencyMs === "number") meta.push(c.latencyMs + " ms");

    details.appendChild(h("summary", { class: "bt-case-head" }, [
      h("span", { class: "bt-case-status", text: c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "ERROR" }),
      h("span", { class: "bt-case-label", text: c.label || c.operationId }),
      h("code", { class: "bt-case-op", text: c.operationId }),
      h("span", { class: "bt-case-meta", text: meta.join(" · ") }),
    ]));

    if (c.error) details.appendChild(h("div", { class: "bt-case-error", text: c.error }));
    if (c.question && c.question !== "—") {
      details.appendChild(h("div", { class: "bt-case-question", text: "Question: " + c.question }));
    }
    const list = h("div", { class: "bt-check-list" });
    // Failures first, then skips, then passes — the reading order that matters.
    []
      .concat(failed, skipped, (c.checks || []).filter((k) => k.status === "pass"))
      .forEach((k) => list.appendChild(renderCheck(k)));
    details.appendChild(list);
    return details;
  }

  function validationCard(tk, w) {
    const stored = T.getBacktest();
    const body = h("div", { class: "dash-stack-block" });

    // ── Controls: mode + run. One filter-style row at the top of the card. ──
    const modeSel = h("select", { class: "bt-mode-select", "aria-label": "Backtest mode" }, [
      h("option", { value: "data", text: "Data — table checks (fast, no model calls)" }),
      h("option", { value: "full", text: "Full — adds routing + grounding (calls the model)" }),
    ]);
    modeSel.value = backtestMode;
    modeSel.addEventListener("change", () => { backtestMode = modeSel.value === "full" ? "full" : "data"; });

    const runBtn = h("button", {
      class: "btn primary dash-run", type: "button",
      text: backtestBusy ? "Running…" : stored ? "Run again" : "Run validation",
      disabled: backtestBusy ? "" : null,
      onclick: async () => {
        if (backtestBusy) return;
        backtestBusy = true;
        backtestError = null;
        render(); // show the running state immediately
        try {
          await bridge.runBacktest(backtestMode);
        } catch (err) {
          backtestError = err && err.message ? err.message : String(err);
        } finally {
          backtestBusy = false;
          render();
        }
      },
    });

    // Clear only appears once there is a retained verdict — a button that would do nothing is worse
    // than no button. It discards the stored result and nothing else: no sweep runs, and the server
    // is untouched, so the card simply returns to its "not run yet" state.
    const clearBtn = stored && !backtestBusy
      ? h("button", {
          class: "btn ghost dash-run", type: "button", text: "Clear results",
          title: "Discard the retained verdict and return this card to its not-run state",
          onclick: () => {
            T.clearBacktest();
            backtestError = null;
            render();
          },
        })
      : null;

    body.appendChild(h("div", { class: "bt-controls" }, [
      h("label", { class: "bt-mode" }, [h("span", { text: "Mode" }), modeSel]),
      runBtn,
      clearBtn,
    ]));

    if (backtestBusy) {
      body.appendChild(h("div", {
        class: "dash-stack-note",
        text: backtestMode === "full"
          ? "Running the full sweep — routing and grounding call the model once per case, so this takes a while…"
          : "Replaying every registered Fedline operation…",
      }));
    }
    if (backtestError) body.appendChild(h("div", { class: "dash-error-line", text: "Validation failed: " + backtestError }));

    if (!stored) {
      if (!backtestBusy && !backtestError) {
        body.appendChild(h("div", { class: "dash-empty", text: "No validation run recorded yet. Run one to grade every registered Fedline operation's response table." }));
      }
      return card({ title: "Fedline response validation", subtitle: VALIDATION_SUB, body, span: "wide" });
    }

    // ── Verdict + counters + the pass meter ──
    const s = stored.summary;
    const t = s.totals || {};
    const passed = Math.max(0, (t.checks || 0) - (t.checksFailed || 0) - (t.checksSkipped || 0));
    const verdictKind = t.failed || t.errored ? "critical" : t.checksSkipped ? "warning" : "good";

    body.appendChild(h("div", { class: "bt-line" }, [
      statusPill(verdictKind, t.failed || t.errored ? "Failures found" : "All checks passed"),
      h("span", { class: "dash-stack-note", text: `${s.backendId} · ${stored.mode} mode · ${t.cases} cases · ${t.checks} checks · ${s.durationMs} ms · ran ${ago(stored.ranAt)}` }),
    ]));
    body.appendChild(C.meter({ width: w, value: passed, max: Math.max(1, t.checks || 1), color: verdictKind === "good" ? tk.good : tk.warning, track: tk.track }));
    body.appendChild(h("div", { class: "dash-stack-note", text: `${passed} of ${t.checks || 0} checks passed` }));

    body.appendChild(h("div", { class: "bt-counts" }, [
      countPill("False positives", t.falsePositives || 0, "false_positive"),
      countPill("False negatives", t.falseNegatives || 0, "false_negative"),
      countPill("Hallucinations", t.hallucinations || 0, "hallucination"),
      countPill("Data integrity", t.dataIntegrity || 0, "data_integrity"),
    ]));

    if (t.checksSkipped) {
      // A skipped check is NOT a pass — say so, or the headline overstates the result.
      body.appendChild(h("div", {
        class: "bt-note",
        text: `${t.checksSkipped} check(s) skipped — a skipped check was not exercised and is not a pass. ` +
          (stored.mode === "data" ? "Run 'full' mode to exercise routing and grounding." : "Their preconditions were unavailable on this deployment."),
      }));
    }

    // ── Per-case detail, failures first ──
    const cases = h("div", { class: "bt-cases" });
    []
      .concat((s.cases || []).filter((c) => c.status !== "pass"), (s.cases || []).filter((c) => c.status === "pass"))
      .forEach((c) => cases.appendChild(renderCase(c)));
    if (cases.childNodes.length) body.appendChild(cases);

    return card({ title: "Fedline response validation", subtitle: VALIDATION_SUB, body, span: "wide" });
  }

  const VALIDATION_SUB = "Replays every registered Fedline operation and classifies false positives, false negatives, hallucinated figures and table-integrity failures";

  function statusPill(kind, label) {
    // Status colors always ship with a glyph + label, so meaning never rests on hue alone.
    const glyph = kind === "good" ? "●" : kind === "warning" ? "▲" : kind === "critical" ? "✕" : "○";
    return h("span", { class: "pill pill-" + kind }, [h("span", { class: "pill-glyph", text: glyph }), h("span", { text: label })]);
  }

  function healthSection(M, tk, w, wideW) {
    const sess = bridge.getSession();
    const endpoint = bridge.getEndpoint();
    let host = endpoint;
    try { host = new URL(endpoint).host; } catch { /* keep the raw string */ }

    // Health reads the bounded activity list (newest first), which is a real sample of the most
    // recent outcomes — not a re-derivation of the window totals.
    const recent = M.activity.slice(0, 20);
    const recentFailures = recent.filter((r) => !r.ok).length;
    const last = M.activity.length ? M.activity[0] : null;
    const svcKind = !M.totals.requests ? "idle" : recentFailures === 0 ? "good" : recentFailures <= 2 ? "warning" : "critical";
    const svcLabel = !M.totals.requests
      ? "No traffic yet"
      : recentFailures === 0 ? "Healthy" : `${recentFailures} failure(s) in last ${recent.length}`;

    const retained = T.all().length;
    const onServer = dataset.source === "server";
    const service = card({
      title: "Service status",
      subtitle: "Endpoint, session and where these metrics come from",
      body: h("div", { class: "dash-kv-list" }, [
        h("div", { class: "kv-line" }, [h("span", { class: "kv-name", text: "API host" }), h("span", { class: "kv-val mono", text: host, title: endpoint })]),
        h("div", { class: "kv-line" }, [
          h("span", { class: "kv-name", text: "Metrics source" }),
          h("span", { class: "kv-val", text: onServer ? "Request log (Postgres) — aggregated in SQL, all users" : "This browser's localStorage" }),
        ]),
        h("div", { class: "kv-line" }, [h("span", { class: "kv-name", text: "Recent health" }), statusPill(svcKind, svcLabel)]),
        h("div", { class: "kv-line" }, [
          h("span", { class: "kv-name", text: "Signed in as" }),
          h("span", { class: "kv-val", text: (sess && sess.user && sess.user.fullName) || "—" }),
        ]),
        h("div", { class: "kv-line" }, [
          h("span", { class: "kv-name", text: "Session expires" }),
          h("span", { class: "kv-val", text: sess && sess.expiresAt ? stamp(sess.expiresAt * 1000) : "—" }),
        ]),
        h("div", { class: "kv-line" }, [
          h("span", { class: "kv-name", text: "Last request" }),
          h("span", { class: "kv-val", text: last ? `${ago(last.ts)} · ${C.ms(last.latencyMs)}` : "—" }),
        ]),
        h("div", { class: "kv-line" }, [
          h("span", { class: "kv-name", text: onServer ? "Requests aggregated" : "Records retained locally" }),
          h("span", { class: "kv-val" }, [
            // On the server source this is the whole window, not a fetched page — there is no cap
            // left to disclose.
            h("span", { text: onServer ? `${M.totals.requests.toLocaleString()} in this range` : `${retained} / ${T.MAX_RECORDS}` }),
            onServer ? null : C.meter({ width: 120, value: retained, max: T.MAX_RECORDS, color: tk.s1, track: tk.track }),
          ]),
        ]),
      ]),
    });

    const errors = card({
      title: "Recent failures",
      subtitle: `Most recent ${M.failures.length || ""} non-report outcome(s), newest first`.replace("  ", " "),
      body: M.failures.length
        ? h("div", { class: "err-list" }, M.failures.map((r) =>
            h("div", { class: "err-item" }, [
              h("div", { class: "err-item-head" }, [
                statusPill("critical", r.errorKind || "error"),
                h("span", { class: "err-time", text: `${ago(r.ts)} · ${C.ms(r.latencyMs)}${r.httpStatus ? ` · HTTP ${r.httpStatus}` : ""}` }),
              ]),
              h("div", { class: "err-q", text: r.question }),
              h("div", { class: "err-msg", text: r.error || "No detail returned." }),
            ]),
          ))
        : null,
      empty: "No failures in this range.",
    });

    // The validation card spans the grid: it carries a full per-case report, not a summary tile.
    return [service, errors, validationCard(tk, wideW)];
  }

  // ---------- Live activity ----------
  function activityCard(M) {
    const rows = M.activity;
    if (!rows.length) {
      return card({ title: "Live activity", subtitle: "Most recent requests, newest first", body: null, empty: "Nothing recorded yet — every question you ask in Chat lands here.", span: "wide" });
    }
    // Only the deployment-wide source has more than one user in it, so the column only earns its
    // width there.
    const showUser = dataset.source === "server";
    const body = h("div", { class: "act-wrap" }, [
      h("table", { class: "act-table" }, [
        h("thead", {}, h("tr", {}, [
          h("th", { text: "Time" }),
          showUser ? h("th", { text: "User" }) : null,
          h("th", { text: "Request" }), h("th", { text: "Type" }),
          h("th", { text: "Status" }), h("th", { class: "num", text: "Latency" }),
          h("th", { class: "num", text: "Steps" }), h("th", { class: "num", text: "Rows" }),
        ].filter(Boolean))),
        h("tbody", {}, rows.map((r) => {
          // A record from another browser (or another user) has no local message to open — don't
          // dress the row as clickable when nothing would happen.
          const linkable = bridge.hasMessage(r.id);
          return h("tr", {
            class: "act-row" + (r.ok ? "" : " failed") + (linkable ? " linkable" : ""),
            title: linkable ? "Open this exchange in Chat" : "Recorded outside this browser session",
            ...(linkable ? { onclick: () => bridge.focusMessage(r.id) } : {}),
          }, [
            h("td", { class: "act-time", text: stamp(r.ts) }),
            showUser ? h("td", { class: "act-user", text: r.userName || "—" }) : null,
            h("td", { class: "act-q", text: r.question, title: r.question }),
            h("td", {}, r.type ? h("span", { class: "act-chip", text: r.type }) : h("span", { class: "act-dim", text: "—" })),
            h("td", {}, statusPill(r.ok ? "good" : "critical", r.ok ? "ok" : r.errorKind || "failed")),
            h("td", { class: "num", text: C.ms(r.latencyMs) }),
            h("td", { class: "num", text: `${r.steps}${r.llmSteps ? ` (${r.llmSteps} LLM)` : ""}` }),
            h("td", { class: "num", text: r.ok ? (r.rows || 0).toLocaleString() : "—" }),
          ].filter(Boolean));
        })),
      ]),
    ]);
    return card({
      title: "Live activity",
      subtitle: `${rows.length} most recent request(s)` + (dataset.source === "server" ? " across the deployment" : " — click a row to open it in Chat"),
      body,
      span: "wide",
    });
  }

  // ---------- Filter row ----------
  function filterRow(M) {
    const win = M.window;
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Time range" }, T.RANGES.map((r) =>
      h("button", {
        class: "seg-btn" + (r.id === rangeId ? " active" : ""), type: "button", text: r.short,
        title: r.label,
        onclick: () => { rangeId = r.id; refresh(); },
      }),
    ));

    const onServer = dataset.source === "server";
    const srcSeg = h("div", { class: "seg", role: "group", "aria-label": "Data source" }, [
      { id: "auto", label: "Deployment", title: "Every user's requests, from the durable request log" },
      { id: "local", label: "This browser", title: "Only the requests this browser made" },
    ].map((o) =>
      h("button", {
        class: "seg-btn" + ((sourceMode === "local") === (o.id === "local") ? " active" : ""),
        type: "button", text: o.label, title: o.title,
        onclick: () => { sourceMode = o.id; refresh(); },
      }),
    ));

    const badge = h("span", {
      class: "src-badge" + (onServer ? " live" : ""),
      title: onServer
        ? "Computed in SQL over every row of fedline.request_log in this range"
        : "Aggregated in this browser from the responses it received",
      text: onServer ? "Request log · all users" : "This browser only",
    });

    // No truncation caveat any more: the server aggregates the whole window, so this count IS the
    // count. The local source is bounded by its ring buffer, which the health card states outright.
    const left = [seg, h("span", { class: "dash-range-note", text: `${M.totals.requests.toLocaleString()} request(s) · ${stamp(win.from)} → now` })];
    if (dataset.note) left.push(h("span", { class: "dash-range-warn", text: dataset.note }));

    return h("div", { class: "dash-filters" }, [
      h("div", { class: "dash-filter-left" }, left),
      h("div", { class: "dash-filter-right" }, [
        srcSeg,
        badge,
        h("button", { class: "dash-toggle", type: "button", text: loading ? "Loading…" : "Refresh", onclick: () => refresh() }),
        h("button", {
          class: "dash-toggle danger", type: "button", text: "Clear local",
          title: "Discard the telemetry recorded by this browser (the server request log is untouched)",
          onclick: () => {
            if (!confirm("Discard the telemetry recorded by this browser? The deployment-wide request log is not affected.")) return;
            T.clear();
            refresh();
          },
        }),
      ]),
    ]);
  }

  // ---------- Render ----------
  function render() {
    if (!root || !visible) return;
    // One payload, whichever producer made it. Nothing below re-derives a metric from raw rows.
    const M = dataset.metrics || T.aggregateLocal([], requestedWindow());
    const win = M.window;
    const tk = tokens();

    // Charts are sized from the live column width — the grid is responsive, so the SVG must be too.
    // These constants mirror .dash-grid / .dash-card in dashboard.css; deriving the column count here
    // (rather than measuring a probe element) keeps the render to a single layout pass.
    const cs = getComputedStyle(root);
    const inner = root.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    const cols = Math.max(1, Math.floor((inner + GRID_GAP) / (MIN_CARD + GRID_GAP)));
    const cardW = Math.max(240, Math.floor((inner - GRID_GAP * (cols - 1)) / cols) - CARD_PAD);
    // Cards that span the whole grid (validation, activity) get the full inner width.
    const wideW = Math.max(cardW, inner - CARD_PAD);

    const frag = document.createDocumentFragment();
    frag.appendChild(filterRow(M));
    frag.appendChild(heroRow(M, tk, cardW));

    const section = (title, note, cards) => {
      frag.appendChild(h("div", { class: "dash-section-head" }, [
        h("h3", { text: title }),
        note ? h("span", { class: "dash-section-note", text: note }) : null,
      ]));
      frag.appendChild(h("div", { class: "dash-grid" }, cards));
    };

    section("Agent operations", "Volume, latency and the execution path the backend actually took", opsSection(M, tk, cardW));
    section("Backends & reports", "What the registered applications returned", backendSection(M, tk, cardW));
    section("System health & validation", "Endpoint state and the response-validation sweep", healthSection(M, tk, cardW, wideW));
    section("Live activity", null, [activityCard(M)]);

    root.replaceChildren(frag);
  }

  // ---------- Lifecycle ----------
  function init(b, rootEl) {
    bridge = b;
    root = rootEl;
    // Seed from the local store so the very first paint has content; show() then upgrades to the
    // deployment-wide log in the background.
    dataset = { source: "local", metrics: localMetrics(requestedWindow()), note: null };
    // A new request while the dashboard is open should land immediately. On the server source that
    // means re-reading the log (the row is written asynchronously, so give it a moment to land).
    T.onRecord(() => {
      if (!visible) return;
      if (dataset.source === "server") setTimeout(refresh, 1200);
      else refresh();
    });
    // Resize and theme changes need a repaint, not a refetch — the data has not changed.
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (visible) render(); }, 160);
    });
    // Charts carry resolved hex, so a theme flip has to re-render rather than restyle.
    if (window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => { if (visible) render(); };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  function show() {
    visible = true;
    // Paint the last-known dataset immediately so switching views never shows a blank column, then
    // reload in the background — no skeleton flash, no layout jump.
    render();
    void refresh();
  }
  function hide() { visible = false; }

  window.Dashboard = { init, show, hide, render, refresh, isVisible: () => visible };
})();
