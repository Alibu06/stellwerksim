import { Graph, Signal } from "../sim/graph";
import { World, Train } from "../sim/world";

// Gleisbild im Stil eines modernen elektronischen Stellwerks (eigenes Design).
// Die Strecke kann in mehrere Zeilen untereinander umbrochen werden, lange Streckengleise werden gestaucht.

export const COLORS = {
  bg: "#0c1015",
  band: "#10161d",
  bandLine: "#1b2430",
  track: "#5b6775",
  route: "#2fd27a",
  overlap: "#1d7a4a",
  occupied: "#ff4d57",
  platform: "#25405a",
  text: "#9fb0c3",
  textDim: "#5f6f82",
  red: "#ff3b47",
  green: "#2fd27a",
  yellow: "#ffd23f",
  white: "#f2f6fa",
  target: "#36c5f0",
  fault: "#ff9f1c",
};

export const CAT_COLOR: Record<string, string> = { S: "#22b866", RE: "#e04646", RB: "#4a82ea", ICE: "#eef2f6", G: "#c4882f" };

export type Hit =
  | { kind: "signal"; sig: Signal }
  | { kind: "switch"; node: number }
  | { kind: "train"; train: Train }
  | { kind: "portal"; code: string }
  | { kind: "break"; x: number }
  | { kind: "edge"; edge: number };

interface Band {
  x0: number; // Roh-x Beginn (inklusive)
  x1: number; // Roh-x Ende (exklusive)
  ymin: number;
  ymax: number;
  top: number; // Zeilenoberkante in Rastereinheiten
}

const PAD_L = 9, PAD_R = 5, PAD_TOP = 3.0, PAD_BOT = 1.8, GAP = 0.8;

export class View {
  zoom = 1;
  panX = 0;
  panY = 0;
  selected = 0;
  targets = new Map<string, boolean>();
  focusTrain: Train | null = null;
  editBreaks = false;
  breaks: number[] = [];
  candidates: number[] = [];
  bands: Band[] = [];
  private trainBoxes: { t: Train; x: number; y: number; w: number; h: number }[] = [];
  private blink = 0;
  private wxs: number[] = [];
  private wcum: number[] = [];

  constructor(public canvas: HTMLCanvasElement, public g: Graph, public w: World) {
    // Stauchung langer Abschnitte ohne Knoten (offene Strecke)
    const xs = [...new Set(g.nodes.map((n) => n.x))].sort((a, b) => a - b);
    this.wxs = xs;
    this.wcum = [0];
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      this.wcum.push(this.wcum[i - 1] + (d <= 3 ? d : 3 + (d - 3) * 0.4));
    }
    this.candidates = [...g.breakpoints].sort((a, b) => a - b);
    this.setBreaks([]);
  }

  get sx() { return 26 * this.zoom; }
  get sy() { return 30 * this.zoom; }

  W(x: number) {
    const xs = this.wxs, c = this.wcum;
    if (x <= xs[0]) return x - xs[0];
    for (let i = 1; i < xs.length; i++) {
      if (x <= xs[i]) {
        const f = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
        return c[i - 1] + f * (c[i] - c[i - 1]);
      }
    }
    return c[c.length - 1] + (x - xs[xs.length - 1]);
  }

  bandOf(x: number) {
    let b = 0;
    while (b < this.breaks.length && x >= this.breaks[b]) b++;
    return b;
  }

  setBreaks(br: number[]) {
    this.breaks = [...br].sort((a, b) => a - b);
    const xmin = Math.min(...this.g.nodes.map((n) => n.x)), xmax = Math.max(...this.g.nodes.map((n) => n.x));
    const edges = [xmin - 0.001, ...this.breaks, xmax + 0.001];
    this.bands = [];
    let top = 0;
    for (let i = 0; i + 1 < edges.length; i++) {
      const x0 = edges[i], x1 = edges[i + 1];
      let ymin = Infinity, ymax = -Infinity;
      for (const n of this.g.nodes) if (n.x >= x0 && n.x < x1) { ymin = Math.min(ymin, n.y); ymax = Math.max(ymax, n.y); }
      for (const s of Object.values(this.g.stations)) if (s.x >= x0 && s.x < x1) { ymin = Math.min(ymin, s.y - 0.2); ymax = Math.max(ymax, s.y); }
      if (!isFinite(ymin)) { ymin = 0; ymax = 1; }
      this.bands.push({ x0: i === 0 ? -Infinity : x0, x1: i === edges.length - 2 ? Infinity : x1, ymin, ymax, top });
      top += ymax - ymin + PAD_TOP + PAD_BOT + GAP;
    }
    this.bands[0].x0 = -Infinity;
    (this as any)._xmin = xmin;
  }

  // Gleichmäßige Aufteilung auf n Zeilen
  autoRows(n: number) {
    const xmin = Math.min(...this.g.nodes.map((n) => n.x)), xmax = Math.max(...this.g.nodes.map((n) => n.x));
    // Umbruchstellen so wählen, dass die breiteste Zeile möglichst schmal wird
    const pts = [xmin, ...this.candidates.filter((c) => c > xmin && c < xmax), xmax];
    const w = pts.map((x) => this.W(x));
    const m = pts.length;
    const rows = Math.min(n, m - 1);
    const best: number[][] = Array.from({ length: rows + 1 }, () => Array(m).fill(Infinity));
    const from: number[][] = Array.from({ length: rows + 1 }, () => Array(m).fill(-1));
    best[0][0] = 0;
    for (let r = 1; r <= rows; r++)
      for (let j = 1; j < m; j++)
        for (let i = 0; i < j; i++) {
          const v = Math.max(best[r - 1][i], w[j] - w[i]);
          if (v < best[r][j]) { best[r][j] = v; from[r][j] = i; }
        }
    const br: number[] = [];
    let j = m - 1;
    for (let r = rows; r > 1; r--) { j = from[r][j]; br.push(pts[j]); }
    this.setBreaks(br);
  }

  toggleBreak(x: number) {
    this.setBreaks(this.breaks.includes(x) ? this.breaks.filter((b) => b !== x) : [...this.breaks, x]);
  }

  bandStartW(b: number) {
    const bd = this.bands[b];
    return this.W(b === 0 ? (this as any)._xmin : bd.x0);
  }

  // Weltkoordinate -> Bildschirm, mit expliziter Zeile
  Pb(x: number, y: number, b: number) {
    const bd = this.bands[b];
    return {
      x: (this.W(x) - this.bandStartW(b) + PAD_L) * this.sx + this.panX,
      y: (y - bd.ymin + PAD_TOP + bd.top) * this.sy + this.panY,
    };
  }

  P(x: number, y: number) {
    return this.Pb(x, y, this.bandOf(x));
  }

  contentSize() {
    let w = 0;
    this.bands.forEach((bd, i) => {
      const x1 = i === this.bands.length - 1 ? Math.max(...this.g.nodes.map((n) => n.x)) : bd.x1;
      w = Math.max(w, this.W(x1) - this.bandStartW(i));
    });
    const last = this.bands[this.bands.length - 1];
    return { w: w + PAD_L + PAD_R + 4, h: last.top + last.ymax - last.ymin + PAD_TOP + PAD_BOT };
  }

  fit() {
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const c = this.contentSize();
    this.zoom = Math.max(0.3, Math.min(3, Math.min(W / (c.w * 26), H / (c.h * 30))));
    const cw = c.w * this.sx, ch = c.h * this.sy;
    this.panX = Math.max(0, (W - cw) / 2);
    this.panY = Math.max(0, (H - ch) / 2);
  }

  centerOn(x: number, y: number) {
    const p = this.P(x, y);
    this.panX += this.canvas.clientWidth / 2 - p.x;
    this.panY += this.canvas.clientHeight / 2 - p.y;
  }

  zoomAt(px: number, py: number, f: number) {
    const nz = Math.max(0.3, Math.min(4, this.zoom * f));
    const k = nz / this.zoom;
    this.panX = px - (px - this.panX) * k;
    this.panY = py - (py - this.panY) * k;
    this.zoom = nz;
  }

  sigPos(s: Signal) {
    const n = this.g.nodes[s.node];
    const p = this.P(n.x - s.dir * 0.001, n.y);
    const k = Math.min(Math.max(this.zoom, 0.6), 1.5);
    return { x: p.x - s.dir * 10 * k, y: p.y + s.dir * 10 * k };
  }

  // ---------------- Zeichnen ----------------
  // Bahnübergänge: kurzer Querstrich über alle Gleise, Farbe nach Zustand
  private drawCrossings(ctx: CanvasRenderingContext2D) {
    const ext = this.w.ext;
    if (!ext.f.bue) return;
    const blink = Math.floor(performance.now() / 500) % 2 === 0;
    for (const c of ext.crossings) {
      const pts: { x: number; y: number }[] = [];
      for (const id of c.edges) {
        const e = this.g.edges[id];
        const A = this.g.nodes[e.a], B = this.g.nodes[e.b];
        const sa = A.s ?? 0, sb = B.s ?? 0;
        if (sa === sb) continue;
        const f = (c.s - sa) / (sb - sa);
        const a = this.P(A.x + 1e-6, A.y), b = this.P(B.x - 1e-6, B.y);
        if (Math.abs(a.y - b.y) > 80) continue;
        pts.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      }
      if (!pts.length) continue;
      const x = pts.reduce((q, p) => q + p.x, 0) / pts.length;
      const y0 = Math.min(...pts.map((p) => p.y)) - 9 * this.k, y1 = Math.max(...pts.map((p) => p.y)) + 9 * this.k;
      const fault = c.faultUntil > 0 || c.blockedUntil > 0;
      const col = fault ? (blink ? COLORS.fault : "#5a2a2a") : c.closed ? COLORS.yellow : "#8597ab";
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 3 * this.k, y0); ctx.lineTo(x - 3 * this.k, y1);
      ctx.moveTo(x + 3 * this.k, y0); ctx.lineTo(x + 3 * this.k, y1);
      ctx.stroke();
      if (this.zoom > 0.55) {
        ctx.font = this.mono(7, 700);
        ctx.fillStyle = col;
        ctx.textAlign = "center";
        ctx.fillText("BÜ", x, y1 + 8 * this.k);
      }
    }
  }

  draw(dt: number) {
    this.blink += dt;
    const c = this.canvas, ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    const Wd = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(Wd * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(Wd * dpr);
      c.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, Wd, H);
    this.drawBands(ctx);
    this.drawLabels(ctx);
    this.drawPlatforms(ctx);
    this.drawTracks(ctx);
    this.drawCrossings(ctx);
    this.drawTrainBodies(ctx);
    this.drawSwitches(ctx);
    this.drawDistants(ctx);
    this.drawSignals(ctx);
    this.drawPortals(ctx);
    this.drawTrainLabels(ctx);
    if (this.editBreaks) this.drawBreakEditor(ctx);
  }

  private get k() { return Math.min(Math.max(this.zoom * 1.15, 0.85), 1.6); }
  private mono(px: number, weight = 500) { return `${weight} ${Math.round(px * this.k)}px "JetBrains Mono", ui-monospace, Menlo, monospace`; }
  private sans(px: number, weight = 600) { return `${weight} ${Math.round(px * this.k)}px Inter, system-ui, sans-serif`; }

  private drawBands(ctx: CanvasRenderingContext2D) {
    if (this.bands.length < 2) return;
    const c = this.contentSize();
    this.bands.forEach((bd, i) => {
      const y0 = (bd.top) * this.sy + this.panY;
      const h = (bd.ymax - bd.ymin + PAD_TOP + PAD_BOT) * this.sy;
      ctx.fillStyle = COLORS.band;
      ctx.strokeStyle = COLORS.bandLine;
      ctx.lineWidth = 1;
      roundRect(ctx, this.panX + 4, y0, c.w * this.sx - 8, h, 8);
      ctx.fill();
      ctx.stroke();
    });
  }

  // Strecke zwischen zwei Weltpunkten zeichnen, an Zeilenumbrüchen aufteilen
  private seg(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, cuts?: (p: { x: number; y: number }, dir: 1 | -1) => void) {
    if (x2 < x1) [x1, y1, x2, y2] = [x2, y2, x1, y1];
    let b = this.bandOf(x1);
    let cx = x1, cy = y1;
    const bEnd = this.bandOf(x2 - 1e-9);
    while (b < bEnd) {
      const br = this.breaks[b];
      const f = (br - x1) / (x2 - x1);
      const by = y1 + f * (y2 - y1);
      const p = this.Pb(cx, cy, b), q = this.Pb(br, by, b);
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      cuts?.(q, 1);
      const r = this.Pb(br, by, b + 1);
      cuts?.(r, -1);
      cx = br;
      cy = by;
      b++;
    }
    const p = this.Pb(cx, cy, b), q = this.Pb(x2, y2, b);
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
  }

  private drawLabels(ctx: CanvasRenderingContext2D) {
    ctx.textAlign = "center";
    for (const [code, s] of Object.entries(this.g.stations)) {
      const p = this.P(s.x, s.y - (s.y < 4 ? 0.7 : -0.3));
      ctx.font = this.sans(12, 650);
      ctx.fillStyle = "#d3dee9";
      ctx.fillText(s.name, p.x, p.y);
      ctx.font = this.mono(8.5);
      ctx.fillStyle = COLORS.textDim;
      ctx.fillText(code, p.x, p.y + 11 * this.k);
    }
    ctx.font = `italic ${Math.round(10.5 * this.k)}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = COLORS.textDim;
    for (const l of this.g.labels) {
      const p = this.P(l.x, l.y);
      ctx.fillText(l.text, p.x, p.y);
    }
  }

  private drawPlatforms(ctx: CanvasRenderingContext2D) {
    const h = Math.max(2.5, 4 * this.zoom);
    for (const e of this.g.edges) {
      if (!e.platform) continue;
      const a = this.g.nodes[e.a], b = this.g.nodes[e.b];
      const p = this.P(a.x, a.y), q = this.P(b.x - 1e-6, b.y);
      const x1 = p.x + 3, x2 = q.x - 3;
      ctx.fillStyle = COLORS.platform;
      ctx.fillRect(x1, p.y - h - 3.5, x2 - x1, h);
      if (this.zoom > 0.75) {
        ctx.fillStyle = "#6f8eaa";
        ctx.font = this.mono(8, 600);
        ctx.textAlign = "center";
        ctx.fillText(e.platform.track, (x1 + x2) / 2, p.y - h - 6);
      }
    }
  }

  private edgeStyle(eid: number): { color: string; dash?: number[] } {
    const e = this.g.edges[eid];
    if (e.occ) return { color: COLORS.occupied };
    if (e.lock) {
      const r = this.w.il.routes.get(e.lock);
      if (r && r.readyAt > this.w.time && Math.floor(this.blink * 3) % 2) return { color: COLORS.yellow };
      return { color: COLORS.route };
    }
    if (e.overlap) return { color: COLORS.overlap, dash: [4, 3] };
    return { color: COLORS.track };
  }

  private drawTracks(ctx: CanvasRenderingContext2D) {
    ctx.lineCap = "round";
    const lw = Math.max(1.8, 3 * Math.min(this.zoom, 1.6));
    const cutMarks: { x: number; y: number; d: 1 | -1 }[] = [];
    for (const e of this.g.edges) {
      const a = this.g.nodes[e.a], b = this.g.nodes[e.b];
      let ax = a.x, ay = a.y, bx = b.x, by = b.y;
      // Weichenzunge: nicht anliegender Strang mit Lücke
      const gapU = 0.28;
      const shorten = (n: typeof a, atStart: boolean) => {
        if (n.swSide === undefined) return;
        const side = n.swSide > 0 ? n.east : n.west;
        const idx = side.indexOf(e.id);
        if (idx < 0 || idx === n.swPos) return;
        const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
        if (atStart) { ax += (dx / len) * gapU; ay += (dy / len) * gapU; } else { bx -= (dx / len) * gapU; by -= (dy / len) * gapU; }
      };
      shorten(a, true);
      shorten(b, false);
      const st = this.edgeStyle(e.id);
      ctx.strokeStyle = st.color;
      ctx.lineWidth = lw;
      ctx.setLineDash(st.dash ?? []);
      ctx.beginPath();
      this.seg(ctx, ax, ay, bx, by, (p, d) => cutMarks.push({ ...p, d }));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Langsamfahrstellen (gelb gestrichelt mit Geschwindigkeit) und gesperrte Gleise (Kreuze)
    for (const e of this.g.edges) {
      if (!e.slow && !e.closed) continue;
      const A = this.g.nodes[e.a], B = this.g.nodes[e.b];
      const a = this.P(A.x + 1e-6, A.y), b = this.P(B.x - 1e-6, B.y);
      if (Math.abs(a.y - b.y) > 80) continue;
      if (e.slow) {
        ctx.strokeStyle = COLORS.yellow;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y - 5 * this.k);
        ctx.lineTo(b.x, b.y - 5 * this.k);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = this.mono(8, 700);
        ctx.fillStyle = COLORS.yellow;
        ctx.textAlign = "center";
        if (Math.hypot(b.x - a.x, b.y - a.y) > 60 * this.k) ctx.fillText(`${e.work ? "Bau " : ""}La ${e.slow}`, (a.x + b.x) / 2, (a.y + b.y) / 2 - 8 * this.k);
      }
      if (e.closed) {
        ctx.strokeStyle = COLORS.fault;
        ctx.lineWidth = 2;
        const n = Math.max(1, Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / 30));
        for (let i = 0; i < n; i++) {
          const f = (i + 0.5) / n, x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f, r = 4 * this.k;
          ctx.beginPath();
          ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
          ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
          ctx.stroke();
        }
      }
    }
    // Fortsetzungspfeile an Zeilenumbrüchen
    ctx.fillStyle = "#8597ab";
    for (const m of cutMarks) {
      const s = 4 * this.k;
      ctx.beginPath();
      const x = m.x + (m.d > 0 ? 4 : -4) * this.k;
      ctx.moveTo(x + (m.d > 0 ? s : -s), m.y);
      ctx.lineTo(x, m.y - s * 0.8);
      ctx.lineTo(x, m.y + s * 0.8);
      ctx.fill();
    }
  }

  private drawSwitches(ctx: CanvasRenderingContext2D) {
    for (const n of this.g.nodes) {
      if (n.swSide === undefined) continue;
      const p = this.P(n.x, n.y);
      const fault = this.w.switchFault(n.id);
      const locked = this.w.il.switchLocked(n.id);
      if (fault) {
        const r = (5 + Math.sin(this.blink * 6) * 1.5) * this.k;
        ctx.strokeStyle = COLORS.fault;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = fault ? COLORS.fault : locked ? "#2a7a52" : "#8b98a8";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.3 * this.k, 0, Math.PI * 2);
      ctx.fill();
      if (this.w.il.blockedSwitches.has(n.id)) {
        ctx.strokeStyle = COLORS.fault;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(p.x - 4 * this.k, p.y - 4 * this.k, 8 * this.k, 8 * this.k);
      }
      if (this.zoom > 1.3) {
        ctx.font = this.mono(7.5);
        ctx.fillStyle = COLORS.textDim;
        ctx.textAlign = "center";
        ctx.fillText((n.swName ?? "").replace(/^[A-Z]{2} /, ""), p.x, p.y + (n.swSide > 0 ? -6 : 12) * this.k);
      }
    }
  }

  // Signalsymbol: Fuß am Gleis, Mast, Signalschirm als Pfeil in Fahrtrichtung
  private drawSignals(ctx: CanvasRenderingContext2D) {
    const k = this.k;
    for (const s of this.g.signals) {
      const n = this.g.nodes[s.node];
      const track = this.P(n.x - s.dir * 0.001, n.y);
      const p = this.sigPos(s);
      const asp = this.w.il.aspect(s, this.w.time);
      const fault = this.w.signalFault(s.id);
      const block = s.kind === "block";
      const L = (block ? 7 : 9) * k, Hh = (block ? 4.2 : 5.6) * k;
      // Fuß und Mast
      ctx.strokeStyle = "#71808f";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      const footX = p.x - s.dir * (L * 0.5 + 3 * k);
      ctx.moveTo(footX, track.y + s.dir * 3 * k);
      ctx.lineTo(footX, p.y);
      ctx.lineTo(p.x - s.dir * L * 0.5, p.y);
      ctx.moveTo(footX, p.y - 3 * k);
      ctx.lineTo(footX, p.y + 3 * k);
      ctx.stroke();
      // Schirm (Ks-System): Hp0 rot, Ks1 grün, Ks2 gelb nur am Mehrabschnittssignal, Ks1 blinkend bei Zs3v
      let col = asp.stop ? COLORS.red : asp.expectStop && s.combined ? COLORS.yellow : COLORS.green;
      if (!asp.stop && !asp.expectStop && asp.zs3v && s.combined && Math.floor(this.blink * 2) % 2) col = "#145c36";
      if (asp.zs1) col = Math.floor(this.blink * 2.5) % 2 ? COLORS.white : COLORS.red;
      const tip = p.x + s.dir * L * 0.5, back = p.x - s.dir * L * 0.5;
      ctx.beginPath();
      ctx.moveTo(tip, p.y);
      ctx.lineTo(back, p.y - Hh);
      ctx.lineTo(back, p.y + Hh);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = asp.stop && !asp.zs1 ? 0 : 7;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#0c1015";
      ctx.lineWidth = 1;
      ctx.stroke();
      if (fault) {
        ctx.strokeStyle = COLORS.fault;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, L * 0.9 + Math.sin(this.blink * 6) * 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (s.auto && !block) {
        ctx.fillStyle = COLORS.target;
        ctx.beginPath();
        ctx.arc(back - s.dir * 2.5 * k, p.y - s.dir * (Hh + 2.5 * k), 1.8 * k, 0, Math.PI * 2);
        ctx.fill();
      }
      const ring = (color: string, dashed = false) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash(dashed ? [2, 2] : []);
        ctx.beginPath();
        ctx.arc(p.x, p.y, L * 0.85 + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      };
      if (this.w.il.blockedSignals.has(s.id)) {
        ctx.strokeStyle = COLORS.fault;
        ctx.lineWidth = 1.6;
        ctx.strokeRect(p.x - L * 0.75, p.y - Hh - 2, L * 1.5, Hh * 2 + 4);
      }
      if (this.selected === s.id) ring(COLORS.white);
      const tgt = this.targets.get(`s${s.id}`);
      if (tgt !== undefined) ring(tgt ? COLORS.target : "#7a4b55", !tgt);
      if (this.zoom > 0.8 && !block) {
        ctx.font = this.mono(8);
        ctx.fillStyle = COLORS.text;
        ctx.textAlign = "center";
        ctx.fillText(s.name.replace(/^[A-Z]{2} /, ""), p.x, p.y + s.dir * (Hh + 8 * k) + (s.dir > 0 ? 2 : 0));
      }
      if (asp.zs3 && !asp.stop) {
        ctx.font = this.mono(8, 700);
        ctx.fillStyle = COLORS.white;
        ctx.textAlign = "center";
        ctx.fillText(String(asp.zs3), back - s.dir * 6 * k, p.y + 3 * k);
      }
    }
  }

  // Vorsignale: kleine Raute ohne Mast, gelb = Halt erwarten, grün = Fahrt erwarten, grün blinkend = Geschwindigkeit erwarten
  private drawDistants(ctx: CanvasRenderingContext2D) {
    if (this.zoom < 0.55) return;
    const k = this.k;
    for (const d of this.g.distants ?? []) {
      const e = this.g.edges[d.edge];
      const a = this.g.nodes[e.a], b = this.g.nodes[e.b];
      const f = d.pos / e.len;
      const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
      const P = this.P(x, y);
      const px = P.x, py = P.y + d.dir * 8 * k;
      const asp = this.w.il.distantAspect(d.main, this.w.time);
      let col = asp.expectStop ? COLORS.yellow : COLORS.green;
      if (!asp.expectStop && asp.zs3v && Math.floor(this.blink * 2) % 2) col = "#145c36";
      const r = 3.4 * k;
      ctx.strokeStyle = "#71808f";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, P.y + d.dir * 2 * k);
      ctx.lineTo(px, py - d.dir * r);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px + d.dir * r, py);
      ctx.lineTo(px, py - r);
      ctx.lineTo(px - d.dir * r, py);
      ctx.lineTo(px, py + r);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = "#0c1015";
      ctx.stroke();
    }
  }

  private drawPortals(ctx: CanvasRenderingContext2D) {
    ctx.font = this.sans(10, 600);
    for (const [code, p] of Object.entries(this.g.portals)) {
      const a = this.g.nodes[p.inNode], b = this.g.nodes[p.outNode];
      const pa = this.P(a.x, a.y), pb = this.P(b.x, b.y);
      const left = p.dir > 0;
      ctx.textAlign = left ? "right" : "left";
      ctx.fillStyle = "#8597ab";
      ctx.fillText(left ? `${p.label} ◂` : `▸ ${p.label}`, pa.x + (left ? -7 : 7), (pa.y + pb.y) / 2 + 4);
      const tgt = this.targets.get(`p${code}`);
      if (tgt !== undefined) {
        ctx.strokeStyle = tgt ? COLORS.target : "#7a4b55";
        ctx.lineWidth = 2;
        ctx.strokeRect(pb.x - 6, pb.y - 6, 12, 12);
      }
    }
  }

  // Lage eines Punktes in Weltkoordinaten, dist Meter hinter der Zugspitze
  private trainPolyline(t: Train): [number, number][] {
    const pts: [number, number][] = [];
    let rem = t.len;
    for (let i = t.body.length - 1; i >= 0 && rem > 0; i--) {
      const e = this.g.edges[t.body[i]];
      const a = this.g.nodes[e.a], b = this.g.nodes[e.b];
      const [s, q] = t.dir > 0 ? [a, b] : [b, a]; // Fahrtrichtung s -> q
      const headHere = i === t.body.length - 1 ? Math.min(t.headPos, e.len) : e.len;
      const from = Math.max(0, headHere - rem);
      const at = (m: number): [number, number] => [s.x + (q.x - s.x) * (m / e.len), s.y + (q.y - s.y) * (m / e.len)];
      pts.push(at(headHere));
      pts.push(at(from));
      rem -= headHere - from;
    }
    return pts;
  }

  // Punkt im Abstand d (Meter) hinter der Zugspitze
  private trainPointAt(t: Train, d: number): [number, number] | null {
    let rem = d;
    for (let i = t.body.length - 1; i >= 0; i--) {
      const e = this.g.edges[t.body[i]];
      const a = this.g.nodes[e.a], b = this.g.nodes[e.b];
      const [s, q] = t.dir > 0 ? [a, b] : [b, a];
      const headHere = i === t.body.length - 1 ? Math.min(t.headPos, e.len) : e.len;
      if (rem <= headHere) {
        const m = headHere - rem;
        return [s.x + (q.x - s.x) * (m / e.len), s.y + (q.y - s.y) * (m / e.len)];
      }
      rem -= headHere;
    }
    return null;
  }

  // Fahrzeuggrenzen: Triebzüge in Einheiten, Güterzug Lok + Wagenzug
  private unitGaps(t: Train): number[] {
    const unit = t.cat === "S" ? 68 : t.cat === "RE" ? 75 : t.cat === "RB" ? 42 : t.cat === "ICE" ? 200 : 0;
    if (t.cat === "G") return [19];
    const out: number[] = [];
    for (let d = unit; unit && d < t.len - 5; d += unit) out.push(d);
    return out;
  }

  private drawTrainBodies(ctx: CanvasRenderingContext2D) {
    const lw = Math.max(4, 6.5 * Math.min(this.zoom, 1.5));
    ctx.lineCap = "round";
    for (const t of this.w.trains) {
      if (!t.body.length) continue;
      const pts = this.trainPolyline(t);
      ctx.strokeStyle = CAT_COLOR[t.cat];
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let i = 0; i + 1 < pts.length; i++) this.seg(ctx, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // Kupplungsstellen zwischen den Einheiten
      ctx.fillStyle = COLORS.bg ?? "#0b0f14";
      for (const d of this.unitGaps(t)) {
        const p = this.trainPointAt(t, d);
        if (!p) continue;
        const P = this.P(p[0], p[1]);
        ctx.fillRect(P.x - 1, P.y - lw / 2 - 0.5, 2, lw + 1);
      }
      // Spitze als Pfeil
      const h = this.P(pts[0][0] - t.dir * 1e-6, pts[0][1]);
      const s = lw * 0.9;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.moveTo(h.x + t.dir * s * 0.9, h.y);
      ctx.lineTo(h.x - t.dir * s * 0.4, h.y - s * 0.75);
      ctx.lineTo(h.x - t.dir * s * 0.4, h.y + s * 0.75);
      ctx.fill();
      if (t.fault) {
        ctx.strokeStyle = COLORS.fault;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(h.x, h.y, 9 * this.k + Math.sin(this.blink * 6) * 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  private drawTrainLabels(ctx: CanvasRenderingContext2D) {
    this.trainBoxes = [];
    const k = this.k;
    for (const t of this.w.trains) {
      if (!t.body.length) continue;
      const pts = this.trainPolyline(t);
      const h = this.P(pts[0][0] - t.dir * 1e-6, pts[0][1]);
      const label = t.no.split(" ").pop()!;
      ctx.font = this.mono(9.5, 650);
      const tw = ctx.measureText(label).width;
      const bw = tw + 14 * k, bh = 14 * k;
      const bx = h.x - (t.dir > 0 ? bw : 0) - t.dir * 2;
      const by = t.dir > 0 ? h.y + 16 * k : h.y - 16 * k - bh;
      const waiting = t.waitRed > 45;
      ctx.fillStyle = "#0a0d12f0";
      ctx.strokeStyle = waiting && Math.floor(this.blink * 2) % 2 ? COLORS.yellow : this.focusTrain === t ? "#ffffff" : CAT_COLOR[t.cat];
      ctx.lineWidth = this.focusTrain === t ? 2 : 1.2;
      roundRect(ctx, bx, by, bw, bh, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#eef3f8";
      ctx.textAlign = "left";
      ctx.fillText(label, bx + 7 * k, by + bh - 3.8 * k);
      const dm = Math.round(t.delay / 60);
      if (dm >= 3) {
        ctx.fillStyle = dm >= 6 ? "#ff7a59" : COLORS.yellow;
        ctx.font = this.mono(8.5, 700);
        ctx.textAlign = t.dir > 0 ? "right" : "left";
        ctx.fillText(`+${dm}`, t.dir > 0 ? bx - 3 : bx + bw + 3, by + bh - 3.8 * k);
      }
      this.trainBoxes.push({ t, x: bx, y: by, w: bw, h: bh });
    }
  }

  private drawBreakEditor(ctx: CanvasRenderingContext2D) {
    for (const x of this.candidates) {
      const on = this.breaks.includes(x);
      const p = this.Pb(x, 5, this.bandOf(x - 1e-6));
      ctx.fillStyle = on ? "#36c5f0" : "#36c5f055";
      ctx.beginPath();
      ctx.arc(p.x, p.y - 30 * this.k, 7 * this.k, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0c1015";
      ctx.font = this.sans(9, 700);
      ctx.textAlign = "center";
      ctx.fillText(on ? "↵" : "✂", p.x, p.y - 27 * this.k);
    }
  }

  // ---------------- Treffertest ----------------
  hit(px: number, py: number): Hit | null {
    if (this.editBreaks) {
      for (const x of this.candidates) {
        const p = this.Pb(x, 5, this.bandOf(x - 1e-6));
        if (Math.hypot(p.x - px, p.y - 30 * this.k - py) < 10) return { kind: "break", x };
      }
    }
    for (const b of this.trainBoxes) if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return { kind: "train", train: b.t };
    let best: Hit | null = null, bd = 12;
    for (const s of this.g.signals) {
      const p = this.sigPos(s);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d < bd) { bd = d; best = { kind: "signal", sig: s }; }
    }
    if (best) return best;
    for (const [code, p] of Object.entries(this.g.portals)) {
      const n = this.g.nodes[p.outNode];
      const q = this.P(n.x, n.y);
      if (Math.hypot(q.x - px, q.y - py) < 12) return { kind: "portal", code };
    }
    bd = 9;
    for (const n of this.g.nodes) {
      if (n.swSide === undefined) continue;
      const q = this.P(n.x, n.y);
      const d = Math.hypot(q.x - px, q.y - py);
      if (d < bd) { bd = d; best = { kind: "switch", node: n.id }; }
    }
    if (best) return best;
    // Klick auf einen Zugkörper
    for (const t of this.w.trains) {
      if (!t.body.length) continue;
      const pts = this.trainPolyline(t);
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = this.P(pts[i][0] - t.dir * 1e-6, pts[i][1]), b = this.P(pts[i + 1][0] + t.dir * 1e-6, pts[i + 1][1]);
        if (distSeg(px, py, a.x, a.y, b.x, b.y) < 6) return { kind: "train", train: t };
      }
    }
    // Gleisabschnitt
    let be = -1;
    bd = 7;
    for (const e of this.g.edges) {
      const A = this.g.nodes[e.a], B = this.g.nodes[e.b];
      const a = this.P(A.x + 1e-6, A.y), b = this.P(B.x - 1e-6, B.y);
      if (Math.abs(a.y - b.y) > 80 || b.x < a.x) continue;
      const d = distSeg(px, py, a.x, a.y, b.x, b.y);
      if (d < bd) { bd = d; be = e.id; }
    }
    if (be >= 0) return { kind: "edge", edge: be };
    return null;
  }
}

function distSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
