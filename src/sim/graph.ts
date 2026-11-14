// Gleisgraph: Knoten (Weichen, Signalstandorte, Bahnsteigenden) und Kanten (Gleisabschnitte).
// Konvention: jede Kante läuft von West (a, kleineres x) nach Ost (b). Fahrtrichtung +1 = Ost, -1 = West.

export type Dir = 1 | -1;

export interface GNode {
  id: number;
  x: number;
  y: number;
  s?: number; // Streckenmeter
  east: number[]; // Kanten Richtung Ost
  west: number[]; // Kanten Richtung West
  portal?: string; // Streckenende zur Außenwelt
  buffer?: boolean; // Prellbock
  sigE?: number; // Signal, das Fahrten Richtung Ost ab diesem Knoten deckt
  sigW?: number;
  // Weiche: Seite mit zwei Kanten, Stellung = Index in east/west
  swSide?: Dir;
  swPos: number;
  swName?: string;
}

export interface Platform {
  st: string; // Betriebsstellenkürzel
  track: string; // Gleisnummer
}

export interface GEdge {
  id: number;
  a: number;
  b: number;
  len: number; // Meter
  vmax: number; // km/h
  pref?: Dir; // Regelfahrrichtung (Rechtsfahrbetrieb)
  platform?: Platform;
  occ: number; // Anzahl Züge im Abschnitt
  lock: number; // Fahrstraßen-ID oder 0
  overlap: number; // Durchrutschweg-ID oder 0
  slow?: number; // Langsamfahrstelle (km/h)
  closed?: boolean; // Gleis gesperrt
  work?: boolean; // Baustelle
}

// zulässige Geschwindigkeit einer Kante unter Berücksichtigung von Langsamfahrstellen
export function vEdge(e: GEdge): number {
  return e.slow ? Math.min(e.vmax, e.slow) : e.vmax;
}

export type SignalKind = "main" | "block";

// Vorsignal: kündigt den Begriff des Hauptsignals `main` an, steht auf Kante `edge` im Abstand `pos` vom Westende
export interface Distant {
  main: number;
  dir: Dir;
  edge: number;
  pos: number;
  dist: number; // Abstand zum Hauptsignal (m)
}

export interface Signal {
  id: number;
  node: number;
  dir: Dir;
  name: string;
  kind: SignalKind;
  auto: boolean; // Selbststellbetrieb / Zuglenkung
  route: number; // aktive Fahrstraße ab diesem Signal (0 = Halt)
  combined?: boolean; // Mehrabschnittssignal: zeigt zugleich den Begriff des nächsten Hauptsignals an
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  signals: Signal[];
  stations: Record<string, { name: string; x: number; y: number; s?: number }>;
  portals: Record<string, { inNode: number; outNode: number; dir: Dir; label: string }>; // dir = Fahrtrichtung einfahrender Züge
  labels: { x: number; y: number; text: string; size?: number }[];
  breakpoints: number[]; // mögliche Zeilenumbrüche (x)
  distants?: Distant[];
}

// Vorsignale bestimmen: Liegt das vorherige Hauptsignal näher als 1300 m, wird es zum Mehrabschnittssignal,
// sonst steht 1000 m (S-Bahn/Nebengleise 700 m) vor dem Hauptsignal ein eigenes Vorsignal.
export function placeDistants(g: Graph) {
  g.distants = [];
  for (const s of g.signals) {
    const want = s.kind === "block" || g.nodes[s.node].y === 4 || g.nodes[s.node].y === 5 || g.nodes[s.node].y < 2 ? 1000 : 700;
    let n = s.node, dist = 0, placed = false;
    for (let k = 0; k < 30 && !placed; k++) {
      const node = g.nodes[n];
      const back = s.dir > 0 ? node.west : node.east;
      if (back.length === 0) break;
      const e = g.edges[back[0]];
      const m = otherEnd(e, n);
      if (dist + e.len >= want) {
        // Vorsignal liegt auf dieser Kante
        const fromN = want - dist; // Abstand ab Knoten n rückwärts
        const pos = e.a === n ? fromN : e.len - fromN;
        g.distants.push({ main: s.id, dir: s.dir, edge: e.id, pos, dist: want });
        placed = true;
        break;
      }
      dist += e.len;
      n = m;
      const prev = s.dir > 0 ? g.nodes[n].sigE : g.nodes[n].sigW;
      if (prev) {
        g.signals[prev - 1].combined = true;
        placed = true;
      }
    }
  }
}

export function otherEnd(e: GEdge, n: number) {
  return e.a === n ? e.b : e.a;
}

// Kante, die ein Zug in Richtung d an Knoten n nimmt (gemäß Weichenstellung)
export function nextEdge(g: Graph, n: number, d: Dir): number | undefined {
  const node = g.nodes[n];
  const opts = d > 0 ? node.east : node.west;
  if (opts.length === 0) return undefined;
  if (opts.length === 1) return opts[0];
  return opts[node.swPos];
}

// Kommt ein Zug aus Kante e in Knoten n an: passt die Weichenstellung (stumpf befahren)?
export function trailingOk(g: Graph, n: number, fromEdge: number): boolean {
  const node = g.nodes[n];
  if (node.swSide === undefined) return true;
  const side = node.swSide > 0 ? node.east : node.west;
  const idx = side.indexOf(fromEdge);
  if (idx < 0) return true; // von der Weichenspitze her
  return node.swPos === idx;
}

export function isDiverging(g: Graph, n: number, e: number): boolean {
  const node = g.nodes[n];
  if (node.swSide === undefined) return false;
  const side = node.swSide > 0 ? node.east : node.west;
  return side.indexOf(e) === 1;
}
