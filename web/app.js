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
    "Export the XShip fee summary for 2026-Q2 as Excel.",
    "Give me the EDD detail report for 2026-Q2 as PDF.",
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
        el("div", { class: "role", text: "Fedline Assistant" }),
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
