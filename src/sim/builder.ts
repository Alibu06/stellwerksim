import { Dir, GEdge, GNode, Graph, Signal, SignalKind } from "./graph";

// Hilfsbaukasten, um das schematische Gleisbild in Rasterkoordinaten zu beschreiben.
// Länge einer Kante = explizit angegeben oder Rasterabstand * M_PER_UNIT.
const M_PER_UNIT = 40;

export type Pt = [number, number] | [number, number, number];

export interface TrackOpts {
  v?: number;
  pref?: Dir;
}

export class Builder {
  g: Graph = { nodes: [], edges: [], signals: [], stations: {}, portals: {}, labels: [], breakpoints: [] };
  private byKey = new Map<string, number>();

  node(x: number, y: number): number {
    const k = `${x},${y}`;
    let id = this.byKey.get(k);
    if (id === undefined) {
      id = this.g.nodes.length;
      const n: GNode = { id, x, y, east: [], west: [], swPos: 0 };
      this.g.nodes.push(n);
      this.byKey.set(k, id);
    }
    return id;
  }

  find(x: number, y: number): number {
    const id = this.byKey.get(`${x},${y}`);
    if (id === undefined) throw new Error(`Kein Knoten bei ${x},${y}`);
    return id;
  }

  edgeBetween(x1: number, y1: number, x2: number, y2: number): GEdge {
    const a = this.find(x1, y1), b = this.find(x2, y2);
    const e = this.g.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
    if (!e) throw new Error(`Keine Kante ${x1},${y1} - ${x2},${y2}`);
    return e;
  }

  track(pts: Pt[], o: TrackOpts = {}) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i], q = pts[i + 1];
      if (p[0] === q[0]) throw new Error(`Senkrechte Kante bei ${p}`);
      const [w, e] = p[0] < q[0] ? [p, q] : [q, p];
      const a = this.node(w[0], w[1]), b = this.node(e[0], e[1]);
      if (this.g.edges.some((x) => x.a === a && x.b === b)) continue;
      const len = q[2] ?? Math.round(Math.hypot(e[0] - w[0], e[1] - w[1]) * M_PER_UNIT);
      const diag = w[1] !== e[1];
      const edge: GEdge = {
        id: this.g.edges.length, a, b, len,
        vmax: diag && q[2] === undefined ? Math.min(o.v ?? 60, 60) : o.v ?? 120,
        pref: diag ? undefined : o.pref,
        occ: 0, lock: 0, overlap: 0,
      };
      this.g.edges.push(edge);
      this.g.nodes[a].east.push(edge.id);
      this.g.nodes[b].west.push(edge.id);
    }
  }

  // Zweigleisige Strecke von x1 bis x2: Gleis yW (Regelgleis Richtung West) und yE (Richtung Ost)
  double(xs: number[], yW: number, yE: number, lens: (number | undefined)[] = [], v = 120) {
    const mk = (y: number) => xs.map((x, i) => (i > 0 && lens[i - 1] !== undefined ? [x, y, lens[i - 1]] : [x, y]) as Pt);
    this.track(mk(yW), { v, pref: -1 });
    this.track(mk(yE), { v, pref: 1 });
  }

  // Gleiswechsel (Diagonale) zwischen zwei Punkten
  xover(x1: number, y1: number, x2: number, y2: number, v = 60, len?: number) {
    this.track([[x1, y1], len ? [x2, y2, len] : [x2, y2]], { v });
  }

  sig(x: number, y: number, dir: Dir, name: string, kind: SignalKind = "main", auto = false) {
    const node = this.find(x, y);
    const s: Signal = { id: this.g.signals.length + 1, node, dir, name, kind, auto: auto || kind === "block", route: 0 };
    this.g.signals.push(s);
    if (dir > 0) this.g.nodes[node].sigE = s.id;
    else this.g.nodes[node].sigW = s.id;
  }

  // Blocksignale auf zweigleisiger Strecke in beiden Richtungen
  blocks(xs: number[], yW: number, yE: number, prefix: string) {
    xs.forEach((x, i) => {
      this.sig(x, yE, 1, `${prefix}${i + 1}`, "block");
      this.sig(x, yW, -1, `${prefix}${xs.length * 2 - i}`, "block");
    });
  }

  plat(x1: number, x2: number, y: number, st: string, track: string, len?: number) {
    const e = this.edgeBetween(x1, y, x2, y);
    e.platform = { st, track };
    if (len) e.len = len;
  }

  station(code: string, name: string, x: number, y: number) {
    this.g.stations[code] = { name, x, y };
  }

  // Streckenende: yIn = Gleis, auf dem Züge hereinkommen, yOut = Gleis, auf dem sie hinausfahren
  portal(code: string, x: number, yIn: number, yOut: number, dir: Dir, label: string) {
    const i = this.find(x, yIn), o = this.find(x, yOut);
    this.g.nodes[i].portal = code;
    this.g.nodes[o].portal = code;
    this.g.portals[code] = { inNode: i, outNode: o, dir, label };
  }

  label(x: number, y: number, text: string, size?: number) {
    this.g.labels.push({ x, y, text, size });
  }

  // Streckenlängen zwischen zwei Betriebsstellen an reale Entfernungen anpassen.
  // Bahnhofsgleise und Weichenverbindungen bleiben, die Streckengleise dazwischen werden skaliert.
  calibrate(from: string, to: string, meters: number, rows: number[][]) {
    const x0 = this.g.stations[from].x, x1 = this.g.stations[to].x;
    for (const ys of rows) {
      const es = this.g.edges.filter((e) => {
        const a = this.g.nodes[e.a], b = this.g.nodes[e.b];
        return ys.includes(a.y) && ys.includes(b.y) && a.x >= Math.floor(x0) && b.x <= Math.ceil(x1);
      });
      // Anteil der Kanten, die nur teilweise im Abschnitt liegen (Bahnsteige an den Enden)
      let fixed = 0, variable = 0;
      for (const e of es) {
        const a = this.g.nodes[e.a], b = this.g.nodes[e.b];
        const frac = (Math.min(b.x, x1) - Math.max(a.x, x0)) / (b.x - a.x);
        if (frac <= 0) continue;
        if (e.platform || e.len < 350) fixed += e.len * frac;
        else variable += e.len * frac;
      }
      if (variable <= 0) continue;
      const k = Math.max(0.2, (meters - fixed) / variable);
      for (const e of es) if (!e.platform && e.len >= 350) e.len = Math.round(e.len * k);
    }
  }

  finish(): Graph {
    for (const n of this.g.nodes) {
      for (const side of [1, -1] as Dir[]) {
        const arr = side > 0 ? n.east : n.west;
        if (arr.length > 2) throw new Error(`Knoten ${n.x},${n.y}: mehr als 2 Kanten auf einer Seite`);
        if (arr.length === 2) {
          if (n.swSide !== undefined) throw new Error(`Kreuzung bei ${n.x},${n.y} nicht unterstützt`);
          n.swSide = side;
          // Index 0 = gerader Strang
          arr.sort((p, q) => this.dy(n, p) - this.dy(n, q));
        }
      }
      if (n.east.length + n.west.length === 1 && !n.portal) n.buffer = true;
    }
    let k = 1;
    const sw = this.g.nodes.filter((n) => n.swSide !== undefined).sort((a, b) => a.x - b.x || a.y - b.y);
    for (const n of sw) n.swName = `W${k++}`;
    return this.g;
  }

  private dy(n: GNode, eid: number) {
    const e = this.g.edges[eid];
    const o = this.g.nodes[e.a === n.id ? e.b : e.a];
    return Math.abs(o.y - n.y);
  }
}
