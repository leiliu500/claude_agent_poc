/*
 * Agentic Application Gateway — chart primitives.
 *
 * Buildless inline SVG, no dependencies (the whole UI is three static files behind nginx).
 *
 * Design rules enforced here rather than left to each call site:
 *   · marks are thin — bars cap at 24px, lines are 2px, markers are >= 8px across;
 *   · touching fills are separated by a 2px gap in the SURFACE color, never by a stroke;
 *   · overlapping dots carry a 2px surface ring so they stay legible where they cross;
 *   · the data-end of a bar is rounded 4px, the baseline end stays square;
 *   · gridlines and axes are solid hairlines one step off the surface, never dashed;
 *   · text never wears a series color — identity comes from the colored mark beside it;
 *   · values are labelled selectively (endpoint / bar tip), never on every point.
 *
 * Series colors are passed in as resolved hex (dashboard.js reads them from CSS custom properties
 * so light/dark swap in one place); chrome and text are styled by class in dashboard.css.
 */
(() => {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";

  function s(tag, attrs = {}, children = []) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === "text") n.textContent = String(v);
      else n.setAttribute(k, String(v));
    }
    for (const c of [].concat(children)) if (c) n.appendChild(c);
    return n;
  }

  function h(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, String(v));
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return n;
  }

  // ---------- Formatters ----------
  // Large standalone numbers use the font's proportional figures; only columns get tabular-nums
  // (a class in the stylesheet), so nothing here forces equal-width digits.
  function compact(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(abs >= 1e10 ? 0 : 1).replace(/\.0$/, "") + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (abs >= 1e4) return (n / 1e3).toFixed(0) + "K";
    return n.toLocaleString(undefined, { maximumFractionDigits: abs < 10 ? 1 : 0 });
  }
  function ms(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    return n >= 10000 ? (n / 1000).toFixed(1) + " s" : Math.round(n).toLocaleString() + " ms";
  }
  const pct = (n, digits = 0) =>
    typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) + "%" : "—";

  /**
   * Text measurement, so labels are truncated to what actually FITS rather than to a guessed
   * character count. A label that overlaps its bar (or gets clipped by it) is worse than an elided
   * one, and the full text always stays available in the tooltip and the table view.
   */
  let measureCtx = null;
  function fontOf(px, weight = "") {
    const fam = getComputedStyle(document.body).fontFamily || "sans-serif";
    return `${weight} ${px}px ${fam}`.trim();
  }
  function textWidth(text, font) {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }
  function fitText(text, maxPx, font) {
    const str = String(text ?? "");
    if (textWidth(str, font) <= maxPx) return str;
    let lo = 0;
    let hi = str.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (textWidth(str.slice(0, mid) + "…", font) <= maxPx) lo = mid;
      else hi = mid - 1;
    }
    return lo <= 0 ? "…" : str.slice(0, lo) + "…";
  }

  /** Round an axis maximum up to a clean number, and return evenly spaced ticks including 0. */
  function niceTicks(max, count = 4) {
    if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] };
    const raw = max / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const top = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
    return { max: top, ticks };
  }

  /**
   * A rectangle whose DATA end is rounded 4px and whose baseline end stays square.
   * `side` names the data end: "top" (columns), "right" (horizontal bars).
   */
  function roundedBarPath(x, y, w, hgt, side, r = 4) {
    const rr = Math.max(0, Math.min(r, side === "top" ? Math.min(w / 2, hgt) : Math.min(hgt / 2, w)));
    if (rr <= 0.5) return `M${x} ${y}h${w}v${hgt}h${-w}Z`;
    if (side === "top") {
      return `M${x} ${y + hgt}V${y + rr}a${rr} ${rr} 0 0 1 ${rr} ${-rr}h${w - 2 * rr}a${rr} ${rr} 0 0 1 ${rr} ${rr}V${y + hgt}Z`;
    }
    return `M${x} ${y}h${w - rr}a${rr} ${rr} 0 0 1 ${rr} ${rr}v${hgt - 2 * rr}a${rr} ${rr} 0 0 1 ${-rr} ${rr}H${x}Z`;
  }

  // ---------- Tooltip layer ----------
  // Tooltips ENHANCE — every value they show is also reachable from an axis tick, a direct label or
  // the card's table view, so nothing is gated behind hover. Keyboard focus shows the same content.
  function attachTip(wrap) {
    const tip = h("div", { class: "viz-tip", role: "status" });
    tip.hidden = true;
    wrap.appendChild(tip);
    let raf = 0;
    return {
      show(x, y, nodes) {
        tip.replaceChildren(...[].concat(nodes).filter(Boolean));
        tip.hidden = false;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const box = wrap.getBoundingClientRect();
          const tw = tip.offsetWidth;
          const th = tip.offsetHeight;
          // Flip before the tooltip would leave the card, so it never gets clipped by overflow.
          const left = Math.max(4, Math.min(box.width - tw - 4, x - tw / 2));
          const top = y - th - 12 < 0 ? y + 16 : y - th - 12;
          tip.style.left = left + "px";
          tip.style.top = top + "px";
        });
      },
      hide() { tip.hidden = true; },
    };
  }

  /** One "swatch — name … value" row inside a tooltip. */
  function tipRow(color, name, value) {
    return h("div", { class: "viz-tip-row" }, [
      color ? h("span", { class: "viz-tip-dot", style: `background:${color}` }) : null,
      h("span", { class: "viz-tip-name", text: name }),
      h("span", { class: "viz-tip-val", text: value }),
    ]);
  }

  /**
   * Legend — always present for two or more series, never for one (the title already names the
   * single thing plotted, so a one-swatch box just restates it).
   */
  function legend(items) {
    if (!items || items.length < 2) return null;
    return h("div", { class: "viz-legend" }, items.map((it) =>
      h("span", { class: "viz-legend-item" }, [
        h("span", { class: "viz-legend-swatch", style: `background:${it.color}` }),
        h("span", { text: it.name }),
      ]),
    ));
  }

  /** The table-view twin every chart ships with — the WCAG-clean equivalent of the same data. */
  function table(columns, rows) {
    return h("div", { class: "viz-table-wrap" }, [
      h("table", { class: "viz-table" }, [
        h("thead", {}, h("tr", {}, columns.map((c) => h("th", { class: c.num ? "num" : "", text: c.label })))),
        h("tbody", {}, rows.map((r) =>
          h("tr", {}, columns.map((c) =>
            h("td", { class: [c.num ? "num" : "", c.mono ? "mono" : ""].filter(Boolean).join(" "), text: r[c.key] == null ? "—" : String(r[c.key]) }),
          )),
        )),
      ]),
    ]);
  }

  // ---------- Line chart (trend over time) ----------
  /**
   * @param {object} o
   * @param {number} o.width  · @param {number} [o.height=180]
   * @param {{name:string,color:string,points:{x:number,y:number|null}[]}[]} o.series
   *        A null `y` is a genuine gap (no traffic in that bucket) and is drawn as a break in the
   *        line — never interpolated across, which would invent data.
   * @param {{x:number,label:string}[]} o.xTicks
   * @param {(v:number)=>string} [o.yFmt]
   * @param {(x:number)=>string} [o.xFmt]  label for the tooltip header
   */
  function line(o) {
    const width = Math.max(220, o.width | 0);
    const height = o.height || 180;
    const fmt = o.yFmt || compact;
    const pad = { l: 48, r: 56, t: 14, b: 26 };
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;

    const xs = o.series.flatMap((se) => se.points.map((p) => p.x));
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const spanX = x1 - x0 || 1;
    const maxY = Math.max(0, ...o.series.flatMap((se) => se.points.map((p) => (p.y == null ? 0 : p.y))));
    const { max: topY, ticks } = niceTicks(maxY);
    const X = (x) => pad.l + ((x - x0) / spanX) * plotW;
    const Y = (y) => pad.t + plotH - (y / topY) * plotH;

    const svg = s("svg", { class: "viz-svg", width, height, viewBox: `0 0 ${width} ${height}`, role: "img" });

    // Gridlines + y ticks (they carry the values that are not directly labelled).
    for (const t of ticks) {
      svg.appendChild(s("line", { class: "viz-grid", x1: pad.l, x2: pad.l + plotW, y1: Y(t), y2: Y(t) }));
      svg.appendChild(s("text", { class: "viz-axis", x: pad.l - 8, y: Y(t) + 4, "text-anchor": "end", text: fmt(t) }));
    }
    svg.appendChild(s("line", { class: "viz-baseline", x1: pad.l, x2: pad.l + plotW, y1: Y(0), y2: Y(0) }));

    for (const t of o.xTicks || []) {
      svg.appendChild(s("text", { class: "viz-axis", x: X(t.x), y: height - 8, "text-anchor": "middle", text: t.label }));
    }

    // One path per series, broken at gaps.
    for (const se of o.series) {
      let d = "";
      let pen = false;
      for (const p of se.points) {
        if (p.y == null) { pen = false; continue; }
        d += (pen ? "L" : "M") + X(p.x).toFixed(1) + " " + Y(p.y).toFixed(1) + " ";
        pen = true;
      }
      if (d) svg.appendChild(s("path", { class: "viz-line", d: d.trim(), stroke: se.color }));
    }

    // End marker + direct end label per series. Labels are dropped (not stacked) when they would
    // collide — a nudged label detaches from its line and reads as noise; the legend and tooltip
    // still carry that series.
    const ends = o.series
      .map((se) => {
        const last = [...se.points].reverse().find((p) => p.y != null);
        return last ? { se, x: X(last.x), y: Y(last.y), v: last.y } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.y - b.y);
    let lastLabelY = -Infinity;
    for (const e of ends) {
      svg.appendChild(s("circle", { class: "viz-dot-ring", cx: e.x, cy: e.y, r: 4, fill: e.se.color }));
      if (e.y - lastLabelY >= 14) {
        svg.appendChild(s("text", { class: "viz-endlabel", x: e.x + 9, y: e.y + 4, text: fmt(e.v) }));
        lastLabelY = e.y;
      }
    }

    const wrap = h("div", { class: "viz-wrap" }, [svg]);
    const tip = attachTip(wrap);

    // Crosshair: snap to the nearest x index shared by every series.
    const n = Math.max(...o.series.map((se) => se.points.length));
    const cross = s("line", { class: "viz-cross", x1: 0, x2: 0, y1: pad.t, y2: pad.t + plotH });
    cross.style.display = "none";
    svg.appendChild(cross);
    const hoverDots = s("g");
    svg.appendChild(hoverDots);

    const overlay = s("rect", { x: pad.l, y: pad.t, width: plotW, height: plotH, fill: "transparent", tabindex: "0" });
    let idx = -1;
    function showIndex(i, clientX) {
      if (i < 0 || i >= n) return;
      idx = i;
      const ref = o.series.find((se) => se.points[i])?.points[i];
      if (!ref) return;
      const px = X(ref.x);
      cross.setAttribute("x1", px);
      cross.setAttribute("x2", px);
      cross.style.display = "";
      hoverDots.replaceChildren(
        ...o.series
          .filter((se) => se.points[i] && se.points[i].y != null)
          .map((se) => s("circle", { class: "viz-dot-ring", cx: px, cy: Y(se.points[i].y), r: 4.5, fill: se.color })),
      );
      const rect = wrap.getBoundingClientRect();
      tip.show(clientX != null ? clientX - rect.left : px, Y(Math.max(...o.series.map((se) => se.points[i]?.y ?? 0))), [
        h("div", { class: "viz-tip-head", text: o.xFmt ? o.xFmt(ref.x) : String(ref.x) }),
        ...o.series.map((se) => tipRow(se.color, se.name, se.points[i] && se.points[i].y != null ? fmt(se.points[i].y) : "no data")),
      ]);
    }
    overlay.addEventListener("mousemove", (e) => {
      const rect = svg.getBoundingClientRect();
      const rel = ((e.clientX - rect.left - pad.l) / plotW) * (n - 1);
      showIndex(Math.round(Math.max(0, Math.min(n - 1, rel))), e.clientX);
    });
    overlay.addEventListener("mouseleave", () => { cross.style.display = "none"; hoverDots.replaceChildren(); tip.hide(); });
    overlay.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      showIndex(Math.max(0, Math.min(n - 1, (idx < 0 ? n - 1 : idx) + (e.key === "ArrowRight" ? 1 : -1))));
    });
    overlay.addEventListener("blur", () => { cross.style.display = "none"; hoverDots.replaceChildren(); tip.hide(); });
    svg.appendChild(overlay);

    return wrap;
  }

  // ---------- Stacked column chart (volume over time) ----------
  /**
   * @param {object} o
   * @param {{label:string, segments:{name:string,color:string,value:number}[]}[]} o.buckets
   *        Bucket boundaries come from the selected time range, so an empty bucket stays on the
   *        axis — a gap in traffic is information.
   */
  function columns(o) {
    const width = Math.max(220, o.width | 0);
    const height = o.height || 180;
    const fmt = o.yFmt || compact;
    const pad = { l: 48, r: 12, t: 14, b: 26 };
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;
    const n = o.buckets.length || 1;
    const band = plotW / n;
    const barW = Math.min(24, Math.max(3, band * 0.62));
    const GAP = 2; // the surface gap that separates stacked segments

    const totals = o.buckets.map((b) => b.segments.reduce((a, sg) => a + sg.value, 0));
    const { max: topY, ticks } = niceTicks(Math.max(0, ...totals));
    const Y = (v) => pad.t + plotH - (v / topY) * plotH;

    const svg = s("svg", { class: "viz-svg", width, height, viewBox: `0 0 ${width} ${height}`, role: "img" });
    for (const t of ticks) {
      svg.appendChild(s("line", { class: "viz-grid", x1: pad.l, x2: pad.l + plotW, y1: Y(t), y2: Y(t) }));
      svg.appendChild(s("text", { class: "viz-axis", x: pad.l - 8, y: Y(t) + 4, "text-anchor": "end", text: fmt(t) }));
    }
    svg.appendChild(s("line", { class: "viz-baseline", x1: pad.l, x2: pad.l + plotW, y1: Y(0), y2: Y(0) }));

    o.buckets.forEach((b, i) => {
      const cx = pad.l + band * i + band / 2;
      let acc = 0;
      const drawn = b.segments.filter((sg) => sg.value > 0);
      drawn.forEach((sg, j) => {
        const yTop = Y(acc + sg.value);
        const yBot = Y(acc);
        const isTop = j === drawn.length - 1;
        // Shave the gap off the top of every segment that has another segment above it.
        const hgt = Math.max(1, yBot - yTop - (isTop ? 0 : GAP));
        svg.appendChild(s("path", {
          d: roundedBarPath(cx - barW / 2, yTop + (isTop ? 0 : GAP), barW, hgt, isTop ? "top" : "square"),
          fill: sg.color,
        }));
        acc += sg.value;
      });
    });

    // X labels, thinned so they never collide.
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 58))));
    o.buckets.forEach((b, i) => {
      if (i % every !== 0 && i !== n - 1) return;
      svg.appendChild(s("text", {
        class: "viz-axis", x: pad.l + band * i + band / 2, y: height - 8, "text-anchor": "middle", text: b.label,
      }));
    });

    const wrap = h("div", { class: "viz-wrap" }, [svg]);
    const tip = attachTip(wrap);
    // Hit targets span the whole band (not just the 24px bar), so hovering never needs precision.
    o.buckets.forEach((b, i) => {
      const hit = s("rect", { x: pad.l + band * i, y: pad.t, width: band, height: plotH, fill: "transparent" });
      hit.addEventListener("mouseenter", () => {
        const total = b.segments.reduce((a, sg) => a + sg.value, 0);
        tip.show(pad.l + band * i + band / 2, Y(total), [
          h("div", { class: "viz-tip-head", text: b.tipLabel || b.label }),
          ...b.segments.map((sg) => tipRow(sg.color, sg.name, fmt(sg.value))),
        ]);
      });
      hit.addEventListener("mouseleave", () => tip.hide());
      svg.appendChild(hit);
    });

    return wrap;
  }

  // ---------- Horizontal bar chart (magnitude by category) ----------
  /**
   * One series → one color for every bar. Bar length already encodes magnitude, so a
   * darker-where-bigger ramp would double-encode it and burn the only free channel.
   *
   * @param {{label:string,value:number,note?:string}[]} o.items
   */
  function bars(o) {
    const width = Math.max(220, o.width | 0);
    const items = o.items || [];
    const fmt = o.valueFmt || compact;
    const rowH = 30;
    const barH = 14; // well under the 24px cap — thin marks, air around them
    const LABEL_GUTTER = 12; // clear air between the label column and the bar's baseline
    const labelFont = fontOf(12);
    const valueFont = fontOf(12, "600");
    const labelW = Math.round(Math.max(84, Math.min(190, width * 0.34)));
    // The value gutter is sized from the WIDEST value actually rendered, so a long figure can never
    // run off the right edge — the value always sits outside the bar end, never clipped inside it.
    const valueW = Math.ceil(Math.max(48, ...items.map((i) => textWidth(fmt(i.value), valueFont)))) + 12;
    const plotW = Math.max(20, width - labelW - valueW);
    const height = Math.max(rowH, items.length * rowH) + 6;
    const max = Math.max(1, ...items.map((i) => i.value));

    const svg = s("svg", { class: "viz-svg", width, height, viewBox: `0 0 ${width} ${height}`, role: "img" });
    const wrap = h("div", { class: "viz-wrap" }, [svg]);
    const tip = attachTip(wrap);

    items.forEach((it, i) => {
      const y = i * rowH + 6;
      const w = Math.max(2, (it.value / max) * plotW);
      svg.appendChild(s("text", {
        class: "viz-label", x: 0, y: y + barH - 2, text: fitText(it.label, labelW - LABEL_GUTTER, labelFont),
      }, [s("title", { text: it.label })]));
      svg.appendChild(s("path", {
        d: roundedBarPath(labelW, y, w, barH, "right"), fill: o.color,
      }));
      svg.appendChild(s("text", { class: "viz-value", x: labelW + w + 8, y: y + barH - 2, text: fmt(it.value) }));
      const hit = s("rect", { x: 0, y: i * rowH, width, height: rowH, fill: "transparent" });
      hit.addEventListener("mouseenter", () =>
        tip.show(labelW + w / 2, y, [
          h("div", { class: "viz-tip-head", text: it.label }),
          tipRow(o.color, o.seriesName || "value", fmt(it.value)),
          it.note ? h("div", { class: "viz-tip-note", text: it.note }) : null,
        ]),
      );
      hit.addEventListener("mouseleave", () => tip.hide());
      svg.appendChild(hit);
    });

    return wrap;
  }

  // ---------- Single stacked bar (part-to-whole) ----------
  function stack(o) {
    const width = Math.max(160, o.width | 0);
    const barH = o.height || 16;
    const GAP = 2;
    const segs = (o.segments || []).filter((sg) => sg.value > 0);
    const total = segs.reduce((a, sg) => a + sg.value, 0) || 1;
    const fmt = o.valueFmt || compact;
    const svg = s("svg", { class: "viz-svg", width, height: barH, viewBox: `0 0 ${width} ${barH}`, role: "img" });
    const wrap = h("div", { class: "viz-wrap" }, [svg]);
    const tip = attachTip(wrap);

    let x = 0;
    segs.forEach((sg, i) => {
      const isLast = i === segs.length - 1;
      const raw = (sg.value / total) * width;
      const w = Math.max(2, raw - (isLast ? 0 : GAP));
      const r = 3;
      // Round only the outer ends of the whole bar; interior joins stay square and are separated
      // by the surface gap.
      const path =
        segs.length === 1
          ? `M${x + r} 0h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${barH - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(barH - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}Z`
          : i === 0
            ? `M${x + r} 0h${w - r}v${barH}h${-(w - r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(barH - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}Z`
            : isLast
              ? `M${x} 0h${w - r}a${r} ${r} 0 0 1 ${r} ${r}v${barH - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - r)}Z`
              : `M${x} 0h${w}v${barH}h${-w}Z`;
      const node = s("path", { d: path, fill: sg.color });
      node.addEventListener("mouseenter", () =>
        tip.show(x + w / 2, 0, [tipRow(sg.color, sg.name, `${fmt(sg.value)} · ${((sg.value / total) * 100).toFixed(0)}%`)]),
      );
      node.addEventListener("mouseleave", () => tip.hide());
      svg.appendChild(node);
      x += raw;
    });
    return wrap;
  }

  // ---------- Sparkline (stat-tile trend) ----------
  function sparkline(o) {
    const width = o.width || 96;
    const height = o.height || 26;
    const vals = (o.values || []).filter((v) => typeof v === "number" && Number.isFinite(v));
    // An all-zero series is a flat rule at the baseline that encodes nothing — drop it rather than
    // draw a stray line across an empty tile.
    if (vals.length < 2 || vals.every((v) => v === 0)) return h("div", { class: "viz-spark-empty" });
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const X = (i) => (i / (vals.length - 1)) * (width - 4) + 2;
    const Y = (v) => height - 3 - ((v - min) / span) * (height - 6);
    const d = vals.map((v, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1)).join(" ");
    return h("div", { class: "viz-spark" }, [
      s("svg", { width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" }, [
        s("path", { class: "viz-spark-line", d }),
        s("circle", { class: "viz-dot-ring", cx: X(vals.length - 1), cy: Y(vals[vals.length - 1]), r: 2.75, fill: o.accent }),
      ]),
    ]);
  }

  // ---------- Meter (one ratio against a limit) ----------
  /** The unfilled track is a lighter step of the fill's own ramp, so state reads across the whole bar. */
  function meter(o) {
    const width = Math.max(80, o.width | 0);
    const hgt = 8;
    const ratio = Math.max(0, Math.min(1, o.value / (o.max || 1)));
    const svg = s("svg", { class: "viz-svg", width, height: hgt, viewBox: `0 0 ${width} ${hgt}`, "aria-hidden": "true" });
    svg.appendChild(s("rect", { x: 0, y: 0, width, height: hgt, rx: hgt / 2, fill: o.track }));
    if (ratio > 0) {
      svg.appendChild(s("rect", { x: 0, y: 0, width: Math.max(hgt, ratio * width), height: hgt, rx: hgt / 2, fill: o.color }));
    }
    return h("div", { class: "viz-meter" }, [svg]);
  }

  window.Charts = {
    h, s, compact, ms, pct, niceTicks, fitText, textWidth, fontOf,
    line, columns, bars, stack, sparkline, meter, legend, table, tipRow,
  };
})();
