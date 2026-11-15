import { Dir, Graph, Signal, isDiverging, otherEnd } from "./graph";

// Fahrstraßenlogik eines elektronischen Stellwerks (vereinfacht):
// Start- und Zielsignal, Weichen umstellen und verschließen, Durchrutschweg, Teilauflösung hinter dem Zug.

export interface PathDef {
  sig: number; // Startsignal-ID
  dir: Dir;
  edges: number[];
  endNode: number;
  endSig: number; // 0 wenn Ziel ein Streckenende ist
  endPortal?: string;
  sw: { node: number; pos: number }[];
  len: number;
  diverging: boolean;
  vmax: number; // niedrigste zulässige Geschwindigkeit im Fahrweg (für Zs3)
}

export interface Route {
  id: number;
  path: PathDef;
  remaining: Set<number>;
  overlap: number[];
  readyAt: number; // Zeitpunkt, ab dem das Signal Fahrt zeigt (Weichenumlauf)
  used: boolean; // Zug hat Startsignal passiert
  train: number;
}

const SWITCH_TIME = 6; // Sekunden Weichenumlauf

export class Interlocking {
  routes = new Map<number, Route>();
  paths = new Map<number, PathDef[]>();
  faultySwitches = new Set<number>();
  faultySignals = new Set<number>();
  zs1 = new Map<number, number>(); // Ersatzsignal: Signal-ID -> gültig bis
  private nextId = 1;

  constructor(public g: Graph) {
    for (const s of g.signals) this.paths.set(s.id, this.enumerate(s));
  }

  sig(id: number): Signal {
    return this.g.signals[id - 1];
  }

  private enumerate(s: Signal): PathDef[] {
    const g = this.g, d = s.dir, out: PathDef[] = [];
    const walk = (n: number, edges: number[], len: number) => {
      if (edges.length > 60 || len > 30000) return;
      const node = g.nodes[n];
      if (edges.length > 0) {
        const sid = d > 0 ? node.sigE : node.sigW;
        if (sid) return out.push(this.mkPath(s, edges, n, sid));
        if (node.portal) {
          const p = g.portals[node.portal];
          if (p.outNode === n && p.dir === -d) out.push(this.mkPath(s, edges, n, 0, node.portal));
          return;
        }
      }
      const opts = d > 0 ? node.east : node.west;
      for (const e of opts) walk(otherEnd(g.edges[e], n), [...edges, e], len + g.edges[e].len);
    };
    walk(s.node, [], 0);
    return out;
  }

  private mkPath(s: Signal, edges: number[], endNode: number, endSig: number, endPortal?: string): PathDef {
    const g = this.g, sw: { node: number; pos: number }[] = [];
    let diverging = false, vmax = 999, len = 0;
    for (const e of edges) {
      const E = g.edges[e];
      len += E.len;
      vmax = Math.min(vmax, E.vmax);
      for (const n of [E.a, E.b]) {
        const node = g.nodes[n];
        if (node.swSide === undefined) continue;
        const side = node.swSide > 0 ? node.east : node.west;
        const idx = side.indexOf(e);
        if (idx >= 0 && !sw.some((x) => x.node === n)) {
          sw.push({ node: n, pos: idx });
          if (idx === 1) diverging = true;
        }
      }
    }
    return { sig: s.id, dir: s.dir, edges, endNode, endSig, endPortal, sw, len, diverging, vmax };
  }

  switchLocked(n: number): boolean {
    // Verschlossen, wenn ein Zweig der Weiche befahren, in einer Fahrstraße oder einem Durchrutschweg liegt
    const node = this.g.nodes[n];
    if (node.swSide === undefined) return false;
    for (const e of node.swSide > 0 ? node.east : node.west) {
      const E = this.g.edges[e];
      if (E.lock || E.overlap || E.occ) return true;
    }
    return false;
  }

  overlapFor(p: PathDef): number[] {
    if (!p.endSig) return [];
    const node = this.g.nodes[p.endNode];
    const opts = p.dir > 0 ? node.east : node.west;
    if (opts.length === 0) return [];
    const e = opts.length === 1 ? opts[0] : opts[node.swPos];
    return [e];
  }

  // Prüft, ob die Fahrstraße eingestellt werden kann. Liefert Grund bei Ablehnung.
  blockedSignals = new Set<number>();
  blockedSwitches = new Set<number>();

  check(p: PathDef): string | null {
    const g = this.g;
    if (this.sig(p.sig).route) return "Startsignal hat bereits eine Fahrstraße";
    if (this.blockedSignals.has(p.sig)) return "Signal ist gesperrt";
    for (const e of p.edges) {
      const E = g.edges[e];
      if (E.closed) return "Gleis im Fahrweg gesperrt";
      if (E.occ) return "Fahrweg besetzt";
      if (E.az) return E.az === 1 ? "Fahrweg besetzt gemeldet (Achszähler gestört, erst Grundstellung)" : "Abschnitt nach Grundstellung nicht frei gemeldet: Zug mit Befehl (Räumungsprüfung) durchfahren lassen";
      if (E.lock) return "Fahrweg durch andere Fahrstraße belegt";
      if (E.overlap) {
        const r = this.routes.get(E.overlap);
        if (!r || r.path.endSig !== p.sig) return "Durchrutschweg einer anderen Fahrstraße";
      }
    }
    for (const { node, pos } of p.sw) {
      if (g.nodes[node].swPos !== pos && this.faultySwitches.has(node)) return `Weiche ${g.nodes[node].swName} gestört`;
      if (g.nodes[node].swPos !== pos && this.switchLocked(node)) {
        const br = (g.nodes[node].swSide! > 0 ? g.nodes[node].east : g.nodes[node].west).map((e) => g.edges[e]);
        const onlyOv = br.every((E) => !E.lock && !E.occ);
        return `Weiche ${g.nodes[node].swName} verschlossen${onlyOv ? " (Durchrutschweg, wird etwa 25 s nach dem Halt des Zuges frei; die Fahrstraße wird vorgemerkt)" : ""}`;
      }
      if (g.nodes[node].swPos !== pos && this.blockedSwitches.has(node)) return `Weiche ${g.nodes[node].swName} ist gesperrt`;
    }
    for (const e of this.overlapFor(p)) {
      const E = g.edges[e];
      if (E.occ) return "Durchrutschweg besetzt";
      if (E.lock && this.routes.get(E.lock)?.path.sig !== p.endSig) return "Durchrutschweg verschlossen";
    }
    return null;
  }

  set(p: PathDef, now: number): Route | string {
    const why = this.check(p);
    if (why) return why;
    const g = this.g;
    let moved = false;
    for (const { node, pos } of p.sw) {
      if (g.nodes[node].swPos !== pos) {
        g.nodes[node].swPos = pos;
        moved = true;
      }
    }
    const r: Route = {
      id: this.nextId++, path: p, remaining: new Set(p.edges), overlap: [],
      readyAt: now + (moved ? SWITCH_TIME : 2), used: false, train: 0,
    };
    for (const e of p.edges) {
      g.edges[e].lock = r.id;
      if (g.edges[e].overlap) g.edges[e].overlap = 0; // eigener Durchrutschweg geht in die Fahrstraße über
    }
    for (const e of this.overlapFor(p)) {
      if (!g.edges[e].overlap && !g.edges[e].lock) {
        g.edges[e].overlap = r.id;
        r.overlap.push(e);
      }
    }
    this.routes.set(r.id, r);
    this.sig(p.sig).route = r.id;
    return r;
  }

  // Fahrstraßenrücknahme (nur solange der Zug das Startsignal nicht passiert hat)
  cancel(sigId: number): boolean {
    const s = this.sig(sigId);
    const r = this.routes.get(s.route);
    if (!r || r.used) return false;
    for (const e of r.path.edges) if (this.g.edges[e].lock === r.id) this.g.edges[e].lock = 0;
    this.releaseOverlap(r);
    this.routes.delete(r.id);
    s.route = 0;
    return true;
  }

  releaseOverlap(r: Route) {
    for (const e of r.overlap) if (this.g.edges[e].overlap === r.id) this.g.edges[e].overlap = 0;
    r.overlap = [];
  }

  proceeds(s: Signal, now: number): boolean {
    if (!s.route || this.faultySignals.has(s.id)) return false;
    const r = this.routes.get(s.route);
    return !!r && !r.used && r.readyAt <= now;
  }

  // Zug passiert Startsignal: Signal fällt auf Halt
  passed(s: Signal, trainId: number) {
    const r = this.routes.get(s.route);
    if (!r) return;
    r.used = true;
    r.train = trainId;
    s.route = 0;
  }

  // Abschnitt vom Zugschluss geräumt: Teilauflösung
  edgeCleared(e: number) {
    const E = this.g.edges[e];
    if (!E.lock) return;
    const r = this.routes.get(E.lock);
    if (!r || !r.used) return;
    E.lock = 0;
    r.remaining.delete(e);
    if (r.remaining.size === 0) {
      this.releaseOverlap(r);
      this.routes.delete(r.id);
    }
  }

  // Zug endet oder wendet: Rest seiner befahrenen Fahrstraßen auflösen
  releaseTrain(trainId: number) {
    for (const r of [...this.routes.values()]) {
      if (r.train !== trainId || !r.used) continue;
      for (const e of r.path.edges) if (this.g.edges[e].lock === r.id && !this.g.edges[e].occ) {
        this.g.edges[e].lock = 0;
        r.remaining.delete(e);
      }
      this.releaseOverlap(r);
      if (r.remaining.size === 0) this.routes.delete(r.id);
    }
  }

  // Wenn der Zug am Zielsignal steht, wird der Durchrutschweg nach kurzer Zeit aufgelöst
  releaseOverlapForTrain(trainId: number) {
    for (const r of this.routes.values()) if (r.train === trainId && r.overlap.length) this.releaseOverlap(r);
  }

  // Signalbegriff: 0 = Halt, 1 = Fahrt, 2 = Fahrt + Halt erwarten
  aspect(s: Signal, now: number): { stop: boolean; expectStop: boolean; zs3: number; zs1: boolean; zs3v: number } {
    if (!this.proceeds(s, now)) return { stop: true, expectStop: false, zs3: 0, zs1: this.zs1.has(s.id), zs3v: 0 };
    const r = this.routes.get(s.route)!;
    const end = r.path.endSig ? this.sig(r.path.endSig) : null;
    const expectStop = !!end && !this.proceeds(end, now);
    const zs3 = r.path.diverging || r.path.vmax < 100 ? Math.floor(Math.min(r.path.vmax, 100) / 10) : 0;
    let zs3v = 0;
    if (end && !expectStop) {
      const nr = this.routes.get(end.route);
      if (nr && (nr.path.diverging || nr.path.vmax < 100)) zs3v = Math.floor(Math.min(nr.path.vmax, 100) / 10);
    }
    return { stop: false, expectStop, zs3, zs1: false, zs3v };
  }

  // Begriff eines Vorsignals: Halt erwarten, Fahrt erwarten oder Geschwindigkeit erwarten (Ks1 blinkend)
  distantAspect(mainId: number, now: number): { expectStop: boolean; zs3v: number } {
    const m = this.sig(mainId);
    if (!this.proceeds(m, now)) return { expectStop: true, zs3v: 0 };
    const a = this.aspect(m, now);
    return { expectStop: false, zs3v: a.zs3 };
  }

  isDivergingEdge(n: number, e: number) {
    return isDiverging(this.g, n, e);
  }
}
