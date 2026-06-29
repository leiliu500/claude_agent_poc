/* Reporting Assistant — chat logic + flexible FinalReport rendering. No dependencies. */
(() => {
  "use strict";

  // ---------- Config (persisted in localStorage) ----------
  const DEFAULT_ENDPOINT = "https://9r7fg2qut2.execute-api.us-gov-west-1.amazonaws.com/v1/ask";
  // When the UI is served from the API Gateway itself (hosted at /app), call the API same-origin
  // so the bundle is environment-agnostic. For local dev (localhost/file), use the known URL.
  function defaultEndpoint() {
    if (/\.execute-api\..*\.amazonaws\.com$/.test(location.hostname) && location.pathname.startsWith("/app")) {
      return location.origin + "/v1/ask";
    }
    return DEFAULT_ENDPOINT;
  }
  const cfg = {
    endpoint: localStorage.getItem("ra.endpoint") || defaultEndpoint(),
    timeoutSec: Number(localStorage.getItem("ra.timeoutSec") || "60"),
  };

  const EXAMPLES = [
    "Run the EDD summary report with officeId OFF1, userAba 111111111, aba 222222222, endpoint wire, denomination USD, differenceType net, startDate 2026-04-01, endDate 2026-06-30.",
    "Give me the EDD detail report and export it for 2026-Q2.",
    "XShip fee summary and fee detail for 2026-Q2.",
    "Download shipping activity by ABA 123456789 for zone B1.",
    "What is the ABA group relationship in the xshi file for group 100?",
    "Show the current quarter XShip report.",
  ];

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const messagesEl = $("messages");
  const chatEl = $("chat");
  const welcomeEl = $("welcome");
  const inputEl = $("input");
  const formEl = $("composerForm");
  const sendBtn = $("sendBtn");
  const connStatus = $("connStatus");

  let busy = false;
  const history = []; // { role, content|report|error }

  // ---------- Small DOM helpers ----------
  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return n;
  }
  const scrollDown = () => { chatEl.scrollTop = chatEl.scrollHeight; };

  // ---------- Connection status ----------
  function renderStatus() {
    try {
      const u = new URL(cfg.endpoint);
      connStatus.textContent = u.host;
      connStatus.className = "status";
      connStatus.title = cfg.endpoint;
    } catch {
      connStatus.textContent = "no endpoint";
      connStatus.className = "status bad";
    }
  }

  // ---------- Examples / chips ----------
  function buildExamples() {
    const list = $("examples");
    const chips = $("welcomeChips");
    EXAMPLES.forEach((ex) => {
      list.appendChild(el("li", { text: ex, title: ex, onclick: () => useExample(ex) }));
      chips.appendChild(el("button", { class: "chip", type: "button", text: ex, onclick: () => useExample(ex) }));
    });
  }
  function useExample(text) {
    inputEl.value = text;
    autosize();
    inputEl.focus();
  }

  // ---------- Message rendering ----------
  function addUserMessage(text) {
    welcomeEl.classList.add("hidden");
    const node = el("div", { class: "msg user" }, [
      el("div", { class: "avatar", text: "You" }),
      el("div", { class: "body" }, [
        el("div", { class: "role", text: "You" }),
        el("div", { class: "bubble", text }),
      ]),
    ]);
    messagesEl.appendChild(node);
    scrollDown();
  }

  // Returns handles so we can replace the typing indicator with the final content.
  function addAssistantPlaceholder() {
    const content = el("div", { class: "content" });
    const typing = el("div", { class: "typing" }, [
      el("span", { class: "dot" }), el("span", { class: "dot" }), el("span", { class: "dot" }),
      el("span", { class: "elapsed", text: "0s" }),
    ]);
    content.appendChild(typing);
    const node = el("div", { class: "msg assistant" }, [
      el("div", { class: "avatar", text: "AI" }),
      el("div", { class: "body" }, [
        el("div", { class: "role", text: "Reporting Assistant" }),
        content,
      ]),
    ]);
    messagesEl.appendChild(node);
    scrollDown();

    const start = Date.now();
    const elapsedEl = typing.querySelector(".elapsed");
    const timer = setInterval(() => {
      elapsedEl.textContent = Math.round((Date.now() - start) / 1000) + "s";
    }, 500);

    return {
      setContent(child) {
        clearInterval(timer);
        content.innerHTML = "";
        content.appendChild(child);
        scrollDown();
      },
    };
  }

  // ---------- Flexible report rendering ----------
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  function renderTable(columns, rows) {
    const cols = columns && columns.length ? columns : Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
    const thead = el("thead", {}, el("tr", {}, cols.map((c) => el("th", { text: c }))));
    const tbody = el("tbody", {}, rows.map((r) =>
      el("tr", {}, cols.map((c) => {
        const v = r[c];
        const num = isNum(v);
        return el("td", { class: num ? "num" : "", text: v == null ? "" : String(v) });
      }))
    ));
    return el("div", { class: "table-wrap" }, el("table", { class: "data" }, [thead, tbody]));
  }

  function renderEndpoint(meta) {
    if (!meta || !meta.endpoint) return null;
    const missing = Array.isArray(meta.endpointMissingParams) && meta.endpointMissingParams.length
      ? el("span", { class: "missing", text: "  ⚠ missing: " + meta.endpointMissingParams.join(", ") })
      : null;
    return el("div", { class: "endpoint-line" }, [
      el("span", { class: "method", text: meta.httpMethod || "GET" }),
      document.createTextNode(meta.endpoint),
      missing,
    ]);
  }

  function renderSection(sec, idx) {
    const rows = Array.isArray(sec.rows) ? sec.rows : [];
    const meta = sec.meta || {};
    const metaBits = [];
    if (meta.exportable) metaBits.push("exportable");
    if (typeof meta.generatedRows === "number") metaBits.push(meta.generatedRows + " rows");
    const summaryRow = el("summary", {}, [
      el("span", { class: "caret", text: "▸" }),
      el("span", { text: sec.heading || sec.useCase || ("Section " + (idx + 1)) }),
      el("span", { class: "sec-meta" }, metaBits.map((b) => el("span", { text: b }))),
    ]);

    const body = el("div", { class: "sec-body" });
    if (Array.isArray(sec.highlights) && sec.highlights.length) {
      body.appendChild(el("ul", { class: "highlights" }, sec.highlights.map((h) => el("li", { text: h }))));
    }
    const ep = renderEndpoint(meta);
    if (ep) body.appendChild(ep);
    if (rows.length) body.appendChild(renderTable(sec.columns, rows));
    else body.appendChild(el("div", { class: "report-summary", text: "No rows returned." }));

    return el("details", { class: "section", ...(idx === 0 ? { open: "" } : {}) }, [summaryRow, body]);
  }

  function renderReport(report) {
    const wrap = el("div", { class: "report" });

    wrap.appendChild(el("div", { class: "report-head" }, [
      el("span", { class: "report-title", text: report.title || "Report" }),
      report.type ? el("span", { class: "badge", text: report.type }) : null,
      report.routing && report.routing.requiresOrchestration ? el("span", { class: "badge", text: "orchestrated" }) : null,
    ]));

    if (report.summary) wrap.appendChild(el("div", { class: "report-summary", text: report.summary }));

    (report.sections || []).forEach((sec, i) => wrap.appendChild(renderSection(sec, i)));

    // Footer: meta + raw JSON toggle.
    const totalRows = (report.sections || []).reduce((a, s) => a + ((s.rows && s.rows.length) || 0), 0);
    const foot = el("div", { class: "report-foot" });
    if (report.reportId) foot.appendChild(el("span", { text: "id " + report.reportId }));
    foot.appendChild(el("span", { text: totalRows + " total rows" }));
    if (report.generatedAt) foot.appendChild(el("span", { text: new Date(report.generatedAt).toLocaleString() }));

    const pre = el("pre", { class: "raw", style: "display:none", text: JSON.stringify(report, null, 2) });
    const toggle = el("button", {
      class: "raw-toggle", type: "button", text: "View raw JSON",
      onclick: () => {
        const show = pre.style.display === "none";
        pre.style.display = show ? "block" : "none";
        toggle.textContent = show ? "Hide raw JSON" : "View raw JSON";
        scrollDown();
      },
    });
    foot.appendChild(toggle);
    wrap.appendChild(foot);
    wrap.appendChild(pre);
    return wrap;
  }

  function renderError(title, detail) {
    return el("div", { class: "error-box" }, [
      el("div", { class: "err-title", text: title }),
      detail ? el("div", { text: detail }) : null,
    ]);
  }

  // ---------- API call ----------
  async function callApi(question) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.max(5, cfg.timeoutSec) * 1000);
    try {
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { _raw: text }; }
      return { httpStatus: res.status, data };
    } finally {
      clearTimeout(t);
    }
  }

  // ---------- Send flow ----------
  async function send(question) {
    if (busy) return;
    question = question.trim();
    if (!question) return;

    busy = true;
    sendBtn.disabled = true;
    addUserMessage(question);
    history.push({ role: "user", content: question });
    inputEl.value = "";
    autosize();

    const ph = addAssistantPlaceholder();

    try {
      const { httpStatus, data } = await callApi(question);

      if (data && data.ok && data.report) {
        ph.setContent(renderReport(data.report));
        history.push({ role: "assistant", report: data.report });
      } else if (data && data.error) {
        ph.setContent(renderError("Request failed", data.error + (data.traceId ? `  (trace ${data.traceId})` : "")));
      } else if (data && data._raw !== undefined) {
        ph.setContent(renderError(`Unexpected response (HTTP ${httpStatus})`, String(data._raw).slice(0, 600)));
      } else {
        ph.setContent(renderError(`Unexpected response (HTTP ${httpStatus})`, JSON.stringify(data).slice(0, 600)));
      }
    } catch (err) {
      const aborted = err && err.name === "AbortError";
      ph.setContent(renderError(
        aborted ? "Timed out" : "Network error",
        aborted
          ? `No response within ${cfg.timeoutSec}s. The agent path can exceed the API gateway limit — try again (it's often faster when warm), or raise the timeout in Settings.`
          : String(err && err.message ? err.message : err) + " — check the API endpoint in Settings and that CORS is reachable."
      ));
    } finally {
      busy = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  // ---------- Input behaviors ----------
  function autosize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
  }
  inputEl.addEventListener("input", autosize);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(inputEl.value);
    }
  });
  formEl.addEventListener("submit", (e) => { e.preventDefault(); send(inputEl.value); });

  // ---------- New chat ----------
  $("newChat").addEventListener("click", () => {
    messagesEl.innerHTML = "";
    history.length = 0;
    welcomeEl.classList.remove("hidden");
    inputEl.value = "";
    autosize();
    inputEl.focus();
  });

  // ---------- Sidebar toggle ----------
  $("sidebarToggle").addEventListener("click", () => $("sidebar").classList.toggle("collapsed"));

  // ---------- Settings ----------
  const dialog = $("settingsDialog");
  $("settingsBtn").addEventListener("click", () => {
    $("endpointInput").value = cfg.endpoint;
    $("timeoutInput").value = cfg.timeoutSec;
    dialog.showModal();
  });
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "save") {
      const ep = $("endpointInput").value.trim();
      const to = Number($("timeoutInput").value);
      if (ep) { cfg.endpoint = ep; localStorage.setItem("ra.endpoint", ep); }
      if (to >= 5) { cfg.timeoutSec = to; localStorage.setItem("ra.timeoutSec", String(to)); }
      renderStatus();
    }
  });

  // ---------- Init ----------
  buildExamples();
  renderStatus();
  autosize();
  inputEl.focus();
})();
