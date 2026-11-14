import { Dir, Graph } from "./graph";

// Fahrplan: echte Personenzüge aus GTFS, Güterzüge realistisch generiert.

export type Cat = "S" | "RE" | "RB" | "ICE" | "G";

export interface TTStop {
  st: string;
  arr: number;
  dep: number;
}

export interface TripSpec {
  key: number;
  no: string;
  line: string;
  cat: Cat;
  dir: Dir;
  from: string;
  to: string;
  stops: TTStop[];
  entryPortal?: string; // undefined = beginnt im Bereich
  exitPortal?: string; // undefined = endet im Bereich
  entryTime: number; // Sekunden ab Mitternacht
  turnInto?: TripSpec; // Wende: Fortsetzung als dieser Zug
  turnedFrom?: TripSpec;
  len: number;
  vmax: number; // km/h
  acc: number;
  dec: number;
  mass?: number; // t (Güterzüge)
  initialDelay: number; // Sekunden
}

interface RawTrain {
  line: string;
  from: string;
  to: string;
  prev: string | null;
  next: string | null;
  stops: TTStop[];
}

export interface RawTimetable {
  date: string;
  source: string;
  stations: Record<string, string>;
  trains: RawTrain[];
}

// Kleiner deterministischer Zufallsgenerator, damit jeder Spieltag reproduzierbar ist
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function catOf(line: string): Cat {
  if (line.startsWith("S")) return "S";
  if (line.startsWith("ICE") || line.startsWith("IC")) return "ICE";
  if (line.startsWith("RE")) return "RE";
  return "RB";
}

const VEHICLE: Record<Cat, { len: number; vmax: number; acc: number; dec: number }> = {
  S: { len: 136, vmax: 140, acc: 0.9, dec: 0.9 },
  RE: { len: 150, vmax: 160, acc: 0.75, dec: 0.8 },
  RB: { len: 84, vmax: 120, acc: 0.7, dec: 0.8 },
  ICE: { len: 400, vmax: 300, acc: 0.45, dec: 0.6 },
  G: { len: 600, vmax: 100, acc: 0.18, dec: 0.32 },
};

function portalFor(line: string, cat: Cat, side: "W" | "E"): string {
  if (cat === "ICE") return side === "W" ? "W_SFS" : "E_SFS";
  if (cat === "S") return side === "W" ? "W_S" : "E_BZ";
  if (line === "RB90") return side === "W" ? "WW" : "E_BZ";
  return side === "W" ? "W_M" : "E_BZ";
}

// Grobe Fahrzeit vom Streckenende bis zum ersten Halt (für die Einbruchszeit)
function approachTime(g: Graph, portal: string, st: string, vmax: number): number {
  const p = g.portals[portal], s = g.stations[st];
  const n = g.nodes[p.inNode];
  // Schematische Distanz grob in Meter umrechnen
  const dist = Math.abs(n.x - s.x) * 160;
  const v = Math.min(vmax, 120) / 3.6 * 0.75;
  return Math.max(120, Math.round(dist / v) + 60);
}

export function buildTrips(g: Graph, raw: RawTimetable, seed: number): TripSpec[] {
  const r = rng(seed);
  const trips: TripSpec[] = [];
  const counters: Record<string, number> = {};
  let key = 1;
  for (const t of raw.trains) {
    if (!t.stops.length || !t.stops.every((s) => g.stations[s.st])) continue;
    const cat = catOf(t.line);
    let dir: Dir;
    if (t.stops.length >= 2) dir = g.stations[t.stops[t.stops.length - 1].st].x > g.stations[t.stops[0].st].x ? 1 : -1;
    else if (cat === "ICE") dir = (t.prev ?? "").includes("Köln") || (t.prev ?? "").includes("Düsseldorf") ? 1 : -1;
    else {
      // Einzelhalt (z. B. Betzdorf): Richtung aus Herkunft ableiten
      dir = t.prev ? -1 : 1;
    }
    const v = VEHICLE[cat];
    const base = t.line.replace(/\s/g, "");
    counters[base] = (counters[base] ?? 0) + 1;
    // Zugnummern: GTFS liefert keine echten Nummern, daher linienbezogen erzeugt (Ost ungerade, West gerade)
    const num = lineBase(base) + counters[base] * 2 + (dir > 0 ? 1 : 0);
    const entryPortal = t.prev ? portalFor(t.line, cat, dir > 0 ? "W" : "E") : undefined;
    const exitPortal = t.next ? portalFor(t.line, cat, dir > 0 ? "E" : "W") : undefined;
    const first = t.stops[0];
    const entryTime = entryPortal ? first.arr - approachTime(g, entryPortal, first.st, v.vmax) : first.dep - 360;
    const dr = r();
    const initialDelay = entryPortal ? (dr < 0.6 ? Math.floor(r() * 90) : dr < 0.9 ? 60 + Math.floor(r() * 300) : 300 + Math.floor(r() * 900)) : 0;
    trips.push({
      key: key++, no: `${prefix(cat, t.line)} ${num}`, line: t.line, cat, dir,
      from: t.from, to: t.to, stops: t.stops.map((s) => ({ ...s })),
      entryPortal, exitPortal, entryTime, ...v, initialDelay,
    });
  }
  pairTurnarounds(trips);
  trips.push(...freight(g, seed));
  trips.sort((a, b) => a.entryTime - b.entryTime);
  return trips;
}

function prefix(cat: Cat, line: string) {
  return cat === "ICE" ? "ICE" : cat === "S" ? line : line.replace(/\d+/, "");
}

function lineBase(line: string): number {
  const m: Record<string, number> = { S12: 31200, S19: 31900, RE9: 10900, RE99: 10990, RB90: 23900, RB96: 13600, RB97: 13700 };
  if (m[line]) return m[line];
  if (line.startsWith("ICE")) return 500 + Number(line.replace(/\D/g, "")) * 10;
  return 20000;
}

// Endende Züge mit passendem Gegenzug derselben Linie verknüpfen (Wende am Bahnsteig)
function pairTurnarounds(trips: TripSpec[]) {
  const starting = trips.filter((t) => !t.entryPortal);
  const used = new Set<number>();
  const ending = trips.filter((t) => !t.exitPortal).sort((a, b) => last(a).arr - last(b).arr);
  for (const t of ending) {
    const st = last(t).st, arr = last(t).arr;
    let best: TripSpec | undefined;
    for (const s of starting) {
      if (used.has(s.key) || s.line !== t.line || s.stops[0].st !== st) continue;
      const dep = s.stops[0].dep;
      if (dep < arr + 180 || dep > arr + 3600) continue;
      if (!best || dep < best.stops[0].dep) best = s;
    }
    if (best) {
      used.add(best.key);
      t.turnInto = best;
      best.turnedFrom = t;
    }
  }
}

function last(t: TripSpec) {
  return t.stops[t.stops.length - 1];
}

// Güterverkehr: Fahrplanlagen sind nicht öffentlich. Generiert nach typischem Muster der Relationen
// Gremberg – Rechte Rheinstrecke (Richtung Koblenz) und Gremberg – Siegstrecke (Richtung Siegen).
function freight(g: Graph, seed: number): TripSpec[] {
  const r = rng(seed * 7 + 3);
  const out: TripSpec[] = [];
  let n = 0;
  const relations: { a: string; b: string; from: string; to: string; perHour: (h: number) => number; vmax: number }[] = [
    { a: "W_M", b: "S_BB", from: "Köln-Gremberg", to: "Koblenz-Lützel", perHour: (h) => (h >= 22 || h < 5 ? 3 : 1.6), vmax: 100 },
    { a: "S_BB", b: "W_M", from: "Koblenz-Lützel", to: "Köln-Gremberg", perHour: (h) => (h >= 22 || h < 5 ? 3 : 1.6), vmax: 100 },
    { a: "W_M", b: "E_BZ", from: "Köln-Gremberg", to: "Siegen-Ost", perHour: (h) => (h >= 20 || h < 6 ? 0.6 : 0.35), vmax: 90 },
    { a: "E_BZ", b: "W_M", from: "Kreuztal", to: "Köln-Gremberg", perHour: (h) => (h >= 20 || h < 6 ? 0.6 : 0.35), vmax: 90 },
  ];
  for (const rel of relations) {
    let t = r() * 1800;
    while (t < 86400) {
      const h = Math.floor(t / 3600);
      const dir: Dir = g.portals[rel.a].dir;
      const len = 350 + Math.round(r() * 39) * 10;
      const mass = Math.round(len * (2.2 + r() * 1.6));
      const no = (dir > 0 ? 45001 : 45000) + 2 * n++ + (rel.b === "E_BZ" || rel.a === "E_BZ" ? 6000 : 0);
      out.push({
        key: 100000 + out.length, no: `GZ ${no}`, line: "GZ", cat: "G", dir, from: rel.from, to: rel.to, stops: [],
        entryPortal: rel.a, exitPortal: rel.b, entryTime: Math.round(t), len, vmax: rel.vmax,
        acc: 0.12 + (1 - mass / 2400) * 0.12, dec: 0.3, mass,
        initialDelay: Math.floor(r() * r() * 1800),
      });
      t += (3600 / rel.perHour(h)) * (0.6 + r() * 0.8);
    }
  }
  return out;
}
