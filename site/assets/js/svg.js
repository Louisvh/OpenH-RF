/* Small hand-drawn SVG charts. Each returns a <figure>; all but strip add a table of the same
   numbers for screen readers and redraw when their width changes, so text keeps its size.
   Tooltip texts go in data-tip attributes, which site.js shows on hover. */
const svg = (() => {
  "use strict";

  const CHAR_W = 7.5; // a 12px character, on the wide side
  const ROW = 24;
  let masks = 0; // for unique ids

  function build(node, attrs, children) {
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value == null) continue;
      if (name === "text") node.textContent = value;
      else node.setAttribute(name, value);
    }
    node.append(...children.flat().filter((c) => c != null && c !== false));
    return node;
  }
  const el = (tag, attrs, ...children) => build(document.createElement(tag), attrs, children);
  const sv = (tag, attrs, ...children) => build(document.createElementNS("http://www.w3.org/2000/svg", tag), attrs, children);
  const label = (attrs) => sv("text", { "aria-hidden": "true", ...attrs });
  const widest = (texts) => Math.max(0, ...texts.map((t) => t.length * CHAR_W));
  // A text's width in the page's font, where an estimate is not close enough.
  const measure = document.createElement("canvas").getContext("2d");
  const textWidth = (text, size) => {
    measure.font = `${size}px ${getComputedStyle(document.body).fontFamily}`;
    return measure.measureText(text).width;
  };
  const count = (n) => n.toLocaleString("en-US");
  const percent = (s) => (!s ? "0%" : s < 0.001 ? "<0.1%" : `${(100 * s).toFixed(s < 0.1 ? 1 : 0)}%`);

  function srTable(head, rows) {
    const row = (cells, tag) => el("tr", null, cells.map((c) => el(tag, { text: c })));
    return el("div", { class: "sr-only" }, el("table", null, row(head, "th"), rows.map((r) => row(r, "td"))));
  }

  // A key to the colours: [{label, color}].
  const keys = (items) => el("ul", { class: "legend" }, items.map((l) => el("li", null, el("span", { class: "swatch", style: `background:${l.color}` }), l.label)));

  // layout(width) -> {height, nodes}, drawn again whenever the width changes. The table
  // stands in for the chart for screen readers.
  // With fill, the chart also takes the height its card is stretched to beside a taller one,
  // as layout(width, height) makes it; alone it keeps its own height.
  function fitted(layout, fill = false) {
    const chart = sv("svg", { "font-size": 12, fill: "currentColor", "aria-hidden": "true" });
    let drawn = "";
    const draw = (width, height) => {
      if (!width || `${width} ${height}` === drawn) return;
      drawn = `${width} ${height}`;
      const { height: h, nodes } = layout(width, height);
      chart.setAttribute("viewBox", `0 0 ${width} ${h}`);
      chart.setAttribute("height", h);
      chart.replaceChildren(...nodes.filter(Boolean));
      return h;
    };
    const own = draw(480);
    if (!fill) {
      new ResizeObserver(([entry]) => draw(Math.round(entry.contentRect.width))).observe(chart);
      return chart;
    }
    // The chart is out of the box's flow; the box's height comes from the card only.
    const box = el("div", { class: "chart-fill", style: `min-height:${own}px` }, chart);
    new ResizeObserver(([entry]) => draw(Math.round(entry.contentRect.width), Math.floor(entry.contentRect.height))).observe(box);
    return box;
  }

  // 1, 10, 100, 1k, ..., 1M, 1G
  const decade = (e) => (e < 3 ? String(10 ** e) : `${10 ** (e % 3)}${"kMGTP"[Math.floor(e / 3) - 1]}`);

  // A log axis starts a decade below the smallest value (no bar is empty) and ends at the
  // largest (the longest bar fills the width).
  function logAxis(values, width) {
    const least = Math.log10(Math.min(...values));
    const lo = Math.ceil(least) - 1;
    const hi = Math.max(lo + 1, Math.log10(Math.max(...values)));
    const x = (v) => ((Math.log10(v) - lo) / (hi - lo)) * width;
    const step = Math.ceil((hi - lo) / Math.max(2, Math.floor(width / 40)));
    const ticks = [];
    for (let e = Math.floor(least); e <= hi; e += step) ticks.push([decade(e), x(10 ** e)]);
    return { x, ticks };
  }

  // rows: [{label, value, note, href, color}], or parts [{value, color}] adding up to value.
  // fade: the last row fades out downwards, for a list that goes on. legend names the colours.
  // names: the share of the width the labels may take. nameRows: the column is sized to the
  // first nameRows labels, which keeps a chart's layout when it shows more rows; a longer label
  // is cut short, whole in its tooltip. allNames: the labels of the whole list, rows shown or
  // not, whose 75th percentile width the column is at least.
  function bars(rows, { format, scale = "linear", fade, legend, names = 1 / 2, nameRows = rows.length, allNames = [] }) {
    const texts = rows.map((r) => format(r.value));
    const mask = fade && `fade-${++masks}`;
    const valueW = 8 + widest(texts);
    const layout = (width) => {
      const widths = allNames.map((t) => t.length * CHAR_W).sort((a, b) => a - b);
      const floor = widths.length ? widths[Math.floor(widths.length * 0.75)] : 0;
      const labelW = Math.min(width * names, width - valueW - 80, Math.max(floor, widest(rows.slice(0, nameRows).map((r) => r.label))));
      const x0 = labelW + 8;
      const plotW = Math.max(0, width - x0 - valueW);
      const top = Math.max(...rows.map((r) => r.value));
      const axis = scale === "log" ? logAxis(rows.map((r) => r.value), plotW) : { x: (v) => (v / top) * plotW, ticks: [] };
      const height = rows.length * ROW;
      const nodes = axis.ticks.flatMap(([text, x]) => [
        sv("line", { x1: x0 + x, x2: x0 + x, y2: height, stroke: "var(--border)" }),
        label({ x: x0 + x, y: height + 14, "text-anchor": "middle", "font-size": 11, fill: "var(--text-3)", text }),
      ]);
      if (mask) {
        const stop = (offset, color) => sv("stop", { offset, "stop-color": color });
        nodes.push(
          sv(
            "defs",
            null,
            sv("linearGradient", { id: `${mask}-g`, x2: 0, y2: 1 }, stop(0, "#fff"), stop(1, "#000")),
            sv("mask", { id: mask, maskContentUnits: "objectBoundingBox" }, sv("rect", { width: 1, height: 1, fill: `url(#${mask}-g)` })),
          ),
        );
      }
      rows.forEach((row, i) => {
        const y = i * ROW;
        const w = Math.min(plotW, axis.x(row.value));
        let at = 0;
        const fill = (row.parts || [{ value: row.value, color: row.color }]).map((p) => {
          const a = at ? axis.x(at) : 0;
          at += p.value;
          const gap = at < row.value ? 1 : 0; // between segments
          return sv("rect", { x: x0 + a, y: y + 5, width: Math.max(0, axis.x(at) - a - gap), height: 14, rx: 2, fill: p.color || "var(--bar)" });
        });
        const n = Math.floor(labelW / CHAR_W);
        const name = label({ x: 0, y: y + 16, text: row.label.length > n ? `${row.label.slice(0, n - 1)}…` : row.label });
        const tip = `${row.label}: ${texts[i]}${row.note ? ` (${row.note})` : ""}`;
        // A row with a link is a link as a whole, bar and all.
        const content = [sv("rect", { y, width, height: ROW, fill: "transparent" }), name, ...fill, label({ x: x0 + w + 6, y: y + 16, class: "value", text: texts[i] })];
        nodes.push(
          sv(
            "g",
            { "data-tip": tip, mask: mask && i === rows.length - 1 ? `url(#${mask})` : null },
            row.href ? sv("a", { href: row.href, "aria-label": row.label }, content) : content,
          ),
        );
      });
      return { height: height + (axis.ticks.length ? 20 : 0), nodes };
    };
    return el("figure", { class: "chart" }, fitted(layout), legend && keys(legend), srTable(["Name", "Value"], rows.map((r, i) => [r.label, texts[i]])));
  }

  // One stacked bar; its legend holds the links for keyboards and screen readers.
  function strip(segments, { format }) {
    const parts = segments.filter((s) => s.value > 0);
    const total = parts.reduce((s, p) => s + p.value, 0);
    const amount = (p) => `${format(p.value)} · ${percent(p.value / total)}`;
    const chart = sv("svg", { class: "strip", viewBox: "0 0 400 28", preserveAspectRatio: "none", "aria-hidden": "true" });
    const tip = (p) => p.tip || `${p.label}: ${amount(p)}${p.note ? ` (${p.note})` : ""}`;
    let x = 0;
    for (const p of parts) {
      const w = (p.value / total) * 400;
      const rect = sv("rect", { x, width: w, height: 28, fill: p.color });
      chart.append(p.href ? sv("a", { href: p.href, tabindex: -1, "data-tip": tip(p) }, rect) : sv("g", { "data-tip": tip(p) }, rect));
      x += w;
    }
    const legend = el(
      "ul",
      { class: "legend" },
      parts.map((p) =>
        el(
          "li",
          { "data-tip": tip(p) },
          el("span", { class: "swatch", style: `background:${p.color}` }),
          p.href ? el("a", { href: p.href, text: p.label }) : p.label,
          " ",
          el("span", { class: "muted", text: format(p.value) }),
        ),
      ),
    );
    return el("figure", { class: "chart" }, chart, legend);
  }

  // The selection (blue) in front of all datasets (grey), each as shares of its own total,
  // so one dataset keeps its shape next to all of them. A selection of everything is drawn
  // alone. labels mark the axis below the bins' centres ("" for none), names name the bins.
  // marks: [{at, text}] rule the axis, dashed, at bin positions (2.5 is halfway through the
  // third bin).
  function hist(counts, { corpus, labels, names, marks = [] }) {
    const shares = (series) => {
      const total = series.reduce((a, b) => a + b, 0);
      return series.map((n) => (total ? n / total : 0));
    };
    const ours = shares(counts);
    const all = shares(corpus);
    const top = Math.max(...ours, ...all);
    const alone = counts.every((n, i) => n === corpus[i]);
    const H = 48;
    const layout = (width) => {
      const binW = (width - 48) / corpus.length;
      const nodes = corpus.map((_, i) => {
        const x = 24 + i * binW;
        const bar = (s, inset, fill) => {
          const h = Math.max(1, (s / top) * H);
          return s > 0 && sv("rect", { x: x + inset, y: H - h, width: binW - 2 * inset, height: h, fill });
        };
        const tip = alone
          ? `${names[i]}: ${count(counts[i])}, ${percent(ours[i])}`
          : corpus[i]
            ? `${names[i]}: ${count(counts[i])} of ${count(corpus[i])}; ${percent(ours[i])} of the selection, ${percent(all[i])} of all datasets`
            : `${names[i]}: none`;
        return sv(
          "g",
          { "data-tip": tip },
          sv("rect", { x, width: binW, height: H, fill: "transparent" }),
          !alone && bar(all[i], 0.5, "var(--mixed)"),
          bar(ours[i], alone ? 0.5 : Math.max(0.5, binW / 5), "var(--bar)"),
        );
      });
      nodes.push(sv("line", { x1: 24, x2: width - 24, y1: H, y2: H, stroke: "var(--border)" }));
      for (const m of marks) {
        const x = 24 + m.at * binW;
        const left = m.at > corpus.length * 0.6;
        nodes.push(
          sv("line", { x1: x, x2: x, y1: 0, y2: H, stroke: "var(--text-3)", "stroke-dasharray": "3 2" }),
          label({ x: x + (left ? -4 : 4), y: 22, "text-anchor": left ? "end" : "start", "font-size": 11, fill: "var(--text-3)", text: m.text }),
        );
      }
      // From the left, each label that clears the one before it.
      let right = -Infinity;
      labels.forEach((text, i) => {
        const x = 24 + (i + 0.5) * binW;
        const half = (text.length * CHAR_W * 11) / 24;
        if (!text || x - half < right + 8) return;
        right = x + half;
        nodes.push(
          sv("line", { x1: x, x2: x, y1: H, y2: H + 4, stroke: "var(--border)" }),
          label({ x, y: H + 16, "text-anchor": "middle", "font-size": 11, fill: "var(--text-3)", text }),
        );
      });
      return { height: H + 20, nodes };
    };
    const table = alone
      ? srTable(["Range", "Count"], counts.map((n, i) => [names[i], count(n)]))
      : srTable(["Range", "Selection", "All datasets"], corpus.map((n, i) => [names[i], count(counts[i]), count(n)]));
    return el("figure", { class: "chart" }, fitted(layout), table);
  }

  // rows: [{label, href, cells: [share, ...]}] against cols: [{label, href}]; a cell's colour
  // is its share, and it links to its column.
  function heat(rows, cols, { format }) {
    const RH = 19;
    const layout = (width) => {
      const labelW = Math.min(width / 6, widest(rows.map((r) => r.label)));
      const cellW = (width - labelW - 48) / cols.length;
      const nodes = [];
      rows.forEach((row, i) => {
        const y = i * RH;
        const n = Math.floor(labelW / CHAR_W);
        const name = label({ x: 0, y: y + 14, "font-size": 11, text: row.label.length > n ? `${row.label.slice(0, n - 1)}…` : row.label });
        nodes.push(row.href ? sv("a", { href: row.href, "aria-label": row.label }, name) : name);
        row.cells.forEach((s, j) => {
          const cell = sv("rect", { x: labelW + 8 + j * cellW + 1, y: y + 1, width: cellW - 2, height: RH - 2, rx: 2, fill: "var(--bar)", "fill-opacity": s ? 0.15 + 0.85 * s : 0.05, "data-tip": `${cols[j].label}: ${format(s)}` });
          nodes.push(cols[j].href ? sv("a", { href: cols[j].href }, cell) : cell);
        });
      });
      // Column names go below the grid, centred and wrapped at spaces to the cell width;
      // slanted instead when the cells are too narrow for that.
      const y = rows.length * RH + 14;
      const slant = cellW < 24;
      const wide = (t) => (t.length * CHAR_W * 11) / 12;
      const wrap = (text) =>
        text.split(" ").reduce((lines, word) => {
          const last = lines.length - 1;
          if (last >= 0 && wide(`${lines[last]} ${word}`) <= cellW) lines[last] += ` ${word}`;
          else lines.push(word);
          return lines;
        }, []);
      let lines = 0;
      cols.forEach((c, j) => {
        const x = labelW + 8 + (j + 0.5) * cellW;
        const text = { "font-size": 11, fill: "var(--text-3)" };
        if (slant) return nodes.push(label({ x, y: y - 10, transform: `rotate(70 ${x} ${y - 10})`, ...text, text: c.label }));
        const words = wrap(c.label);
        lines = Math.max(lines, words.length);
        words.forEach((t, i) => nodes.push(label({ x, y: y + i * 13, "text-anchor": "middle", ...text, text: t })));
      });
      const names = cols.map((c) => c.label);
      return { height: slant ? y + widest(names) * 0.94 : y + 13 * lines, nodes };
    };
    return el("figure", { class: "chart" }, fitted(layout), srTable(["Dataset", ...cols.map((c) => c.label)], rows.map((r) => [r.label, ...r.cells.map(format)])));
  }

  // points: [{x, y, r, color, label, href}] on two log axes, the larger drawn first.
  // diagonal names a dashed y = x line.
  // fill: taller, to the height of the card beside it (see fitted).
  function dots(points, { xTicks, yTicks, xTick = String, yTick = String, xLabel, yLabel, format, legend, diagonal, fill }) {
    // A point without x or y sits in a band left of or below the plot, marked "?"; one
    // without either is left out.
    points = points.filter((p) => p.x != null || p.y != null);
    const band = (key) => (points.some((p) => p[key] == null) ? 28 : 0);
    const GX = band("x");
    const GY = band("y");
    const below = GY + 20 + (xLabel ? 20 : 0); // the "?" band, the ticks and the label
    // The padded [lo, hi] of an axis, in decades, and where a value falls in it.
    const axis = (values, ticks) => {
      const lo = Math.log10(Math.min(...values, ticks[0]));
      const hi = Math.log10(Math.max(...values, ticks[ticks.length - 1]));
      const pad = (hi - lo) / 20;
      return [lo - pad, hi + pad];
    };
    const at = ([lo, hi], v) => (Math.log10(v) - lo) / (hi - lo);
    const ax = axis(points.map((p) => p.x).filter((v) => v != null), xTicks);
    const ay = axis(points.map((p) => p.y).filter((v) => v != null), yTicks);
    const fx = (v) => at(ax, v);
    const fy = (v) => at(ay, v);
    // The diagonal runs between the decades both axes show.
    const [d0, d1] = [10 ** Math.max(ax[0], ay[0]), 10 ** Math.min(ax[1], ay[1])];
    const layout = (width, height) => {
      const bottom = Math.max(200, (height || 0) - below); // the x axis; the "?" band and the ticks go below it
      const H = bottom + GY + 20;
      const x0 = (yLabel ? 26 : 8) + widest(yTicks.map(yTick));
      const left = x0 + GX;
      const x = (v) => (v == null ? x0 + GX / 2 : left + fx(v) * (width - left - 12));
      const y = (v) => (v == null ? bottom + GY / 2 : 8 + (1 - fy(v)) * (bottom - 8));
      const tick = { "font-size": 11, fill: "var(--text-3)" };
      const dashed = { stroke: "var(--border-strong)", "stroke-dasharray": "4 3" };
      const nodes = [
        ...xTicks.map((t) => label({ x: x(t), y: H - 2, "text-anchor": "middle", ...tick, text: xTick(t) })),
        ...yTicks.map((t) => label({ x: x0 - 6, y: y(t) + 4, "text-anchor": "end", ...tick, text: yTick(t) })),
        ...yTicks.map((t) => sv("line", { x1: left, x2: width - 12, y1: y(t), y2: y(t), stroke: "var(--border)" })),
        GX && label({ x: x(null), y: H - 2, "text-anchor": "middle", ...tick, text: "?" }),
        GY && label({ x: x0 - 6, y: y(null) + 4, "text-anchor": "end", ...tick, text: "?" }),
        GX && sv("line", { x1: left, x2: left, y1: 8, y2: bottom + GY, ...dashed }),
        GY && sv("line", { x1: x0, x2: width - 12, y1: bottom, y2: bottom, ...dashed }),
        xLabel && label({ x: (x0 + width - 12) / 2, y: H + 16, "text-anchor": "middle", "font-size": 12, fill: "var(--text-2)", text: xLabel }),
        yLabel && label({ transform: `translate(12 ${(H - 12) / 2}) rotate(-90)`, "text-anchor": "middle", "font-size": 12, fill: "var(--text-2)", text: yLabel }),
        diagonal && sv("line", { x1: x(d0), y1: y(d0), x2: x(d1), y2: y(d1), ...dashed }),
        diagonal && label({ x: x(d0) + 8, y: y(d0) + 14, ...tick, text: diagonal }),
      ];
      for (const p of [...points].sort((a, b) => b.r - a.r)) {
        const dot = sv("circle", { cx: x(p.x), cy: y(p.y), r: p.r, fill: p.color, "fill-opacity": 0.75, stroke: "var(--bg)", "data-tip": `${p.label}: ${format(p)}` });
        nodes.push(p.href ? sv("a", { href: p.href, "aria-label": p.label }, dot) : dot);
      }
      return { height: xLabel ? H + 20 : H, nodes };
    };
    return el(
      "figure",
      { class: fill ? "chart fill" : "chart" },
      fitted(layout, fill),
      legend && keys(legend),
      srTable(["Name", "Value"], points.map((p) => [p.label, format(p)])),
    );
  }

  // The paper's elements-against-frequency figure: a dot per probe setting, of area growing
  // with the square root of its acquisitions, and a smooth histogram of the acquisitions
  // along each axis, per decade. The element axis is broken where no probe is. Hovering a
  // class in the key, or one of its dots, draws its histograms, each to its own height, and
  // fades the other classes' dots.
  // points: [{x, y, n, cls, color, tip, href}] in the order drawn; classes: [{id, label, color, n}].
  function probes(points, classes, { xLabel, yLabel, sizeLabel, format }) {
    const BANDWIDTH = 0.04; // of the histograms' kernel, in decades
    const BREAKS = [[1, 50], [300, 1000]];
    const BREAK_GAP = 0.24; // decades
    const ALPHA = 0.75;
    // The paper's proportions, in inches: the scatter, the histograms' depth and their gap.
    const [PW, PH, SIDE, GAP] = [2.25, 1.8, 0.5, 0.04];
    const log = Math.log10;

    // Decades up the element axis, each break BREAK_GAP high: at the knots t (in decades
    // of elements) the axis is at p.
    const t = BREAKS.flat().map(log);
    const p = t.map((_, i) => t.at(-1) - t.slice(i, -1).reduce((s, _, j) => s + ((i + j) % 2 ? t[i + j + 1] - t[i + j] : BREAK_GAP), 0));
    const broken = (v) => {
      const e = log(Math.max(v, 1e-3));
      if (e < t[0]) return e - t[0] + p[0];
      if (e > t.at(-1)) return e;
      const i = t.findIndex((k, j) => e <= t[j + 1]);
      return p[i] + ((e - t[i]) / (t[i + 1] - t[i])) * (p[i + 1] - p[i]);
    };
    // Matplotlib's limits: the frequencies get its 5% margin twice (the histogram above
    // shares the axis), the elements once above and 0.7 below.
    const fs = points.map((q) => log(q.x));
    const es = points.map((q) => broken(q.y));
    const [f0, f1] = [Math.min(...fs), Math.max(...fs)];
    const ax = [f0 - 0.105 * (f1 - f0), f1 + 0.105 * (f1 - f0)];
    const ay = [broken(0.7), Math.max(...es) + 0.05 * (Math.max(...es) - broken(1))];

    // Acquisitions per decade on a grid along each axis, of all points and of each class.
    const GRID = 300;
    const smooth = (at, lo, hi, rows) =>
      Array.from({ length: GRID }, (_, i) => {
        const g = lo + ((hi - lo) * i) / (GRID - 1);
        return rows.reduce((s, q) => s + q.n * Math.exp(-0.5 * ((g - at(q)) / BANDWIDTH) ** 2), 0) / (BANDWIDTH * Math.sqrt(2 * Math.PI));
      });
    const densities = (at, [lo, hi]) => ({
      all: smooth(at, lo, hi, points),
      ...Object.fromEntries(classes.map((c) => [c.id, points.some((q) => q.cls === c.id) ? smooth(at, lo, hi, points.filter((q) => q.cls === c.id)) : null])),
    });
    const above = densities((q) => log(q.x), ax);
    const beside = densities((q) => broken(q.y), ay);

    const xDecades = [];
    const xMinor = [];
    for (let e = Math.floor(ax[0]); e <= ax[1]; e++) {
      if (e >= ax[0]) xDecades.push(10 ** e);
      for (let k = 2; k < 10; k++) if (log(k * 10 ** e) >= ax[0] && log(k * 10 ** e) <= ax[1]) xMinor.push(k * 10 ** e);
    }
    const edges = BREAKS.flat().filter((v) => ![1, 100, 1000].includes(v));
    const yTicks = [1, 100, 1000, ...edges].sort((a, b) => a - b).filter((v) => broken(v) <= ay[1]);
    const yMinor = [10, 100].flatMap((d) => [2, 3, 4, 5, 6, 7, 8, 9].map((k) => k * d)).filter((v) => !yTicks.includes(v) && !BREAKS.some(([a, b]) => a < v && v < b) && broken(v) <= ay[1]);

    let active = null; // the class hovered in the key
    let drawn = null; // what setActive changes in the chart drawn last

    const layout = (width) => {
      const x0 = 26 + widest(yTicks.map(String)); // the tick labels end 6px left of it
      const L = x0 + 4; // the left spine
      const inch = Math.min(560 / PW, (width - L - 4) / (PW + GAP + SIDE)); // pixels per paper inch
      const [pw, ph, side, gap] = [PW, PH, SIDE, GAP].map((v) => v * inch);
      const top = side + gap; // of the scatter
      const bottom = top + ph;
      const right = L + pw;
      const x = (v) => L + ((log(v) - ax[0]) / (ax[1] - ax[0])) * pw;
      const y = (v) => bottom - ((broken(v) - ay[0]) / (ay[1] - ay[0])) * ph;
      // The paper's dot areas: 7.2 pt² at 10 acquisitions and 72 at 1000, on a 2.25 in scatter.
      const radius = (n) => (Math.sqrt(7.2 * Math.sqrt(n / 10)) / 72) * inch / 2;
      const rule = { stroke: "var(--border-strong)" };
      const tick = { "font-size": 11, fill: "var(--text-3)" };
      const nodes = [
        ...xMinor.map((v) => sv("line", { x1: x(v), x2: x(v), y1: top, y2: bottom, stroke: "var(--border)", "stroke-width": 0.6, "stroke-opacity": 0.6 })),
        ...yMinor.map((v) => sv("line", { x1: L, x2: right, y1: y(v), y2: y(v), stroke: "var(--border)", "stroke-width": 0.6, "stroke-opacity": 0.6 })),
        ...xDecades.map((v) => sv("line", { x1: x(v), x2: x(v), y1: top, y2: bottom, stroke: "var(--border)" })),
        ...yTicks.map((v) => sv("line", { x1: L, x2: right, y1: y(v), y2: y(v), ...(edges.includes(v) ? { ...rule, "stroke-dasharray": "4 3" } : { stroke: "var(--border)" }) })),
        ...xMinor.map((v) => sv("line", { x1: x(v), x2: x(v), y1: bottom, y2: bottom + 2.5, ...rule })),
        ...xDecades.map((v) => sv("line", { x1: x(v), x2: x(v), y1: bottom, y2: bottom + 4.5, ...rule })),
        ...yMinor.map((v) => sv("line", { x1: L - 2.5, x2: L, y1: y(v), y2: y(v), ...rule })),
        ...yTicks.map((v) => sv("line", { x1: L - 4.5, x2: L, y1: y(v), y2: y(v), ...rule })),
        ...xDecades.map((v) => label({ x: x(v), y: bottom + 17, "text-anchor": "middle", ...tick, text: format(v) })),
        ...yTicks.map((v) => label({ x: x0 - 6, y: y(v) + 4, "text-anchor": "end", ...tick, text: format(v) })),
        label({ x: L + pw / 2, y: bottom + 37, "text-anchor": "middle", "font-size": 12, fill: "var(--text-2)", text: xLabel }),
        label({ transform: `translate(12 ${top + ph / 2}) rotate(-90)`, "text-anchor": "middle", "font-size": 12, fill: "var(--text-2)", text: yLabel }),
        sv("line", { x1: L, x2: right, y1: bottom, y2: bottom, ...rule }),
      ];
      // The left spine, with a zigzag in place of each break.
      const spine = [[0, ay[0]]];
      for (const [lo, hi] of BREAKS) {
        const [a, b] = [broken(lo), broken(hi)];
        if (b > ay[1]) break;
        [0, -3.5, 3.5, -3.5, 3.5, 0].forEach((dx, i) => spine.push([dx, a + ((b - a) * i) / 5]));
      }
      spine.push([0, ay[1]]);
      const up = (pos) => bottom - ((pos - ay[0]) / (ay[1] - ay[0])) * ph;
      nodes.push(sv("polyline", { points: spine.map(([dx, pos]) => `${L + dx},${up(pos)}`).join(" "), fill: "none", ...rule, "stroke-linejoin": "miter" }));

      const dots = points.map((q) => {
        const dot = sv("circle", { cx: x(q.x), cy: y(q.y), r: radius(q.n), fill: q.color, stroke: "var(--bg)", "data-tip": q.tip });
        // As hovering its class in the key.
        dot.addEventListener("pointerenter", () => setActive(q.cls));
        dot.addEventListener("pointerleave", () => active === q.cls && setActive(null));
        return dot;
      });
      nodes.push(...dots.map((dot, i) => (points[i].href ? sv("a", { href: points[i].href, "aria-label": points[i].tip.split("\n")[0] }, dot) : dot)));

      // The histograms: all acquisitions, and in front of them the hovered class's.
      // point(i, s) is where the histogram is at grid point i when at s of its height.
      const band = (densities, point) => {
        const xy = (i, s) => point(i, s).join(",");
        const path = (d, peak) => d && `M${xy(0, 0)} ${d.map((v, i) => `L${xy(i, v / (peak * 1.05))}`).join(" ")} L${xy(GRID - 1, 0)}Z`;
        // The outline stops where the histogram is under half an acquisition per decade,
        // so it does not run along the baseline.
        const outline = (d, peak) => d && d.map((v, i) => (v > 0.5 ? `${i && d[i - 1] > 0.5 ? "L" : "M"}${xy(i, v / (peak * 1.05))}` : "")).join(" ");
        const all = sv("path", { fill: "var(--text-2)" });
        const allLine = sv("path", { fill: "none", stroke: "var(--text-2)" });
        const own = sv("path", { "fill-opacity": 0.5 });
        const ownLine = sv("path", { fill: "none" });
        const draw = () => {
          const peak = Math.max(...densities.all);
          all.setAttribute("d", path(densities.all, peak));
          all.setAttribute("fill-opacity", active ? 0.15 : 0.5);
          allLine.setAttribute("d", active ? "" : outline(densities.all, peak));
          const d = active && densities[active];
          const color = (d && classes.find((c) => c.id === active).color) || "none";
          const top = d ? Math.max(...d) : 1;
          for (const [node, attr, value] of [[own, "d", path(d, top) || ""], [own, "fill", color], [ownLine, "d", outline(d, top) || ""], [ownLine, "stroke", color]]) node.setAttribute(attr, value);
        };
        return { nodes: [all, allLine, own, ownLine], draw };
      };
      const bands = [
        band(above, (i, s) => [L + (i / (GRID - 1)) * pw, side - s * side]),
        band(beside, (i, s) => [right + gap + s * side, bottom - (i / (GRID - 1)) * ph]),
      ];
      nodes.push(...bands.flatMap((b) => b.nodes));
      nodes.push(
        sv("line", { x1: L, x2: right, y1: side, y2: side, ...rule }),
        sv("line", { x1: right + gap, x2: right + gap, y1: top, y2: bottom, ...rule }),
      );

      // The key to the dot sizes, over the tail of the histogram above, as in the paper: level
      // with its peak, in two columns that end ("1,000") over the scatter's right edge, under
      // a title centred on them.
      const keys = [1, 10, 100, 1000];
      const rMax = radius(1000);
      const rowH = Math.max(2 * rMax + 2, 15);
      const colW = [keys.slice(0, 2), keys.slice(2)].map((col) => 2 * rMax + 5 + Math.max(...col.map((n) => textWidth(n.toLocaleString("en-US"), 11))));
      const keyW = colW[0] + 10 + colW[1];
      const kx = right - keyW;
      const ky = side - side / 1.05;
      nodes.push(label({ x: kx + keyW / 2, y: ky + 10, "text-anchor": "middle", "font-size": 11, fill: "var(--text-2)", text: sizeLabel }));
      keys.forEach((n, i) => {
        const cx = kx + (i < 2 ? 0 : colW[0] + 10) + rMax;
        const cy = ky + 16 + (i % 2 + 0.5) * rowH;
        nodes.push(
          sv("circle", { cx, cy, r: radius(n), fill: "var(--text-3)", "fill-opacity": ALPHA, stroke: "var(--bg)" }),
          label({ x: cx + rMax + 5, y: cy + 4, ...tick, fill: "var(--text-2)", text: n.toLocaleString("en-US") }),
        );
      });

      drawn = { dots, bands };
      setActive(active);
      return { height: bottom + 44, nodes };
    };

    function setActive(id) {
      active = id;
      if (!drawn) return;
      drawn.dots.forEach((dot, i) => dot.setAttribute("fill-opacity", !active || points[i].cls === active ? ALPHA : ALPHA / 2));
      drawn.bands.forEach((b) => b.draw());
    }

    const total = classes.reduce((s, c) => s + c.n, 0);
    const share = (n) => (n / total < 0.001 ? "<0.1%" : `${((100 * n) / total).toFixed(1)}%`);
    const key = el(
      "ul",
      { class: "legend probe-classes" },
      classes.map((c) => {
        const item = el(
          "li",
          { tabindex: 0 },
          el("span", { class: "swatch", style: `background:${c.color};opacity:${ALPHA}` }),
          c.label,
          " ",
          el("span", { class: "muted", text: `${count(c.n)} (${share(c.n)})` }),
        );
        const on = () => setActive(c.id);
        const off = () => active === c.id && setActive(null);
        item.addEventListener("pointerenter", on);
        item.addEventListener("pointerleave", off);
        item.addEventListener("focus", on);
        item.addEventListener("blur", off);
        return item;
      }),
    );
    return el("figure", { class: "chart" }, key, fitted(layout), srTable(["Probe setting", "Acquisitions"], points.map((q) => [q.tip.split("\n")[0], count(q.n)])));
  }

  return { bars, strip, hist, heat, dots, probes };
})();
