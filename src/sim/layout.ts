import { Dir, GEdge, GNode, Graph, Signal, SignalKind } from "./graph";

// Baukasten für das Gleisbild in echten Streckenkilometern.
// Alles wird in Metern entlang der Strecke (s) und einer Spur (y) beschrieben.
// Kantenlängen ergeben sich aus den echten Abständen, die x-Position für die Darstellung
// wird daraus berechnet (Bahnhöfe gedehnt, freie Strecke gestaucht).

interface Lane { y: number; s1: number; s2: number; v: number; pref?: Dir; }
interface Conn { s1: number; y1: number; s2: number; y2: number; v: number; len?: number; }
interface Zone { s1: number; s2: number; }

export interface LaneOpts { v?: number; pref?: Dir; }

const M_ZONE = 75; // Meter pro Rastereinheit in Bahnhöfen
const M_LINE = 380; // Meter pro Rastereinheit auf freier Strecke

export class Layout {
  private lanes: Lane[] = [];
  private conns: Conn[] = [];
  private zones: Zone[] = [];
  private speeds: { y: number; s1: number; s2: number; v: number }[] = [];
  private sigs: { s: number; y: number; dir: Dir; name: string; kind: SignalKind }[] = [];
  private plats: { s1: number; s2: number; y: number; st: string; track: string }[] = [];
  private portals: { code: string; s: number; yIn: number; yOut: number; dir: Dir; label: string }[] = [];
  private stations: { code: string; name: string; s: number; y: number }[] = [];
  private labels: { s: number; y: number; text: string }[] = [];
  private names = new Map<string, string>(); // Weichennamen "s,y" -> Name
  private xOf!: (s: number) => number;

  // Bahnhofsbereich, der in der Darstellung breiter gezeichnet wird
  zone(s1: number, s2: number) { this.zones.push({ s1, s2 }); }

  lane(y: number, s1: number, s2: number, o: LaneOpts = {}) {
    this.lanes.push({ y, s1: Math.min(s1, s2), s2: Math.max(s1, s2), v: o.v ?? 120, pref: o.pref });
  }

  // Zweigleisige Strecke: yW = Regelgleis Richtung West, yE = Richtung Ost
  double(yW: number, yE: number, s1: number, s2: number, v = 120) {
    this.lane(yW, s1, s2, { v, pref: -1 });
    this.lane(yE, s1, s2, { v, pref: 1 });
  }

  speed(y: number, s1: number, s2: number, v: number) { this.speeds.push({ y, s1, s2, v }); }

  // Weichenverbindung zwischen zwei Spuren
  conn(s1: number, y1: number, s2: number, y2: number, v = 60, len?: number) {
    if (s1 > s2) [s1, y1, s2, y2] = [s2, y2, s1, y1];
    this.conns.push({ s1, y1, s2, y2, v, len });
  }

  // Gleiswechsel: von (s, yA) nach (s + l, yB)
  xo(s: number, yA: number, yB: number, l = 80, v = 60) { this.conn(s, yA, s + l, yB, v); }

  sig(s: number, y: number, dir: Dir, name: string, kind: SignalKind = "main") {
    this.sigs.push({ s, y, dir, name, kind });
  }

  // Selbstblocksignale in beiden Richtungen
  blk(s: number, yW: number, yE: number, name: string) {
    this.sig(s, yE, 1, `${name}`, "block");
    this.sig(s, yW, -1, `${name}W`, "block");
  }

  plat(s1: number, s2: number, y: number, st: string, track: string) {
    this.plats.push({ s1, s2, y, st, track });
  }

  station(code: string, name: string, s: number, y: number) { this.stations.push({ code, name, s, y }); }
  portal(code: string, s: number, yIn: number, yOut: number, dir: Dir, label: string) {
    this.portals.push({ code, s, yIn, yOut, dir, label });
  }
  label(s: number, y: number, text: string) { this.labels.push({ s, y, text }); }
  swName(s: number, y: number, name: string) { this.names.set(`${s},${y}`, name); }

  private buildX() {
    const z = [...this.zones].sort((a, b) => a.s1 - b.s1);
    const all = [
      ...this.lanes.flatMap((l) => [l.s1, l.s2]),
      ...this.conns.flatMap((c) => [c.s1, c.s2]),
    ];
    const smin = Math.min(...all), smax = Math.max(...all);
    // Stützstellen (s, x)
    const knots: [number, number][] = [[smin, 0]];
    let x = 0, s = smin;
    for (const zz of z) {
      if (zz.s1 > s) { x += (zz.s1 - s) / M_LINE; s = zz.s1; knots.push([s, x]); }
      const e = Math.max(s, zz.s2);
      x += (e - s) / M_ZONE; s = e; knots.push([s, x]);
    }
    if (smax > s) { x += (smax - s) / M_LINE; knots.push([smax, x]); }
    this.xOf = (q: number) => {
      if (q <= knots[0][0]) return (q - knots[0][0]) / M_LINE;
      for (let i = 1; i < knots.length; i++) {
        const [s0, x0] = knots[i - 1], [s1, x1] = knots[i];
        if (q <= s1) return x0 + ((q - s0) / Math.max(1e-9, s1 - s0)) * (x1 - x0);
      }
      const [sl, xl] = knots[knots.length - 1];
      return xl + (q - sl) / M_LINE;
    };
    // mögliche Zeilenumbrüche: Mitte jeder Lücke zwischen zwei Bahnhofsbereichen
    const bps: number[] = [];
    for (let i = 0; i + 1 < z.length; i++) {
      if (z[i + 1].s1 - z[i].s2 > 600) bps.push(this.xOf((z[i].s2 + z[i + 1].s1) / 2));
    }
    return bps;
  }

  build(): Graph {
    const breakpoints = this.buildX();
    const g: Graph = { nodes: [], edges: [], signals: [], stations: {}, portals: {}, labels: [], breakpoints };
    const byKey = new Map<string, number>();
    const key = (s: number, y: number) => `${Math.round(s)},${y}`;
    const node = (s: number, y: number): number => {
      const k = key(s, y);
      let id = byKey.get(k);
      if (id === undefined) {
        id = g.nodes.length;
        const n: GNode = { id, x: this.xOf(s), y, east: [], west: [], swPos: 0, s: Math.round(s) };
        g.nodes.push(n);
        byKey.set(k, id);
      }
      return id;
    };
    const find = (s: number, y: number, what: string) => {
      const id = byKey.get(key(s, y));
      if (id === undefined) throw new Error(`${what}: kein Knoten bei s=${s}, y=${y}`);
      return id;
    };
    const addEdge = (a: number, b: number, len: number, vmax: number, pref?: Dir) => {
      if (g.nodes[a].x > g.nodes[b].x) [a, b] = [b, a];
      if (g.nodes[a].x === g.nodes[b].x) throw new Error(`Senkrechte Kante bei s=${g.nodes[a].s}`);
      const e: GEdge = { id: g.edges.length, a, b, len: Math.max(10, Math.round(len)), vmax, pref, occ: 0, lock: 0, overlap: 0 };
      g.edges.push(e);
      g.nodes[a].east.push(e.id);
      g.nodes[b].west.push(e.id);
      return e;
    };

    // Punkte, an denen Spuren geteilt werden müssen
    const cuts = new Map<number, Set<number>>();
    const cut = (y: number, s: number) => {
      if (!cuts.has(y)) cuts.set(y, new Set());
      cuts.get(y)!.add(Math.round(s));
    };
    for (const c of this.conns) { cut(c.y1, c.s1); cut(c.y2, c.s2); }
    for (const s of this.sigs) cut(s.y, s.s);
    for (const p of this.plats) { cut(p.y, p.s1); cut(p.y, p.s2); }
    for (const p of this.portals) { cut(p.yIn, p.s); cut(p.yOut, p.s); }
    for (const sp of this.speeds) { cut(sp.y, sp.s1); cut(sp.y, sp.s2); }

    for (const l of this.lanes) {
      const pts = [l.s1, ...[...(cuts.get(l.y) ?? [])].filter((s) => s > l.s1 && s < l.s2), l.s2].sort((a, b) => a - b);
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = node(pts[i], l.y), b = node(pts[i + 1], l.y);
        const mid = (pts[i] + pts[i + 1]) / 2;
        const sp = this.speeds.filter((q) => q.y === l.y && mid > q.s1 && mid < q.s2).pop();
        addEdge(a, b, pts[i + 1] - pts[i], sp ? sp.v : l.v, l.pref);
      }
    }
    for (const c of this.conns) {
      const a = node(c.s1, c.y1), b = node(c.s2, c.y2);
      const len = c.len ?? Math.max(30, Math.hypot(c.s2 - c.s1, (c.y2 - c.y1) * 4.5));
      addEdge(a, b, len, c.v);
    }

    // Weichen
    for (const n of g.nodes) {
      for (const side of [1, -1] as Dir[]) {
        const arr = side > 0 ? n.east : n.west;
        if (arr.length > 2) throw new Error(`Knoten s=${n.s},y=${n.y}: mehr als 2 Kanten auf einer Seite`);
        if (arr.length === 2) {
          if (n.swSide !== undefined) throw new Error(`Kreuzung bei s=${n.s},y=${n.y} nicht unterstützt`);
          n.swSide = side;
          arr.sort((p, q) => dy(n, p) - dy(n, q));
        }
      }
    }
    function dy(n: GNode, eid: number) {
      const e = g.edges[eid];
      return Math.abs(g.nodes[e.a === n.id ? e.b : e.a].y - n.y);
    }

    for (const s of this.sigs) {
      const nid = find(s.s, s.y, `Signal ${s.name}`);
      const sg: Signal = { id: g.signals.length + 1, node: nid, dir: s.dir, name: s.name, kind: s.kind, auto: s.kind === "block", route: 0 };
      g.signals.push(sg);
      if (s.dir > 0) {
        if (g.nodes[nid].sigE) throw new Error(`Zwei Signale Ost bei ${s.name}`);
        g.nodes[nid].sigE = sg.id;
      } else {
        if (g.nodes[nid].sigW) throw new Error(`Zwei Signale West bei ${s.name}`);
        g.nodes[nid].sigW = sg.id;
      }
    }
    for (const p of this.plats) {
      const a = find(p.s1, p.y, `Bahnsteig ${p.st} ${p.track}`), b = find(p.s2, p.y, `Bahnsteig ${p.st} ${p.track}`);
      const e = g.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
      if (!e) throw new Error(`Bahnsteig ${p.st} Gl. ${p.track}: Gleis ist zwischen s=${p.s1} und ${p.s2} unterbrochen`);
      e.platform = { st: p.st, track: p.track };
    }
    for (const p of this.portals) {
      const i = find(p.s, p.yIn, `Streckenende ${p.code}`), o = find(p.s, p.yOut, `Streckenende ${p.code}`);
      g.nodes[i].portal = p.code;
      g.nodes[o].portal = p.code;
      g.portals[p.code] = { inNode: i, outNode: o, dir: p.dir, label: p.label };
    }
    for (const n of g.nodes) if (n.east.length + n.west.length === 1 && !n.portal) n.buffer = true;
    for (const st of this.stations) g.stations[st.code] = { name: st.name, x: this.xOf(st.s), y: st.y, s: st.s };
    for (const l of this.labels) g.labels.push({ x: this.xOf(l.s), y: l.y, text: l.text });

    // Weichennamen: echte Bezeichnung, wo bekannt, sonst fortlaufend je Betriebsstelle
    const codes = this.stations.map((s) => ({ code: s.code, s: s.s }));
    const near = (s: number) => codes.reduce((b, c) => (Math.abs(c.s - s) < Math.abs(b.s - s) ? c : b)).code;
    const cnt: Record<string, number> = {};
    const sw = g.nodes.filter((n) => n.swSide !== undefined).sort((a, b) => a.x - b.x || a.y - b.y);
    for (const n of sw) {
      const real = this.names.get(`${n.s},${n.y}`);
      const c = near(n.s!);
      cnt[c] = (cnt[c] ?? 0) + 1;
      n.swName = real ?? `${c} W${cnt[c]}`;
    }
    return g;
  }
}
