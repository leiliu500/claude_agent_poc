/* Agentic API Gateway — login + session, chat logic, flexible FinalReport rendering. No dependencies. */
(() => {
  "use strict";

  // ---------- Config (persisted in localStorage) ----------
  const DEFAULT_ENDPOINT = "https://9hixvh0jxd.execute-api.us-gov-west-1.amazonaws.com/v1/ask";
  // When the UI is served from the API Gateway itself (hosted at /app), the API is same-origin by
  // construction. Return that so the bundle is environment-agnostic — and, crucially, so a stale
  // `ra.endpoint` saved by a PREVIOUS deployment (a now-dead API URL) can't break login/ask.
  function hostedEndpoint() {
    if (/\.execute-api\..*\.amazonaws\.com$/.test(location.hostname) && location.pathname.startsWith("/app")) {
      return location.origin + "/v1/ask";
    }
    return null;
  }
  // Precedence: hosted same-origin (authoritative) > saved override (local dev) > baked-in default.
  const hosted = hostedEndpoint();
  const cfg = {
    endpoint: hosted || localStorage.getItem("ra.endpoint") || DEFAULT_ENDPOINT,
    timeoutSec: Number(localStorage.getItem("ra.timeoutSec") || "60"),
  };
  // Heal a stale saved endpoint so Settings shows the correct one too.
  if (hosted && localStorage.getItem("ra.endpoint") && localStorage.getItem("ra.endpoint") !== hosted) {
    localStorage.setItem("ra.endpoint", hosted);
  }
  // The login endpoint is the sibling of the ask endpoint (…/v1/ask → …/v1/login).
  const loginEndpoint = () => cfg.endpoint.replace(/\/v1\/ask\b.*$/, "/v1/login");

  // ---------- Session ----------
  // After login we hold { token, expiresAt (epoch seconds), user } here + in localStorage so a
  // page reload keeps the session until the token expires. Past expiry the user must log in again.
  const SESSION_KEY = "ra.session";
  let session = null;      // in-memory copy of the active session
  let expiryTimer = null;  // fires at token expiry to force re-login

  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (s && s.token && typeof s.expiresAt === "number") return s;
    } catch { /* ignore */ }
    return null;
  }
  const sessionValid = (s) => Boolean(s && s.token && s.expiresAt * 1000 > Date.now());

  // Examples no longer carry IDs — the signed-in user's officeId/ABA/etc. are attached server-side
  // from their session token, so requests stay short and identity can't be spoofed in the text.
  const EXAMPLES = [
    "Run the EDD summary report for endpoint wire, denomination USD, differenceType net, startDate 2026-04-01, endDate 2026-06-30.",
    "Export the EDD summary report for endpoint wire, denomination USD, differenceType net, startDate 2026-04-01, endDate 2026-06-30.",
    "Give me the EDD detail report and export it for 2026-Q2.",
    "XShip fee summary and fee detail for 2026-Q2.",
    "Download shipping activity for zone B1.",
    "How is the EDD detail reportId derived from a summary record?",
    "What is the ABA group relationship in the xshi file for group 100?",
    "Export the XShip fee summary for 2026-Q2 as Excel.",
    "Give me the EDD detail report for 2026-Q2 as PDF.",
  ];

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const messagesEl = $("messages");
  const chatEl = $("chat");
  const welcomeEl = $("welcome");
  const welcomeHeadingEl = $("welcomeHeading");
  const inputEl = $("input");
  const formEl = $("composerForm");
  const sendBtn = $("sendBtn");
  const attachBtn = $("attachBtn");
  const fileInput = $("fileInput");
  const attachBar = $("attachBar");
  const attachName = $("attachName");
  const attachRemove = $("attachRemove");
  const payloadInput = $("payloadInput");
  const connStatus = $("connStatus");
  const appEl = $("app");
  const loginView = $("loginView");
  const loginForm = $("loginForm");
  const loginUser = $("loginUser");
  const loginPass = $("loginPass");
  const loginError = $("loginError");
  const loginBtn = $("loginBtn");
  const loginHint = $("loginHint");
  const userBox = $("userBox");
  const userNameEl = $("userName");
  const logoutBtn = $("logoutBtn");

  let busy = false;
  let attached = null; // { name, contentBase64 } — a file staged for a gateway upload (e.g. SCP)
  const MAX_FILE_BYTES = 5 * 1024 * 1024;
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
        el("div", { class: "role", text: "Agentic API Gateway" }),
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

  function renderSection(sec, idx, opts = {}) {
    const rows = Array.isArray(sec.rows) ? sec.rows : [];
    const meta = sec.meta || {};
    const metaBits = [];
    if (meta.exportable) metaBits.push("exportable");
    if (typeof meta.generatedRows === "number") metaBits.push(meta.generatedRows + " rows");
    const summaryRow = el("summary", {}, [
      el("span", { class: "caret", text: "▸" }),
      el("span", { text: opts.heading || sec.heading || sec.useCase || ("Section " + (idx + 1)) }),
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

    const isOpen = opts.open !== undefined ? opts.open : idx === 0;
    return el("details", { class: "section", ...(isOpen ? { open: "" } : {}) }, [summaryRow, body]);
  }

  // Pull the KB (RAG) answer + provenance out of a KB report's section meta, when present.
  function kbInfo(report) {
    if (!report || report.type !== "KB") return null;
    const sec = (report.sections || []).find(
      (s) => s.meta && (s.meta.answer !== undefined || s.meta.retrieval !== undefined),
    );
    const meta = (sec && sec.meta) || {};
    return {
      answer: (typeof meta.answer === "string" && meta.answer) || report.summary || "",
      citations: Array.isArray(meta.citations) ? meta.citations : [],
      retrieval: meta.retrieval || "",
      matched: typeof meta.matched === "number" ? meta.matched : sec && sec.rows ? sec.rows.length : 0,
      query: meta.query || "",
    };
  }

  // The RAG "used the knowledge base" card: badge, grounded answer, retrieval provenance, sources.
  function renderKbCard(kb) {
    const sourceLabel =
      kb.retrieval === "postgres" ? "pgvector" : kb.retrieval === "memory" ? "in-memory corpus" : kb.retrieval || "—";
    const provText =
      kb.retrieval === "postgres"
        ? `Retrieved ${kb.matched} passage(s) from the pgvector knowledge base.`
        : kb.retrieval === "memory"
          ? `Retrieved ${kb.matched} passage(s) from the built-in corpus.`
          : `Retrieved ${kb.matched} passage(s).`;

    const head = el("div", { class: "kb-head" }, [
      el("span", { class: "kb-icon", text: "🔎" }),
      el("span", { class: "kb-label", text: "Retrieval-Augmented Answer" }),
      el("span", { class: "badge rag", text: "RAG" }),
      el("span", { class: "kb-source", title: "retrieval source", text: sourceLabel }),
    ]);

    const children = [head, el("div", { class: "kb-answer", text: kb.answer })];
    children.push(el("div", { class: "kb-prov", text: provText }));
    if (kb.citations.length) {
      children.push(
        el("div", { class: "kb-cite" }, [
          el("div", { class: "kb-cite-label", text: "Sources" }),
          el("ul", { class: "kb-cite-list" }, kb.citations.map((c) => el("li", { text: c }))),
        ]),
      );
    }
    return el("div", { class: "kb-card" }, children);
  }

  function renderReport(report) {
    const wrap = el("div", { class: "report" });
    const kb = kbInfo(report);

    wrap.appendChild(el("div", { class: "report-head" }, [
      el("span", { class: "report-title", text: report.title || "Report" }),
      report.type ? el("span", { class: "badge", text: report.type === "KB" ? "Knowledge Base" : report.type }) : null,
      kb ? el("span", { class: "badge rag", text: "RAG" }) : null,
      report.routing && report.routing.requiresOrchestration ? el("span", { class: "badge", text: "orchestrated" }) : null,
    ]));

    // KB: show the grounded answer + provenance card (replaces the generic summary line).
    if (kb) wrap.appendChild(renderKbCard(kb));
    else if (report.summary) wrap.appendChild(el("div", { class: "report-summary", text: report.summary }));

    // For KB the section rows are the retrieved passages (evidence) — relabel + collapse them so the
    // answer card stays the focus. Report sections render normally (first open).
    (report.sections || []).forEach((sec, i) =>
      wrap.appendChild(kb ? renderSection(sec, i, { open: false, heading: "Retrieved passages" }) : renderSection(sec, i)),
    );

    // Export controls (tables remain the default view; these download other formats).
    wrap.appendChild(buildExportBar(report));

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

  // ---------- Export: CSV / Excel / PDF / JSON ----------
  // Tables are the DEFAULT rendering. When the user asks for a specific format (or clicks an
  // export button), the same structured report is returned/downloaded in that format.
  const FORMAT_LABEL = { pdf: "PDF", excel: "Excel", csv: "CSV", json: "JSON" };

  function detectFormat(text) {
    const q = (text || "").toLowerCase();
    if (/\bpdf\b/.test(q)) return "pdf";
    if (/\b(excel|xlsx|xls|spreadsheet|workbook)\b/.test(q)) return "excel";
    if (/\b(csv|comma[-\s]?separated)\b/.test(q)) return "csv";
    if (/\bjson\b/.test(q)) return "json";
    return null;
  }

  const colsOf = (sec) =>
    sec.columns && sec.columns.length
      ? sec.columns
      : Array.from(new Set((sec.rows || []).flatMap((r) => Object.keys(r))));
  const baseName = (report) => String(report.reportId || report.type || "report").replace(/[^\w.-]+/g, "_");
  const htmlEscape = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function csvEscape(v) {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function reportToCsv(report) {
    const parts = [];
    (report.sections || []).forEach((sec) => {
      parts.push("# " + (sec.heading || sec.useCase || "section"));
      const cols = colsOf(sec);
      parts.push(cols.map(csvEscape).join(","));
      (sec.rows || []).forEach((r) => parts.push(cols.map((c) => csvEscape(r[c])).join(",")));
      parts.push("");
    });
    return "﻿" + parts.join("\r\n"); // BOM so Excel detects UTF-8
  }
  const exportCsv = (report) => download(baseName(report) + ".csv", reportToCsv(report), "text/csv;charset=utf-8");
  const exportJson = (report) => download(baseName(report) + ".json", JSON.stringify(report, null, 2), "application/json");

  function reportToExcelHtml(report) {
    let h =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" ' +
      'xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"></head><body>';
    h += "<h3>" + htmlEscape(report.title || "Report") + "</h3>";
    (report.sections || []).forEach((sec) => {
      const cols = colsOf(sec);
      h += "<h4>" + htmlEscape(sec.heading || sec.useCase || "") + "</h4>";
      h += '<table border="1" cellspacing="0"><tr>' + cols.map((c) => "<th>" + htmlEscape(c) + "</th>").join("") + "</tr>";
      (sec.rows || []).forEach((r) => {
        h += "<tr>" + cols.map((c) => "<td>" + htmlEscape(r[c]) + "</td>").join("") + "</tr>";
      });
      h += "</table><br/>";
    });
    return h + "</body></html>";
  }
  const exportExcel = (report) => download(baseName(report) + ".xls", reportToExcelHtml(report), "application/vnd.ms-excel");

  // PDF via the browser's print engine, rendered in a hidden iframe (no pop-up to be blocked).
  function exportPdf(report) {
    const tables = (report.sections || [])
      .map((sec) => {
        const cols = colsOf(sec);
        const head = "<tr>" + cols.map((c) => "<th>" + htmlEscape(c) + "</th>").join("") + "</tr>";
        const body = (sec.rows || [])
          .map((r) => "<tr>" + cols.map((c) => "<td>" + htmlEscape(r[c]) + "</td>").join("") + "</tr>")
          .join("");
        const hi = (sec.highlights || []).map((x) => "<li>" + htmlEscape(x) + "</li>").join("");
        return `<h2>${htmlEscape(sec.heading || sec.useCase || "")}</h2>${hi ? "<ul>" + hi + "</ul>" : ""}<table>${head}${body}</table>`;
      })
      .join("");
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(report.title || "Report")}</title>
      <style>body{font:13px -apple-system,Segoe UI,Roboto,sans-serif;color:#1f2328;margin:28px}
      h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:18px 0 6px}.muted{color:#6b7280;font-size:12px}
      table{border-collapse:collapse;width:100%;margin:6px 0 14px;font-size:12px}
      th,td{border:1px solid #ccc;padding:5px 8px;text-align:left}th{background:#f3f3f3}ul{margin:4px 0 8px;color:#444}</style>
      </head><body><h1>${htmlEscape(report.title || "Report")}</h1>
      <div class="muted">${htmlEscape(report.type || "")} &middot; ${htmlEscape(report.reportId || "")} &middot; ${htmlEscape(report.generatedAt || "")}</div>
      <p>${htmlEscape(report.summary || "")}</p>${tables}</body></html>`;
    const iframe = el("iframe", { style: "position:fixed;right:0;bottom:0;width:0;height:0;border:0" });
    document.body.appendChild(iframe);
    const idoc = iframe.contentWindow.document;
    idoc.open();
    idoc.write(doc);
    idoc.close();
    iframe.onload = () => {
      try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) { /* ignore */ }
      setTimeout(() => iframe.remove(), 1500);
    };
  }

  const EXPORTERS = { csv: exportCsv, excel: exportExcel, pdf: exportPdf, json: exportJson };

  function buildExportBar(report) {
    const btn = (label, fn) => el("button", { class: "export-btn", type: "button", text: label, onclick: () => fn(report) });
    return el("div", { class: "export-bar" }, [
      el("span", { class: "export-label", text: "Export:" }),
      btn("CSV", exportCsv),
      btn("Excel", exportExcel),
      btn("PDF", exportPdf),
      btn("JSON", exportJson),
    ]);
  }

  // ---------- API call ----------
  async function callApi(question, file, payload) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.max(5, cfg.timeoutSec) * 1000);
    try {
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The session token authorizes the request at the API edge; the server reads the
          // caller's office/ABA/etc. from it — the question no longer carries identity.
          ...(session ? { authorization: "Bearer " + session.token } : {}),
        },
        // An attached file routes server-side to a gateway file-upload op (bypassing the LLM).
        body: JSON.stringify(file ? { question, file, payload } : { question }),
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

    // Capture any staged attachment FIRST, so a file-only submit (empty message) is still allowed.
    const fileToSend = attached;
    let payloadToSend = fileToSend ? payloadInput.value.trim() : undefined;
    question = (question || "").trim();
    if (fileToSend) {
      // Tolerate the JSON control block being typed into the message box instead of the payload box.
      if (!payloadToSend && question.startsWith("{")) { payloadToSend = question; question = ""; }
      // A message is optional when a file is attached — synthesize a routing query from the filename.
      if (!question) question = `Submit file ${fileToSend.name}`;
    }
    if (!question) return; // nothing to send (no message and no file)

    // Enforce the session client-side too: if the token has expired, force a fresh login before
    // sending (the server would reject it anyway; this gives a clean UX).
    if (!sessionValid(session)) {
      endSession("Your session has expired. Please sign in again.");
      return;
    }

    busy = true;
    sendBtn.disabled = true;
    addUserMessage(fileToSend ? `${question}   📎 ${fileToSend.name}` : question);
    history.push({ role: "user", content: question });
    inputEl.value = "";
    autosize();
    clearAttachment();

    const ph = addAssistantPlaceholder();

    try {
      const { httpStatus, data } = await callApi(question, fileToSend, payloadToSend);

      if (httpStatus === 401 || httpStatus === 403) {
        // Token rejected by the authorizer (expired/invalid) — drop the session and re-gate.
        ph.setContent(renderError("Session expired", "Please sign in again to continue."));
        endSession("Your session has expired. Please sign in again.");
      } else if (data && data.ok && data.report) {
        const node = renderReport(data.report);
        // If the user asked for a specific format, return it in that format (download/print),
        // while still showing the table preview by default.
        const fmt = detectFormat(question);
        if (fmt && EXPORTERS[fmt]) {
          node.insertBefore(
            el("div", { class: "export-note", text: `Returned as ${FORMAT_LABEL[fmt]} — your ${fmt === "pdf" ? "print dialog" : "download"} should start automatically. Table preview below.` }),
            node.firstChild,
          );
        }
        ph.setContent(node);
        history.push({ role: "assistant", report: data.report });
        if (fmt && EXPORTERS[fmt]) setTimeout(() => EXPORTERS[fmt](data.report), 120);
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

  // ---------- File attachment (gateway uploads, e.g. SCP EASy files) ----------
  const DEFAULT_INPUT_PH = inputEl.getAttribute("placeholder");
  function clearAttachment() {
    attached = null;
    fileInput.value = "";
    payloadInput.value = "";
    attachName.textContent = "";
    attachBar.hidden = true;
    inputEl.setAttribute("placeholder", DEFAULT_INPUT_PH);
  }
  attachBtn.addEventListener("click", () => fileInput.click());
  attachRemove.addEventListener("click", clearAttachment);
  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) {
      alert("That file is too large (max 5 MB). Attach a smaller file.");
      fileInput.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || "");
      // readAsDataURL yields "data:<mime>;base64,<data>" — keep only the base64 payload.
      attached = { name: f.name, contentBase64: s.includes(",") ? s.slice(s.indexOf(",") + 1) : s };
      attachName.textContent = `${f.name} (${Math.ceil(f.size / 1024)} KB)`;
      attachBar.hidden = false;
      // Make it clear the message is now optional and JSON goes in the payload box below.
      inputEl.setAttribute("placeholder", "Optional: describe the request… (put the payload JSON in the box below)");
      payloadInput.focus();
    };
    reader.onerror = () => alert("Could not read that file.");
    reader.readAsDataURL(f);
  });

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

  // ---------- Auth: login / logout / session lifecycle ----------
  function showLogin() {
    loginView.hidden = false;
    appEl.hidden = true;
    userBox.hidden = true;
    loginPass.value = "";
    setTimeout(() => loginUser.focus(), 0);
  }

  function showApp() {
    loginView.hidden = true;
    appEl.hidden = false;
    userBox.hidden = false;
    const name = (session && session.user && session.user.fullName) || "Signed in";
    userNameEl.textContent = name;
    // Logged-in users always get a personalized greeting on the welcome screen.
    welcomeHeadingEl.textContent = `Hello, ${name}, what can I help?`;
    autosize();
    inputEl.focus();
  }

  // Fire an auto-logout exactly when the token expires, so an idle tab returns to the login screen.
  function scheduleExpiry() {
    if (expiryTimer) clearTimeout(expiryTimer);
    if (!session) return;
    const ms = session.expiresAt * 1000 - Date.now();
    // setTimeout caps around ~24.8 days; our tokens are far shorter, so this is safe.
    expiryTimer = setTimeout(() => endSession("Your session has expired. Please sign in again."), Math.max(0, ms));
  }

  function startSession(s) {
    session = s;
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    scheduleExpiry();
    showApp();
  }

  function endSession(message) {
    session = null;
    localStorage.removeItem(SESSION_KEY);
    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
    // Reset the conversation so the next user starts clean.
    messagesEl.innerHTML = "";
    history.length = 0;
    welcomeEl.classList.remove("hidden");
    loginError.hidden = true;
    if (message) { loginHint.textContent = message; }
    showLogin();
  }

  async function doLogin(username, password) {
    loginError.hidden = true;
    loginHint.textContent = "";
    loginBtn.disabled = true;
    loginBtn.textContent = "Signing in…";
    try {
      const res = await fetch(loginEndpoint(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok && data.token) {
        startSession({ token: data.token, expiresAt: data.expiresAt, user: data.user });
      } else {
        loginError.textContent = data.error || `Sign-in failed (HTTP ${res.status}).`;
        loginError.hidden = false;
      }
    } catch (err) {
      loginError.textContent = "Could not reach the login service. Check the API endpoint in Settings.";
      loginError.hidden = false;
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = "Sign in";
    }
  }

  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const u = loginUser.value.trim();
    const p = loginPass.value;
    if (u && p) doLogin(u, p);
  });
  logoutBtn.addEventListener("click", () => endSession());

  // ---------- Init ----------
  buildExamples();
  renderStatus();
  autosize();

  // Gate on the session: a valid stored token skips the login screen; otherwise show login.
  session = loadSession();
  if (sessionValid(session)) {
    scheduleExpiry();
    showApp();
  } else {
    session = null;
    localStorage.removeItem(SESSION_KEY);
    showLogin();
  }
})();
