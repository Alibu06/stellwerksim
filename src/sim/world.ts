import { Extras } from "./extras";
import { Ops } from "./ops";
import { Life } from "./life";
import { Phone } from "./phone";
import { Dir, GEdge, Graph, nextEdge, otherEnd, trailingOk, vEdge } from "./graph";
import { Interlocking, PathDef } from "./interlocking";
import { Cat, TripSpec, TTStop, rng } from "./timetable";

export interface StopState extends TTStop {
  done: boolean;
  missed?: boolean;
  actArr?: number;
  actDep?: number;
  plan?: string; // Regelgleis laut Fahrplan
  disp?: string; // dispositiv angeordnetes Gleis (Gleisänderung)
  betr?: boolean; // Betriebshalt (z. B. für eine Überholung)
  track?: string; // tatsächlich benutztes Gleis
}

export interface Train {
  id: number;
  trip: TripSpec;
  no: string;
  cat: Cat;
  len: number;
  vmax: number; // m/s
  acc: number;
  dec: number;
  v: number;
  dir: Dir;
  body: number[]; // Kanten vom Zugschluss zur Spitze
  headPos: number; // Meter in der Kopfkante (in Fahrtrichtung)
  stops: StopState[];
  stopIdx: number;
  dwellUntil: number;
  dwelling: boolean;
  exiting: boolean;
  gone: boolean;
  delay: number; // Sekunden
  delayIn: number;
  nextSig: number;
  distNextSig: number;
  stopAheadIsPlatform: boolean;
  waitRed: number; // Sekunden vor Halt zeigendem Signal
  standStill: number;
  stillT?: number; stopT?: number; // Sekunden Stillstand außerhalb des Bahnsteighalts
  reverseAt: number; // geplante Wende
  dissolveAt: number; // Abstellung
  fault?: string; // aktuelle Störung am Zug
  faultUntil: number;
  sight: boolean; // Fahrt auf Sicht nach Ersatzsignal
  zsCap?: number; zsLeft?: number; // Zs 3 hinter dem zuletzt passierten Signal
  sev?: string; // Ersatzverkehr (Text für die Fahrgastinfo)
  orderV?: number; // Höchstgeschwindigkeit laut Befehl (km/h), gilt bis zum nächsten Hauptsignal
  raeum?: number; // Räumungsprüfung für diesen Achszählabschnitt
  hold: boolean; // Halt auf Anordnung des Fahrdienstleiters (Funk)
  causes: Record<string, number>; // erfasste Wartezeiten nach Ursache (Sekunden)
  reason?: string; // vom Fahrdienstleiter eingetragene Verspätungsursache
  reasonNote?: string;
  extraDwell: number; // Anschluss abwarten (Sekunden, beim nächsten Halt)
  holdFor?: { st: string; sec: number };
  medStop?: { st: string; sec: number; rtwAt?: number }; // Rettungsdienst erwartet den Zug an diesem Halt
  waitFor?: { st: string; train: number; since?: number; no?: string }; // Überholung abwarten
  shunt?: { edges: number[]; label: string; rev?: ShuntTarget["rev"] }; // laufende Rangierfahrt
  shunted?: boolean; // Anschluss abwarten an bestimmtem Bahnhof (Disposition)
  parked?: boolean; // abgestellt (Nebengleis), wartet auf neue Leistung
  bereit?: number; // Fahrt, für die dieser abgestellte Zug bereitgestellt wird
  couple?: number; // abgestellte Einheit: kuppelt an diesen Zug
  waitCouple?: { unit?: number; until: number }; // Zug wartet auf Verstärkung
  splitAt?: number; // Zeitpunkt zum Abhängen der hinteren Einheit
  rescue?: number; // Hilfslok: soll diesen liegengebliebenen Zug abschleppen
  towed?: boolean; // wird von der Hilfslok geschleppt
  waitBus?: number; // wartet auf diesen SEV-Bus
  driver: string; // Name Triebfahrzeugführer/in
  tfz: string; // Baureihe
  radio: { t: number; from: "fdl" | "tf"; text: string }[];
}

export interface ShuntTarget {
  label: string;
  dir: Dir;
  edges: number[];
  rev?: { node: number; after: number[]; edges: number[] }; // Sägefahrt: nach Richtungswechsel weiter über diese Kanten
}

export interface Fault {
  id: number;
  kind: "switch" | "signal" | "door" | "vehicle" | "bue" | "event" | "az";
  target: number; // Knoten-, Signal- oder Zug-ID
  until: number;
  text: string;
  from?: number;
}

// Zugmeldeverfahren mit den Nachbarstellwerken
export interface Report {
  id: number;
  no: string;
  trip: TripSpec;
  portal: string;
  kind: "in" | "out"; // in = Nachbar bietet an (Spieler nimmt an), out = Spieler bietet dem Nachbarn an
  state: "offered" | "accepted" | "refused";
  t: number;
  respondAt?: number;
  note?: string;
}

// Zuständiger Bahnhof für ein Streckenende (Zugmeldungen nur dort von Hand, wo der Spieler stellt)
export const PORTAL_AREA: Record<string, string> = { W_S: "TR", W_M: "TR", W_SFS: "TR", W_FL: "TR", S_BB: "TR", E_SFS: "SB", WW: "AU", E_BZ: "BZ", E_HT: "BZ", E_DT: "BZ" };

export interface GameEvent {
  t: number;
  text: string;
  kind: "info" | "warn" | "bad" | "good";
}

export interface Score {
  points: number;
  trainsDone: number;
  punctual: number;
  waitMinutes: number;
  missedStops: number;
  incidents: number;
  causes: Record<string, number>; // Verspätungsminuten nach Ursache (abgeschlossene Fahrten)
  delayMin: number; // selbst verursachte Verspätungsminuten
  late: { no: string; min: number; cause: string }[];
  trackChanges?: number;
}

const DT = 0.5;
const clock = (sec: number) => {
  const x = Math.floor(((sec % 86400) + 86400) % 86400);
  return `${String(Math.floor(x / 3600)).padStart(2, "0")}:${String(Math.floor(x / 60) % 60).padStart(2, "0")}`;
};

export class World {
  il: Interlocking;
  trains: Train[] = [];
  time: number;
  events: GameEvent[] = [];
  score: Score = { points: 0, trainsDone: 0, punctual: 0, waitMinutes: 0, missedStops: 0, incidents: 0, causes: {}, delayMin: 0, late: [] };
  private pending: TripSpec[];
  private nextTrainId = 1;
  private acc = 0;
  private zlTimer = 0;
  private distCache = new Map<string, Map<string, number>>();
  faults: Fault[] = [];
  faultRate = 1; // 0 = aus
  private rand = rng(4711);
  private faultTimer = 0;
  private faultId = 1;
  reports: Report[] = [];
  private reportId = 1;
  zugmeldung = true; // Funktion an/aus
  manualAreas = new Set<string>(); // Bahnhöfe, die der Spieler stellt
  ext: Extras;
  ops: Ops;
  life: Life;
  phone: Phone;
  connAlerts: { id: number; feeder: number; conn: number; st: string; t: number; wait: number }[] = [];

  constructor(public g: Graph, trips: TripSpec[], startTime: number) {
    this.il = new Interlocking(g);
    this.time = startTime;
    this.findSingleTracks();
    this.ext = new Extras(this);
    this.ops = new Ops(this);
    this.life = new Life(this);
    this.phone = new Phone(this);
    // Züge, deren Fahrt bei Spielbeginn schon vorbei ist, entfallen; Wendezüge werden vom Vorgänger übernommen
    this.allTrips = trips;
    this.pending = trips.filter((t) => !t.turnedFrom && t.entryTime + t.initialDelay >= startTime - 60);
    this.buildUmlauf(trips);
    this.ops.start(trips);
    this.life.start();
    this.planCoupling(trips);
  }

  // ---------------- Umläufe außerhalb des Bereichs ----------------
  // Ein Zug, der den Bereich verlässt, kommt mit demselben Fahrzeug später als Gegenzug derselben Linie zurück.
  umlaufNext = new Map<number, { trip: TripSpec; slack: number }>();
  private buildUmlauf(trips: TripSpec[]) {
    const lastDep = (t: TripSpec) => (t.stops.length ? t.stops[t.stops.length - 1].dep : t.entryTime);
    const outs = trips.filter((t) => t.exitPortal && t.cat !== "G").sort((a, b) => lastDep(a) - lastDep(b));
    const ins = trips.filter((t) => t.entryPortal && t.cat !== "G" && !t.turnedFrom);
    const used = new Set<TripSpec>();
    const pairs: { a: TripSpec; b: TripSpec; gap: number; k: string }[] = [];
    for (const a of outs) {
      const te = lastDep(a);
      let best: TripSpec | undefined, bg = Infinity;
      for (const b of ins) {
        if (used.has(b) || b.entryPortal !== a.exitPortal || b.line !== a.line || b.dir === a.dir) continue;
        const gap = b.entryTime - te;
        if (gap >= 900 && gap <= 4 * 3600 && gap < bg) { bg = gap; best = b; }
      }
      if (!best) continue;
      used.add(best);
      pairs.push({ a, b: best, gap: bg, k: `${a.exitPortal}|${a.line}` });
    }
    const minGap = new Map<string, number>();
    for (const p of pairs) minGap.set(p.k, Math.min(minGap.get(p.k) ?? Infinity, p.gap));
    for (const p of pairs) this.umlaufNext.set(p.a.key, { trip: p.b, slack: p.gap - minGap.get(p.k)! });
  }
  private umlaufExit(t: Train) {
    const n = this.umlaufNext.get(t.trip.key);
    if (!n || !this.pending.includes(n.trip)) return;
    const add = this.liveDelay(t) - n.slack;
    if (add > 120 && add > n.trip.initialDelay) {
      n.trip.initialDelay = add;
      n.trip.delayCause = `Verspätung aus dem Umlauf (Vorleistung ${t.no})`;
      this.pending.sort((a, b) => a.entryTime + a.initialDelay - (b.entryTime + b.initialDelay));
      this.log(`Umlauf: Das Fahrzeug von ${t.no} kommt als ${n.trip.no} zurück, voraussichtlich +${Math.round(add / 60)} min`, "info");
    }
  }
  // Fahrzeug fehlt: Rückleistung entfällt
  private umlaufCancel(trip: TripSpec, why: string) {
    const n = this.umlaufNext.get(trip.key);
    if (!n || !this.pending.includes(n.trip)) return;
    this.pending = this.pending.filter((x) => x !== n.trip);
    this.reports = this.reports.filter((r) => r.trip !== n.trip);
    this.log(`Umlauf: ${n.trip.no} fällt aus, weil das Fahrzeug von ${trip.no} fehlt (${why})`, "warn");
  }
  umlaufNo(trip: TripSpec): string | undefined { return this.umlaufNext.get(trip.key)?.trip.no; }

  log(text: string, kind: GameEvent["kind"] = "info") {
    this.events.push({ t: this.time, text, kind });
    if (this.events.length > 200) this.events.shift();
  }

  // ---------------- Hauptschleife ----------------
  advance(realDt: number, speed: number) {
    this.acc += realDt * speed;
    let steps = 0;
    while (this.acc >= DT && steps < 4000) {
      this.step(DT);
      this.acc -= DT;
      steps++;
    }
  }

  step(dt: number) {
    this.time += dt;
    if (this.zugmeldung) this.reportsTick();
    this.ext.step(dt);
    this.ops.step(dt);
    this.life.step(dt);
    this.phone.step();
    this.spawn();
    for (const t of this.trains) this.drive(t, dt);
    this.trains = this.trains.filter((t) => !t.gone);
    this.faultTimer += dt;
    if (this.faultTimer >= 10) {
      this.faultTimer = 0;
      this.faultsTick();
    }
    if (this.orders.length || this.pendingRadio.length) this.ordersTick();
    if (this.orderSw.length) this.releaseOrderSw();
    this.depotTimer += dt;
    if (this.depotTimer >= 10) { this.depotTimer = 0; this.depotTick(); this.couplingTick(); this.rescueTick(); this.routeJanitor(); this.jamResolver(); this.readyCalls(); }
    this.zlTimer += dt;
    if (this.zlTimer >= 2) {
      this.zlTimer = 0;
      this.autoRoutes();
      this.queueTick();
    }
  }

  // ---------------- Züge einsetzen ----------------
  private spawn() {
    if (!this.pending.length || this.pending[0].entryTime + this.pending[0].initialDelay > this.time) return;
    const assigned = new Set(this.trains.filter((t) => t.bereit).map((t) => t.bereit));
    const due = this.pending.filter((q) => q.entryTime + q.initialDelay <= this.time);
    let resort = false;
    for (const trip of due) {
      if (assigned.has(trip.key)) continue; // wird aus der Abstellung bereitgestellt
      const ok = trip.entryPortal ? this.spawnAtPortal(trip) : this.spawnAtPlatform(trip);
      if (!ok) {
        // Einbruch nicht möglich (Gleis belegt): später erneut versuchen
        trip.initialDelay += 20;
        resort = true;
        continue;
      }
      this.pending.splice(this.pending.indexOf(trip), 1);
    }
    if (resort) this.pending.sort((a, b) => a.entryTime + a.initialDelay - (b.entryTime + b.initialDelay));
  }

  private newTrain(trip: TripSpec, body: number[], headPos: number): Train {
    const t: Train = {
      id: this.nextTrainId++, trip, no: trip.no, cat: trip.cat, len: trip.len, vmax: trip.vmax / 3.6,
      acc: trip.acc, dec: trip.dec, v: 0, dir: trip.dir, body, headPos,
      stops: trip.stops.map((s) => ({ ...s, done: false, plan: this.planFor(trip, s.st) })), stopIdx: 0, dwellUntil: 0, dwelling: false,
      exiting: false, gone: false, delay: trip.initialDelay, delayIn: trip.initialDelay, nextSig: 0, distNextSig: Infinity,
      stopAheadIsPlatform: false, waitRed: 0, standStill: 0, reverseAt: 0, dissolveAt: 0, faultUntil: 0, sight: false, hold: false, causes: trip.initialDelay > 60 ? { [trip.delayCause ?? "Verspätung aus dem Vorbereich"]: trip.initialDelay } : {}, extraDwell: 0, radio: [], ...this.crew(trip),
    };
    this.ext.applyPerf(t);
    for (const st of t.stops) st.disp = this.dispTrack.get(`${trip.key}|${st.st}`);
    for (const e of body) this.g.edges[e].occ++;
    this.trains.push(t);
    return t;
  }

  private spawnAtPortal(trip: TripSpec): boolean {
    if (this.zugmeldung && !this.reports.some((r) => r.kind === "in" && r.trip === trip && r.state === "accepted")) return false;
    const p = this.g.portals[trip.entryPortal!];
    const n = this.g.nodes[p.inNode];
    const e = (p.dir > 0 ? n.east : n.west)[0];
    const E = this.g.edges[e];
    if (E.occ || E.lock) return false;
    // Eingleisige Strecke: nicht einfahren, solange ein Gegenzug zu diesem Streckenende unterwegs ist
    if (p.inNode === p.outNode && this.trains.some((u) => u.trip.exitPortal === trip.entryPortal && u.stopIdx >= u.stops.length - 1 && u.body.some((x) => this.g.edges[x].platform))) return false;
    const t = this.newTrain(trip, [e], Math.min(E.len - 30, trip.len + 50));
    t.v = Math.min(t.vmax, 80 / 3.6);
    if (trip.initialDelay >= 300) this.log(`${trip.no} kommt mit +${Math.round(trip.initialDelay / 60)} min von ${p.label}`, "info");
    return true;
  }

  private spawnAtPlatform(trip: TripSpec): boolean {
    const st = trip.stops[0].st;
    const cands = this.g.edges.filter((e) => e.platform?.st === st && !e.occ && !e.lock && !e.overlap && e.len >= trip.len);
    if (!cands.length) return false;
    // Bevorzugt Gleise mit dem günstigsten Weg zum nächsten Ziel
    const goal = trip.stops[1] ? `st:${trip.stops[1].st}` : trip.exitPortal ? `pt:${trip.exitPortal}` : "none";
    const cost = (e: (typeof cands)[0]) => {
      if (goal === "none") return 0;
      const sa = this.sigAhead(trip.dir > 0 ? e.b : e.a, trip.dir);
      return sa ? sa.dist + this.distSig(sa.sid, goal) : 1e9;
    };
    cands.sort((a, b) => cost(a) - cost(b));
    const e = cands[0];
    if (cost(e) >= 1e8 || (cands.length && cost(e) > 1.5 * this.bestPlatformCost(st, trip) + 800)) return false;
    const t = this.newTrain(trip, [e.id], e.len - 15);
    this.arrive(t, true);
    if (!trip.turnedFrom) {
      const probe = trip.cat === "G" ? 600 : 180;
      t.dwellUntil = Math.max(t.dwellUntil, this.time + probe);
      this.brakeTest(t, probe);
    }
    return true;
  }

  // Regelgleis eines Bahnhofs je Fahrtrichtung (durchgehendes Hauptgleis mit Bahnsteig, sonst kleinste Gleisnummer)
  private planCache = new Map<string, string | undefined>();
  trackPlan?: Record<string, string>; // Regelgleise je Linie|Richtung|Bahnhof (aus data/tracks.json)
  // Regelgleis eines bestimmten Zuges: wie die Linie, außer dort steht planmäßig schon ein anderer Zug (Wende, langer Halt)
  private allTrips: TripSpec[] = [];
  private tripPlan?: Map<string, string>;
  planFor(trip: TripSpec, st: string): string | undefined {
    if (this.trackPlan && !this.tripPlan) this.buildTripPlan();
    return this.tripPlan?.get(`${trip.key}|${st}`) ?? this.planTrack(st, trip.dir, trip.line, trip.to);
  }
  planConflicts: string[] = [];
  private buildTripPlan() {
    const m = new Map<string, string>(); this.tripPlan = m;
    const cand = new Map<string, Set<string>>();
    for (const [k, v] of Object.entries(this.trackPlan!)) { const [, d, st] = k.split("|"); const kk = `${st}|${d}`; if (!cand.has(kk)) cand.set(kk, new Set()); cand.get(kk)!.add(v); }
    const vis: { st: string; a: number; b: number; dir: Dir; def: string; keys: string[]; no: string }[] = [];
    for (const t0 of this.allTrips) {
      if (t0.cat === "G" || t0.turnedFrom) continue;
      const seen = new Set<number>();
      for (let cur: TripSpec | undefined = t0; cur && !seen.has(cur.key); cur = cur.turnInto) {
        seen.add(cur.key);
        const c = cur;
        c.stops.forEach((s, i) => {
          if (i === 0 && c.turnedFrom && c.turnedFrom.stops[c.turnedFrom.stops.length - 1]?.st === s.st) return; // beim Vorgänger erfasst
          const last = i === c.stops.length - 1 && !c.exitPortal;
          const keys = [`${c.key}|${s.st}`];
          let b = s.dep + 60;
          if (last && c.turnInto && c.turnInto.stops[0]?.st === s.st) { keys.push(`${c.turnInto.key}|${s.st}`); b = c.turnInto.stops[0].dep + 60; }
          else if (last) b = s.dep + 600;
          const a = i === 0 && !c.entryPortal && !c.turnedFrom ? s.dep - 900 : s.arr - 60;
          const def = this.planTrack(s.st, c.dir, c.line, c.to);
          if (def) vis.push({ st: s.st, a, b, dir: c.dir, def, keys, no: c.no });
        });
      }
    }
    vis.sort((x, y) => x.a - y.a);
    const occ = new Map<string, { a: number; b: number; no: string }[]>();
    const who = (st: string, tr: string, a: number, b: number) => (occ.get(`${st}|${tr}`) ?? []).find((o) => o.a < b && a < o.b);
    for (const v of vis) {
      let tr = v.def;
      const o = who(v.st, tr, v.a, v.b);
      if (o) {
        const alt = [...(cand.get(`${v.st}|${v.dir}`) ?? [])].find((x) => x !== tr && !who(v.st, x, v.a, v.b));
        if (alt) { tr = alt; for (const k of v.keys) m.set(k, tr); this.planConflicts.push(`${v.no} ${v.st}: Gl ${v.def} (dort ${o.no}) -> ${tr}`); }
      }
      const k = `${v.st}|${tr}`; if (!occ.has(k)) occ.set(k, []); occ.get(k)!.push({ a: v.a, b: v.b, no: v.no });
    }
  }
  planTrack(st: string, dir: Dir, line = "", to = ""): string | undefined {
    if (this.trackPlan) return this.trackPlan[`${line}|${dir}|${st}|${to}`];
    const k = `${st}${dir}`;
    if (this.planCache.has(k)) return this.planCache.get(k);
    const es = this.g.edges.filter((e) => e.platform?.st === st);
    const num = (x: string) => parseInt(x, 10) || 99;
    const pick = (l: typeof es) => [...new Set(l.map((e) => e.platform!.track))].sort((a, b) => num(a) - num(b))[0];
    const r = pick(es.filter((e) => e.pref === dir)) ?? pick(es.filter((e) => !e.pref)) ?? pick(es);
    this.planCache.set(k, r);
    return r;
  }

  private bestPlatformCost(st: string, trip: TripSpec): number {
    const goal = trip.stops[1] ? `st:${trip.stops[1].st}` : trip.exitPortal ? `pt:${trip.exitPortal}` : "none";
    if (goal === "none") return 0;
    let best = 1e9;
    for (const e of this.g.edges) {
      if (e.platform?.st !== st || e.len < trip.len) continue;
      const sa = this.sigAhead(trip.dir > 0 ? e.b : e.a, trip.dir);
      if (sa) best = Math.min(best, sa.dist + this.distSig(sa.sid, goal));
    }
    return best;
  }

  private exitScore(e: { a: number; b: number }, d: Dir) {
    const n = this.g.nodes[d > 0 ? e.b : e.a];
    const sid = d > 0 ? n.sigE : n.sigW;
    return sid && (this.il.paths.get(sid)?.length ?? 0) > 0 ? 1 : 0;
  }

  // Haltepunkt am Bahnsteig: so weit vor dem Ende, dass der ganze Zug zwischen die Signale passt
  private platMargin(t: Train, platLen: number) {
    return Math.max(2, Math.min(12, platLen - t.len - 1));
  }

  // Bremsweg bis zum Stillstand plus Sicherheitszuschlag
  brakeDist(t: Train) {
    return (t.v * t.v) / (2 * t.dec) + 60 + t.v * 3;
  }

  // Fahrstraße zurücknehmen mit Annäherungsverschluss
  cancelRoute(sid: number): string | null {
    const s = this.il.sig(sid);
    const r = this.il.routes.get(s.route);
    if (!r) return "Keine Fahrstraße eingestellt";
    if (r.used) return "Fahrstraße ist schon befahren";
    const near = this.trains.find((t) => t.nextSig === sid && t.v > 0.5 && t.distNextSig < this.brakeDist(t));
    if (near) return `Annäherungsverschluss: ${near.no} ist zu nah und könnte nicht mehr vor dem Signal halten`;
    this.il.cancel(sid);
    return null;
  }

  // ---------------- Fahrdynamik ----------------
  private headEdge(t: Train) {
    return this.g.edges[t.body[t.body.length - 1]];
  }

  private exitNode(t: Train, eid: number) {
    const E = this.g.edges[eid];
    return t.dir > 0 ? E.b : E.a;
  }

  private pendingStop(t: Train): StopState | undefined {
    return t.stops[t.stopIdx];
  }

  // Vorausschau: Geschwindigkeitsbeschränkungen und nächster Haltepunkt
  private lookahead(t: Train) {
    const g = this.g;
    const head = this.headEdge(t);
    let vLimit = Math.min(t.vmax, ...t.body.map((e) => vEdge(g.edges[e]) / 3.6));
    if (t.sight) vLimit = Math.min(vLimit, (t.orderV ?? 40) / 3.6);
    let sight = t.sight;
    let stopDist = Infinity;
    let platformStop = false;
    t.nextSig = 0;
    t.distNextSig = Infinity;
    const ps = this.pendingStop(t);
    const limits: { d: number; v: number }[] = [];
    if (t.exiting) return { vLimit, stopDist, limits, platformStop };
    if (ps && !t.dwelling && head.platform?.st === ps.st) {
      stopDist = head.len - this.platMargin(t, head.len) - t.headPos;
      platformStop = true;
    }
    let d = head.len - t.headPos;
    let eid = head.id;
    const pts = (e: number, entry: number, base: number) => {
      const L = this.ext.pointsOn(e);
      if (!L) return;
      const s0 = g.nodes[entry].s ?? 0;
      for (const p of L) {
        const dd = base + Math.abs(p.s - s0);
        if (dd > -1) limits.push({ d: Math.max(0, dd), v: p.v });
      }
    };
    { const ex = this.exitNode(t, head.id); pts(head.id, ex === head.a ? head.b : head.a, -t.headPos); }
    const horizon = Math.max(1500, (t.vmax * t.vmax) / (2 * t.dec) + 800);
    let zsCap = Infinity, zsUntil = -1;
    while (d < horizon && d < stopDist) {
      const n = this.exitNode(t, eid);
      const node = g.nodes[n];
      const sid = t.dir > 0 ? node.sigE : node.sigW;
      if (sid) {
        const s = this.il.sig(sid);
        if (!t.nextSig) {
          t.nextSig = sid;
          t.distNextSig = d;
        }
        if (!this.il.proceeds(s, this.time)) {
          if (this.il.zs1.has(sid)) {
            // Ersatzsignal: Vorbeifahrt mit höchstens 40 km/h, danach Fahrt auf Sicht
            limits.push({ d, v: 40 / 3.6 });
            sight = true;
          } else {
            if (d - 6 < stopDist) {
              stopDist = d - 6;
              platformStop = false;
            }
            break;
          }
        } else if (sight && d > 0) {
          sight = false;
        }
        // Zs 3: angezeigte Geschwindigkeit gilt, bis der Zug den Weichenbereich verlassen hat
        if (s.kind === "main" && this.il.proceeds(s, this.time)) {
          const a = this.il.aspect(s, this.time);
          if (a.zs3) { zsCap = a.zs3 * 10; zsUntil = d + 300 + t.len; } else zsCap = Infinity;
        }
      }
      if (node.portal && g.portals[node.portal].outNode === n && (t.dir > 0 ? node.east : node.west).length === 0) break;
      const ne = nextEdge(g, n, t.dir);
      if (ne === undefined || !trailingOk(g, n, eid)) {
        if (d - 10 < stopDist) {
          stopDist = d - 10;
          platformStop = false;
        }
        break;
      }
      const NE = g.edges[ne];
      pts(ne, n, d);
      if (sight) {
        // Auf Sicht: vor besetztem Abschnitt anhalten
        if (NE.occ && !t.body.includes(ne)) {
          if (d - 25 < stopDist) {
            stopDist = d - 25;
            platformStop = false;
          }
          break;
        }
        limits.push({ d, v: Math.min(vEdge(NE), 40) / 3.6 });
      } else limits.push({ d, v: Math.min(vEdge(NE), d < zsUntil ? zsCap : Infinity) / 3.6 });
      if (ps && NE.platform?.st === ps.st && d + NE.len - this.platMargin(t, NE.len) < stopDist) {
        stopDist = d + NE.len - this.platMargin(t, NE.len);
        platformStop = true;
        break;
      }
      d += NE.len;
      eid = ne;
    }
    return { vLimit, stopDist, limits, platformStop };
  }

  private drive(t: Train, dt: number) {
    if (t.gone) return;
    if (t.shunt) return this.shuntDrive(t, dt);
    // Steht der Zug 30 s, braucht er keinen Durchrutschweg mehr: auflösen, damit die Weichen dahinter frei werden
    // (langsames Vorziehen an das Signal nach dem Halt zählt nicht als Weiterfahrt)
    t.stillT = t.v < 3 ? (t.stillT ?? 0) + dt : 0;
    t.stopT = t.v < 0.05 ? (t.stopT ?? 0) + dt : 0;
    if (t.stopT > 4) this.il.releaseOverlapForTrain(t.id);
    if (t.dwelling) {
      this.dwell(t);
      if (t.gone) return;
      if (t.dwelling) {
        this.lookahead(t);
        return;
      }
    }
    const la = this.lookahead(t);
    t.stopAheadIsPlatform = la.platformStop;
    let allowed = la.vLimit;
    if (t.faultUntil > this.time && !t.dwelling) allowed = 0;
    if (t.hold) allowed = 0;
    else if (t.fault && t.faultUntil <= this.time) {
      t.fault = undefined;
      this.log(`${t.no}: Störung behoben, Zug fährt weiter`, "good");
    }
    for (const l of la.limits) allowed = Math.min(allowed, Math.sqrt(l.v * l.v + 2 * t.dec * l.d));
    if (t.zsLeft && t.zsLeft > 0 && t.zsCap) allowed = Math.min(allowed, t.zsCap / 3.6);
    if (la.stopDist < Infinity) {
      const sd = la.stopDist;
      let vs = sd > 2 ? Math.sqrt(2 * t.dec * (sd - 2)) : 0;
      if (sd > 3 && vs < 1.2) vs = 1.2;
      allowed = Math.min(allowed, vs);
    }
    if (t.v < allowed) t.v = Math.min(allowed, t.v + t.acc * dt);
    else t.v = Math.max(allowed, t.v - t.dec * 1.6 * dt);
    let s = t.v * dt;
    if (la.stopDist < Infinity) s = Math.min(s, Math.max(0, la.stopDist));
    if (s <= 0.001) {
      t.v = 0;
      t.standStill += dt;
      if (t.hold) this.cause(t, "Halt auf Anordnung des Fahrdienstleiters", dt);
      else if (t.faultUntil > this.time) this.cause(t, t.fault ?? "Störung am Zug", dt);
      else if (!la.platformStop && t.nextSig && t.distNextSig < 60) this.cause(t, `Halt vor Signal ${this.il.sig(t.nextSig).name}`, dt);
      if (!la.platformStop && t.nextSig && t.distNextSig < 60) {
        t.waitRed += dt;
        this.score.waitMinutes += dt / 60;
        if (Math.abs(t.waitRed - 180) < dt / 2) this.log(`${t.no} wartet seit 3 min vor ${this.il.sig(t.nextSig).name}`, "warn");
        if (t.standStill > 4) this.il.releaseOverlapForTrain(t.id);
      }
      if (la.platformStop && la.stopDist < 4) this.arrive(t, false);
      return;
    }
    t.standStill = 0;
    t.waitRed = 0;
    if (t.zsLeft) t.zsLeft = Math.max(0, t.zsLeft - s);
    this.move(t, s);
  }

  private move(t: Train, s: number) {
    const g = this.g;
    t.headPos += s;
    for (;;) {
      const head = this.headEdge(t);
      if (t.exiting || t.headPos <= head.len) break;
      const n = this.exitNode(t, head.id);
      const node = g.nodes[n];
      if (node.portal && g.portals[node.portal].outNode === n && (t.dir > 0 ? node.east : node.west).length === 0) {
        t.exiting = true;
        break;
      }
      const ne = nextEdge(g, n, t.dir);
      if (ne === undefined) {
        t.headPos = head.len;
        t.v = 0;
        break;
      }
      if (!trailingOk(g, n, head.id)) {
        // Weiche aufgefahren
        const side = node.swSide! > 0 ? node.east : node.west;
        node.swPos = side.indexOf(head.id);
        this.incident(`${t.no} hat Weiche ${node.swName} aufgefahren!`);
      }
      const sid = t.shunt ? 0 : t.dir > 0 ? node.sigE : node.sigW;
      if (sid) {
        const sg = this.il.sig(sid);
        if (!this.il.proceeds(sg, this.time)) {
          if (this.il.zs1.has(sid)) {
            this.il.zs1.delete(sid);
            t.sight = true;
          } else this.incident(`${t.no} hat ${sg.name} in Haltstellung überfahren!`);
        } else {
          t.sight = false; t.orderV = undefined;
          this.releaseOrderSw(t.id);
          const a = sg.kind === "main" ? this.il.aspect(sg, this.time) : undefined;
          if (a?.zs3) { t.zsCap = a.zs3 * 10; t.zsLeft = 300 + t.len; } else if (sg.kind === "main") t.zsLeft = 0;
        }
        this.il.passed(sg, t.id);
      }
      t.headPos -= head.len;
      t.body.push(ne);
      g.edges[ne].occ++;
      this.enteredEdge(t, ne);
    }
    // Zugschluss nachziehen
    for (;;) {
      if (t.body.length >= 2) {
        let covered = t.headPos;
        for (let i = 1; i < t.body.length - 1; i++) covered += g.edges[t.body[i]].len;
        if (covered < t.len) break;
        this.vacate(t.body.shift()!, t);
      } else {
        if (t.exiting && t.headPos - this.headEdge(t).len >= t.len) {
          this.vacate(t.body.shift()!, t);
          this.finish(t, true);
        }
        break;
      }
    }
  }

  private vacate(e: number, t?: Train) {
    const E = this.g.edges[e];
    if (t) this.lastOnEdge.set(e, { no: t.no, id: t.id, t: this.time });
    if (t && E.az === 2) this.azLeft(e, t);
    E.occ--;
    if (E.occ <= 0) {
      E.occ = 0;
      this.il.edgeCleared(e);
    }
  }

  private enteredEdge(t: Train, e: number) {
    if (this.g.edges[e].az === 2) { const sec = this.azSections.find((x) => x.edges.includes(e)); if (sec) sec.entered = t.no; }
    const st = this.g.edges[e].platform?.st;
    if (!st) return;
    // Wird ein späterer Halt erreicht, sind vorherige Halte ausgefallen
    const idx = t.stops.findIndex((s, i) => i > t.stopIdx && s.st === st);
    if (idx > 0) {
      for (let i = t.stopIdx; i < idx; i++) this.missStop(t, i);
      t.stopIdx = idx;
    }
  }

  private missStop(t: Train, i: number) {
    const s = t.stops[i];
    if (s.done) return;
    s.done = true;
    s.missed = true;
    this.score.missedStops++;
    this.score.points -= 50;
    this.log(`${t.no} hat den Halt ${this.g.stations[s.st].name} verpasst (falsches Gleis)`, "bad");
  }

  private incident(text: string) {
    this.score.incidents++;
    this.score.points -= 200;
    this.log(text, "bad");
  }

  // ---------------- Halt am Bahnsteig ----------------
  private arrive(t: Train, startHere: boolean) {
    const s = this.pendingStop(t);
    if (!s) return;
    t.v = 0;
    t.dwelling = true;
    s.actArr = startHere ? s.arr : this.time;
    s.track = this.headEdge(t).platform?.track ?? this.g.edges[t.body[t.body.length - 1]].platform?.track;
    const soll = s.disp ?? s.plan;
    if (!startHere && soll && s.track && s.track !== soll && t.cat !== "G" && this.manualAreas.has(s.st)) {
      this.score.trackChanges = (this.score.trackChanges ?? 0) + 1;
      this.log(`Gleisänderung: ${t.no} hält in ${this.g.stations[s.st].name} heute auf Gleis ${s.track} statt ${soll}`, "info");
    }
    if (!startHere) t.delay = Math.max(0, this.time - s.arr);
    const minDwell = t.cat === "ICE" ? 90 : t.cat === "G" ? 0 : 30;
    t.dwellUntil = Math.max(this.time + minDwell + (t.cat !== "G" && this.ext.f.weather ? this.ext.weather.dwell : 0), s.dep);
    // Fahrgastwechsel: in der Hauptverkehrszeit und an großen Bahnhöfen dauert er länger
    if (!startHere && t.cat !== "G" && t.stopIdx < t.stops.length - 1) {
      const pax = this.paxDwell(s.st);
      const before = t.dwellUntil;
      t.dwellUntil = Math.max(t.dwellUntil, this.time + minDwell + pax);
      if (t.dwellUntil > before) this.cause(t, "Fahrgastwechsel (viele Reisende)", t.dwellUntil - before);
    }
    if (!startHere && t.cat !== "G" && this.rand() < 0.02 * this.faultRate) {
      const extra = 120 + Math.floor(this.rand() * 300);
      t.dwellUntil += extra;
      t.fault = "Türstörung";
      t.faultUntil = t.dwellUntil;
      this.addFault("door", t.id, t.dwellUntil, `Türstörung an ${t.no} in ${this.g.stations[s.st].name}, ca. ${Math.round(extra / 60)} min`);
    }
    if (t.holdFor && t.holdFor.st === s.st && !startHere) {
      t.extraDwell = Math.max(t.extraDwell, t.holdFor.sec);
      t.holdFor = undefined;
    }
    if (t.medStop && t.medStop.st === s.st && !startHere) {
      if (t.medStop.rtwAt === undefined) {
        // Rettungsdienst noch nicht gerufen: Zug wartet am Bahnsteig
        t.dwellUntil = this.time + 1e7; t.fault = "Wartet auf den Rettungsdienst"; t.faultUntil = t.dwellUntil;
        this.log(`${t.no} steht in ${this.g.stations[s.st].name} und wartet auf den Rettungsdienst`, "warn");
      } else {
        t.dwellUntil = Math.max(t.dwellUntil, Math.max(this.time, t.medStop.rtwAt) + t.medStop.sec);
        t.fault = "Rettungsdienst im Zug"; t.faultUntil = t.dwellUntil;
        this.cause(t, "Rettungsdiensteinsatz", t.dwellUntil - this.time);
        this.log(`${t.no}: Rettungsdienst übernimmt in ${this.g.stations[s.st].name} den Fahrgast, Zug steht ca. ${Math.round((t.dwellUntil - this.time) / 60)} min`, "info");
        t.medStop = undefined;
      }
    }
    if (t.extraDwell > 0 && !startHere) {
      t.dwellUntil = Math.max(t.dwellUntil, s.dep + t.extraDwell);
      this.cause(t, "Anschluss abgewartet (Disposition)", Math.max(0, t.dwellUntil - Math.max(this.time + minDwell, s.dep)));
      t.extraDwell = 0;
    }
    if (!startHere && s.op === "trennen") { t.splitAt = this.time + 90; t.dwellUntil = Math.max(t.dwellUntil, this.time + 210); }
    if (!startHere && s.op === "kuppeln") this.requestCoupling(t, s.st);
    const isLast = t.stopIdx === t.stops.length - 1 && !t.trip.exitPortal;
    if (isLast) {
      if (t.trip.turnInto) t.reverseAt = t.trip.turnInto.dir === t.dir ? this.time + 20 : Math.max(this.time + 240, t.trip.turnInto.stops[0].dep - 120);
      else t.dissolveAt = this.time + (this.manualAreas.has(s.st) ? 600 : 180);
    }
  }

  private dwell(t: Train) {
    const s = this.pendingStop(t)!;
    const isLast = t.stopIdx === t.stops.length - 1 && !t.trip.exitPortal;
    if (isLast) {
      if (!s.done) {
        s.done = true;
        this.tripDone(t);
      }
      if (s.actArr !== undefined && this.time - s.actArr > 5) this.il.releaseOverlapForTrain(t.id);
      if (t.trip.turnInto && this.time >= t.reverseAt) this.reverse(t, t.trip.turnInto);
      else if (!t.trip.turnInto && (t.parked || t.bereit || t.rescue)) return;
      else if (!t.trip.turnInto && this.time >= t.dissolveAt) {
        if (this.parkAuto(t)) return;
        for (const e of t.body) this.vacate(e);
        t.body = [];
        this.il.releaseTrain(t.id);
        this.finish(t, false);
      }
      return;
    }
    // Durchrutschweg hinter dem Bahnsteig nach 30 s Stillstand auflösen, damit die Weichen dahinter frei werden
    if (s.actArr !== undefined && this.time - s.actArr > 5) this.il.releaseOverlapForTrain(t.id);
    if (this.time < t.dwellUntil || t.hold) return;
    if (t.waitBus && this.ops.busHolds(t)) return;
    if (t.waitFor && t.waitFor.st === s.st) {
      const o = this.trains.find((x) => x.id === t.waitFor!.train);
      const sS = this.g.stations[s.st].s ?? 0;
      const oStop = o?.stops.find((x) => x.st === s.st);
      // überholt ist erst, wenn der andere Zug dort abgefahren bzw. ohne Halt durch ist
      const passed = !o || (oStop ? oStop.done : (this.headS(o) - sS) * o.dir > 400);
      t.waitFor.since ??= this.time;
      if (!passed && this.time - t.waitFor.since < 1200) {
        this.cause(t, `Überholung durch ${o!.no}`, 0.5);
        return;
      }
      if (!passed) this.log(`${t.no}: Überholung in ${this.g.stations[s.st].name} abgebrochen (20 min gewartet)`, "warn");
      else this.log(`${t.no} wurde in ${this.g.stations[s.st].name} von ${o?.no ?? t.waitFor.no ?? "dem Zug"} überholt und fährt weiter`, "info");
      t.waitFor = undefined;
    }
    s.done = true;
    s.actDep = this.time;
    t.delay = Math.max(0, this.time - s.dep);
    t.stopIdx++;
    t.dwelling = false;
  }

  private tailPos(t: Train) {
    const g = this.g;
    const first = g.edges[t.body[0]];
    if (t.body.length === 1) return t.headPos - t.len;
    let rem = t.len - t.headPos;
    for (let i = 1; i < t.body.length - 1; i++) rem -= g.edges[t.body[i]].len;
    return first.len - rem;
  }

  private flip(t: Train, firstLen = this.g.edges[t.body[0]].len, tailPos = this.tailPos(t)) {
    this.il.releaseTrain(t.id);
    t.body.reverse();
    t.headPos = firstLen - Math.max(0, tailPos);
    t.dir = (t.dir * -1) as Dir;
  }

  // ---------------- Abstellung und Bereitstellung ----------------
  // Endende Züge fahren auf ein Nebengleis; Fahrten, die im Bereich beginnen, werden von dort an den Bahnsteig gebracht
  private stationOf(t: Train): string {
    const hs = this.headS(t);
    return Object.entries(this.g.stations).sort((a, b) => Math.abs((a[1].s ?? 0) - hs) - Math.abs((b[1].s ?? 0) - hs))[0][0];
  }
  private lastEdgeOf(x: ShuntTarget) { const l = x.rev?.edges ?? x.edges; return this.g.edges[l[l.length - 1]]; }
  private parkAuto(t: Train): boolean {
    if (this.canShunt(t)) return false;
    const tg = this.shuntTargets(t).filter((x) => { const E = this.lastEdgeOf(x); return !E.platform && E.len >= t.len + 15 && !this.routeEdges().has(E.id); })[0];
    if (!tg || this.startShunt(t, tg)) return false;
    t.radio.push({ t: this.time, from: "tf", text: `${t.no}: Ich rangiere zum Abstellen nach ${tg.label}.` });
    return true;
  }
  // Kanten, über die irgendeine Fahrstraße führt (dort darf nichts abgestellt werden)
  private routeEdgeSet?: Set<number>;
  routeEdges(): Set<number> {
    if (!this.routeEdgeSet) {
      this.routeEdgeSet = new Set();
      for (const ps of this.il.paths.values()) for (const p of ps) { for (const e of p.edges) this.routeEdgeSet.add(e); for (const e of this.il.overlapFor(p)) this.routeEdgeSet.add(e); }
    }
    return this.routeEdgeSet;
  }
  private depotTimer = 0;
  private depotTick() {
    const P = this.pending;
    for (const q of P) {
      if (q.entryPortal || q.turnedFrom || !q.stops.length) continue;
      const dep = q.stops[0].dep;
      if (dep - this.time > 1500) break;
      if (this.trains.some((t) => t.bereit === q.key)) continue;
      const st = q.stops[0].st;
      const t = this.trains.find((x) => x.parked && !x.bereit && !x.shunt && x.cat === q.cat && Math.abs(x.len - q.len) < 40 && this.stationOf(x) === st);
      if (!t) continue;
      t.bereit = q.key;
      this.log(`Bereitstellung: ${q.no} (ab ${String(Math.floor((dep % 86400) / 3600)).padStart(2, "0")}:${String(Math.floor(dep / 60) % 60).padStart(2, "0")}) kommt aus der Abstellung in ${this.g.stations[st].name}${this.manualAreas.has(st) ? ". Bitte rechtzeitig an den Bahnsteig rangieren (Rechtsklick auf den Zug)" : ""}`, "info");
    }
    for (const t of this.trains) {
      if (!t.bereit || t.shunt) continue;
      const q = P.find((x) => x.key === t.bereit);
      if (!q) { t.bereit = undefined; continue; }
      const st = q.stops[0].st, dep = q.stops[0].dep;
      if (this.time > dep + 1200) { t.bereit = undefined; continue; } // klappt nicht: Ersatzgarnitur aus dem Werk
      const pl = this.headEdge(t).platform;
      if (pl && pl.st === st && this.time >= dep - 900) { this.takeOver(t, q); continue; }
      // in Bereichen ohne Spieler (oder kurz vor Abfahrt) rangiert der Tf selbst
      if (this.time < dep - 600 || (this.manualAreas.has(st) && this.time < dep - 240)) continue;
      const want = this.planFor(q, st);
      const tg = this.shuntTargets(t).filter((x) => { const E = this.lastEdgeOf(x); return E.platform?.st === st && E.len >= t.len; })
        .sort((a, b) => Number(this.lastEdgeOf(b).platform!.track === want) - Number(this.lastEdgeOf(a).platform!.track === want))[0];
      if (tg && !this.startShunt(t, tg)) { t.parked = false; t.radio.push({ t: this.time, from: "tf", text: `${q.no}: Ich setze zur Bereitstellung nach ${tg.label} um.` }); }
    }
  }
  // Abgestellten Zug als neue Fahrt übernehmen (mit Bremsprobe)
  private takeOver(t: Train, q: TripSpec) {
    if (q.dir !== t.dir) this.flip(t);
    t.trip = q; t.no = q.no;
    t.stops = q.stops.map((s) => ({ ...s, done: false, plan: this.planFor(q, s.st) }));
    for (const st of t.stops) st.disp = this.dispTrack.get(`${q.key}|${st.st}`);
    t.stops[0].track = this.headEdge(t).platform?.track;
    t.stops[0].actArr = this.time;
    t.stopIdx = 0; t.dwelling = true; t.parked = false; t.bereit = undefined; t.shunted = false;
    t.dissolveAt = 0; t.reverseAt = 0; t.causes = {}; t.sev = undefined;
    const probe = q.cat === "G" ? 600 : 180;
    t.dwellUntil = Math.max(this.time + probe, q.stops[0].dep);
    t.delayIn = Math.max(0, t.dwellUntil - q.stops[0].dep); t.delay = t.delayIn;
    if (t.delayIn > 60) t.causes["Bereitstellung verspätet"] = t.delayIn;
    this.pending = this.pending.filter((x) => x !== q);
    this.ext.applyPerf(t);
    this.brakeTest(t, probe);
    this.log(`${q.no} steht in ${this.g.stations[q.stops[0].st].name} Gleis ${t.stops[0].track ?? "?"} bereit`, "info");
  }
  // Bremsprobe: voll bei Güterzügen, vereinfacht bei Triebzügen
  brakeTest(t: Train, sec: number) {
    t.radio.push({ t: this.time, from: "tf", text: `${t.no}: ${t.cat === "G" ? "Wagenprüfung und volle Bremsprobe laufen" : "Vereinfachte Bremsprobe läuft"}, dauert etwa ${Math.round(sec / 60)} Minuten.` });
    this.pendingRadio.push({ at: this.time + sec, train: t.id, text: `${t.no}: Bremsprobe in Ordnung, Zug ist abfahrbereit.` });
  }

  // ---------------- Kuppeln und Trennen (Verstärkung in der Hauptverkehrszeit) ----------------
  private planCoupling(trips: TripSpec[]) {
    const hAt = (t: TripSpec, st: string) => { const x = t.stops.find((s) => s.st === st); return x ? x.dep / 3600 : -1; };
    // morgens nach Köln: in Au (Sieg) zweite Einheit beistellen; abends aus Köln: in Au (Sieg) hintere Einheit abhängen
    const morning = trips.filter((t) => t.line === "RE9" && t.dir < 0 && hAt(t, "AU") >= 5.6 && hAt(t, "AU") < 8.2).slice(0, 2);
    const evening = trips.filter((t) => t.line === "RE9" && t.dir > 0 && hAt(t, "AU") >= 16 && hAt(t, "AU") < 19.5 && t.stops.findIndex((s) => s.st === "AU") < t.stops.length - 1).slice(0, 2);
    for (const t of morning) { const s = t.stops.find((x) => x.st === "AU")!; s.op = "kuppeln"; s.dep = Math.max(s.dep, s.arr + 240); }
    for (const t of evening) { const s = t.stops.find((x) => x.st === "AU")!; s.op = "trennen"; s.dep = Math.max(s.dep, s.arr + 180); t.len += 75; }
    this.couplingTrips = morning.map((t) => t.key);
  }
  private couplingTrips: number[] = [];
  private poolDone = false;
  // abgestellte Einheit (ohne eigene Fahrt), z. B. nach dem Abhängen oder als Verstärkung im Abstellgleis
  private unitTrip(base: TripSpec, st: string, len: number): TripSpec {
    return { ...base, key: this.ops.specialKey++, no: `Einheit ${base.line}`, len, special: "Einheit", entryPortal: undefined, exitPortal: undefined, turnInto: undefined, turnedFrom: undefined,
      initialDelay: 0, stops: [{ st, arr: this.time, dep: this.time }], from: this.g.stations[st].name, to: this.g.stations[st].name };
  }
  private initPool() {
    this.poolDone = true;
    let k = 0;
    // alle Einheiten hintereinander in ein Stumpfgleis (Ende ohne Anschluss), damit keine der anderen den Weg versperrt
    const g = this.g;
    const stubEnd = (E: typeof g.edges[number]) => [E.a, E.b].some((n) => g.nodes[n].east.length + g.nodes[n].west.length === 1);
    for (const key of this.couplingTrips) {
      const q = this.pending.find((x) => x.key === key);
      if (!q) continue;
      const sid = g.edges.find((E) => !E.platform && !E.lock && stubEnd(E) && E.len >= 80 + k * 90 && !this.routeEdges().has(E.id) && Math.abs(((g.nodes[E.a].s ?? 0) + (g.nodes[E.b].s ?? 0)) / 2 - (g.stations.AU.s ?? 0)) < 900)
        ?? g.edges.find((E) => !E.platform && !E.occ && !E.lock && E.len >= 80 && !this.routeEdges().has(E.id) && Math.abs(((g.nodes[E.a].s ?? 0) + (g.nodes[E.b].s ?? 0)) / 2 - (g.stations.AU.s ?? 0)) < 900);
      if (!sid) continue;
      const u = this.newTrain(this.unitTrip(q, "AU", 75), [sid.id], sid.len - 10 - (sid.occ ? 0 : 0) - k++ * 90);
      u.dwelling = true; u.stops[0].done = true; u.parked = true; u.dissolveAt = 1e12;
    }
  }
  private requestCoupling(t: Train, st: string) {
    const us = this.trains.filter((x) => x.parked && !x.bereit && !x.couple && !x.shunt && x.trip.special === "Einheit" && x.cat === t.cat && this.stationOf(x) === st);
    const u = us.find((x) => this.coupleTarget(x, t)) ?? us[0];
    if (!u) { this.log(`${t.no}: Keine Verstärkungseinheit in ${this.g.stations[st].name}, Zug fährt kurz`, "warn"); return; }
    u.couple = t.id;
    t.waitCouple = { unit: u.id, until: this.time + 600 };
    t.dwellUntil = Math.max(t.dwellUntil, this.time + 240);
    t.radio.push({ t: this.time, from: "tf", text: `${t.no}: Stehe in ${this.g.stations[st].name}, warte auf die Verstärkung zum Kuppeln.` });
  }
  // Ziel für die Kuppelfahrt: Weg bis an den Zug heran
  private coupleTarget(u: Train, o: Train, maxLen = 1500): ShuntTarget | undefined {
    const g = this.g;
    const ok = (e: number, used: Set<number>) => !used.has(e) && !u.body.includes(e) && !g.edges[e].occ && !g.edges[e].lock && !g.edges[e].closed;
    // vom Knoten n in Richtung d bis an den Zug o (Breitensuche, höchstens 1,5 km)
    const reach = (n0: number, d: Dir, used: Set<number>, first?: number): number[] | undefined => {
      const queue: { n: number; path: number[]; len: number }[] = [{ n: n0, path: [], len: 0 }];
      const seen = new Set<number>([n0]);
      while (queue.length) {
        const c = queue.shift()!;
        if (c.len > maxLen || c.path.length > 20 + maxLen / 150) continue;
        const node = g.nodes[c.n];
        for (const e of d > 0 ? node.east : node.west) {
          if (!c.path.length && first !== undefined && e === first) continue;
          if (o.body.includes(e)) return [...c.path, e];
          if (!ok(e, used) || c.path.includes(e)) continue;
          const nn = d > 0 ? g.edges[e].b : g.edges[e].a;
          if (maxLen > 1500 && seen.has(nn)) continue;
          seen.add(nn);
          queue.push({ n: d > 0 ? g.edges[e].b : g.edges[e].a, path: [...c.path, e], len: c.len + g.edges[e].len });
        }
      }
      return undefined;
    };
    for (const d of [u.dir, (u.dir * -1) as Dir]) {
      const E0 = g.edges[d === u.dir ? u.body[u.body.length - 1] : u.body[0]];
      const start = d > 0 ? E0.b : E0.a;
      const direct = reach(start, d, new Set());
      if (direct) return { label: `an ${o.no}`, dir: d, edges: direct };
      // mit Sägefahrt: über eine Weiche hinaus vorziehen, dann auf dem anderen Ast zurück
      const fwd: { n: number; path: number[]; len: number; sw: { node: number; idx: number; dist: number; came: number }[] }[] = [{ n: start, path: [], len: 0, sw: [] }];
      const fseen = new Set<number>([start]);
      while (fwd.length) {
        const c = fwd.shift()!;
        if (c.len > maxLen || c.path.length > 25 + maxLen / 150) continue;
        const node = g.nodes[c.n];
        const back = d > 0 ? node.west : node.east;
        const sw = back.length === 2 && c.path.length ? [...c.sw, { node: c.n, idx: c.path.length, dist: c.len, came: c.path[c.path.length - 1] }] : c.sw;
        for (const x of sw) {
          if (c.len - x.dist < u.len + 25) continue;
          const other = (d > 0 ? g.nodes[x.node].west : g.nodes[x.node].east).find((e) => e !== x.came);
          if (other === undefined) continue;
          const backPath = reach(x.node, (d * -1) as Dir, new Set(c.path), x.came);
          if (backPath) return { label: `an ${o.no}`, dir: d, edges: c.path, rev: { node: x.node, after: c.path.slice(x.idx), edges: backPath } };
        }
        for (const e of d > 0 ? node.east : node.west) {
          if (!ok(e, new Set(c.path))) continue;
          const nn = d > 0 ? g.edges[e].b : g.edges[e].a;
          if (maxLen > 1500 && fseen.has(nn)) continue;
          fseen.add(nn);
          fwd.push({ n: d > 0 ? g.edges[e].b : g.edges[e].a, path: [...c.path, e], len: c.len + g.edges[e].len, sw });
        }
      }
    }
    return undefined;
  }
  private couplingTick() {
    if (!this.poolDone) this.initPool();
    for (const t of this.trains) {
      if (t.splitAt && this.time >= t.splitAt) { t.splitAt = undefined; this.splitRear(t, 75); }
      if (t.waitCouple && this.time > t.waitCouple.until) {
        const u = this.trains.find((x) => x.id === t.waitCouple!.unit);
        if (u) { u.couple = undefined; if (u.shunt) u.shunt = { edges: [u.body[u.body.length - 1]], label: "Abbruch" }; }
        t.waitCouple = undefined;
        this.log(`${t.no}: Kuppeln in ${this.g.stations[this.stationOf(t)].name} hat nicht geklappt, Zug fährt kurz`, "warn");
      } else if (t.waitCouple) t.dwellUntil = Math.max(t.dwellUntil, this.time + 60);
      if (t.couple && !t.shunt) {
        const o = this.trains.find((x) => x.id === t.couple);
        if (!o || !o.dwelling) continue;
        const tg = this.coupleTarget(t, o);
        if (!tg) continue;
        if (tg.dir !== t.dir) this.flip(t);
        const err = this.setShuntSwitches(t, tg.edges);
        if (err) { if (tg.dir !== t.dir) this.flip(t); continue; }
        for (const e of [...tg.edges, ...(tg.rev?.edges ?? [])]) if (!o.body.includes(e)) this.g.edges[e].lock = -t.id;
        t.shunt = { edges: [t.body[t.body.length - 1], ...tg.edges], label: tg.label, rev: tg.rev };
        t.dwelling = false; t.parked = false;
        t.radio.push({ t: this.time, from: "tf", text: `Einheit fährt zum Kuppeln an ${o.no}.` });
      }
    }
  }
  private doCouple(u: Train, o: Train) {
    const g = this.g;
    u.v = 0;
    for (const e of g.edges) if (e.lock === -u.id) e.lock = 0;
    let body: number[];
    if (u.dir === o.dir) {
      body = [...u.body, ...o.body.filter((e, i) => !(i === 0 && u.body[u.body.length - 1] === e))];
    } else {
      const rev = [...u.body].reverse();
      body = [...o.body, ...rev.filter((e, i) => !(i === 0 && o.body[o.body.length - 1] === e))];
      const tail = this.tailPos(u);
      o.headPos = g.edges[rev[rev.length - 1]].len - Math.max(0, tail);
    }
    for (const e of u.body) g.edges[e].occ--;
    for (const e of new Set(body)) if (!o.body.includes(e)) g.edges[e].occ++;
    o.body = body;
    o.len += u.len;
    u.body = []; u.gone = true; u.shunt = undefined;
    this.il.releaseTrain(u.id);
    o.waitCouple = undefined;
    if (u.rescue) { this.rescueCoupled(u, o); return; }
    o.dwellUntil = Math.max(o.dwellUntil, this.time + 120);
    this.brakeTest(o, 120);
    this.log(`${o.no}: Verstärkung in ${this.g.stations[this.stationOf(o)].name} gekuppelt, Zug fährt jetzt mit ${Math.round(o.len)} m`, "info");
  }
  // hintere Einheit abhängen: bleibt am Bahnsteig stehen und wird danach abgestellt
  private splitRear(t: Train, len: number) {
    const g = this.g;
    if (t.len - len < 40) return;
    let pos = this.tailPos(t) + len; // Spitze der abgehängten Einheit, gemessen ab der Einfahrseite der Schlusskante
    const ub: number[] = [];
    let i = 0;
    while (i < t.body.length) {
      const E = g.edges[t.body[i]];
      ub.push(t.body[i]);
      if (pos <= E.len) break;
      pos -= E.len;
      i++;
    }
    const st = this.stationOf(t);
    for (const e of ub) g.edges[e].occ++; // newTrain zählt auch, deshalb hier vorher abziehen
    for (const e of ub) g.edges[e].occ--;
    const unit = this.newTrain(this.unitTrip(t.trip, st, len), ub, pos - 1);
    unit.dwelling = true; unit.stops[0].done = true; unit.dissolveAt = this.time + 300;
    // vorderer Teil: Kanten, die nur noch die Einheit belegt, abgeben
    const keepFrom = i;
    for (let k = 0; k < keepFrom; k++) g.edges[t.body[k]].occ--;
    t.body = t.body.slice(keepFrom);
    t.len -= len;
    this.brakeTest(t, 90);
    this.log(`${t.no}: hintere Einheit in ${this.g.stations[st].name} abgehängt, sie wird abgestellt`, "info");
  }

  // Verwaiste Fahrstraßen auflösen: kein Zug fährt mehr darauf zu (z. B. nach Wenden, Ausfall oder Abstellen)
  // Verklemmung in einem Bereich, den der Spieler nicht stellt: Die Netzleitstelle nimmt den am längsten wartenden Zug
  // heraus (Teilausfall), damit der Betrieb weiterläuft. Bereiche des Spielers bleiben unangetastet.
  private jamCool = 0;
  private jamResolver() {
    if (this.time < this.jamCool) return;
    const ok = (t: Train) => !t.gone && t.body.length && t.nextSig && !t.fault && !t.rescue && !t.towed && !t.shunt && !this.rescues.some((R) => R.broken === t.id);
    const near = (t: Train) => { const hs = this.headS(t); let st = "TR", bd = Infinity; for (const c of ["TR", "SB", "HN", "BL", "EI", "AU", "WI", "BZ"]) { const d = Math.abs(this.stS(c) - hs); if (d < bd) { bd = d; st = c; } } return st; };
    // Im Bereich des Spielers: nach einer Stunde Stillstand fragt die Netzleitstelle, ob sie den Zug herausnehmen soll
    const mine = this.trains.filter((t) => ok(t) && t.waitRed > 3600 && !this.il.sig(t.nextSig).auto && this.manualSt(near(t)) && this.time >= (this.jamAsk.get(t.id) ?? 0));
    if (mine.length && !this.ops.calls.some((c) => c.kind === "verklemmt" && !c.answered && this.time < c.expires)) {
      mine.sort((a, b) => b.waitRed - a.waitRed);
      const t = mine[0];
      this.jamAsk.set(t.id, this.time + 1800);
      this.ops.call("Netzleitstelle", "verklemmt", `${t.no} steht seit ${Math.round(t.waitRed / 60)} Minuten vor ${this.il.sig(t.nextSig).name}. Kommt der noch weg, oder sollen wir ihn aus dem Bereich nehmen (Teilausfall, Zug wird abgestellt)?`,
        [{ k: "nein", label: "Ich löse das selbst" }, { k: "raus", label: "Ja, Zug herausnehmen (−10 Punkte)" }], 600, { train: t.id });
      this.jamCool = this.time + 300;
      return;
    }
    const cand = this.trains.filter((t) => ok(t) && t.waitRed > 2400 && this.il.sig(t.nextSig).auto && !this.manualSt(near(t)));
    if (!cand.length) return;
    cand.sort((a, b) => b.waitRed - a.waitRed);
    this.takeOut(cand[0]);
  }
  private jamAsk = new Map<number, number>();
  // Wendezüge und bereitgestellte Züge im Bereich des Spielers melden sich per Funk abfahrbereit
  notices: { id: number; t: number; text: string; train: number }[] = [];
  private noticeId = 1;
  private readySaid = new Set<number>();
  private readyCalls() {
    for (const t of this.trains) {
      if (!t.dwelling || t.stopIdx !== 0 || t.shunt || t.parked || (t.fault && this.time < t.faultUntil)) continue;
      if (t.trip.entryPortal && !t.trip.turnedFrom) continue;
      if (this.readySaid.has(t.trip.key)) continue;
      const s = t.stops[0], pl = t.body.length ? this.headEdge(t).platform : undefined;
      if (!s || !pl || pl.st !== s.st || !this.manualSt(s.st)) continue;
      if (this.time < t.dwellUntil - 90) continue;
      this.readySaid.add(t.trip.key);
      if (t.nextSig && this.il.proceeds(this.il.sig(t.nextSig), this.time)) continue;
      const sg = t.nextSig ? this.il.sig(t.nextSig).name : "";
      const text = `${t.no} in ${this.g.stations[s.st].name} Gleis ${pl.track}: Türen sind zu, Zug ist abfahrbereit nach ${t.trip.to} (ab ${clock(Math.max(s.dep, this.time))}).${sg ? ` Bitte Ausfahrt ${sg}.` : ""}`;
      t.radio.push({ t: this.time, from: "tf", text });
      this.notices.push({ id: this.noticeId++, t: this.time, text, train: t.id });
      if (this.notices.length > 30) this.notices.shift();
      this.log(`📻 ${text}`, "warn");
    }
  }
  takeOut(t: Train) {
    for (const e of t.body) this.vacate(e);
    t.body = [];
    this.il.releaseTrain(t.id);
    this.umlaufCancel(t.trip, "Teilausfall wegen Verklemmung");
    for (let i = t.stopIdx; i < t.stops.length; i++) if (!t.stops[i].done) { t.stops[i].done = true; t.stops[i].missed = true; }
    t.gone = true;
    this.trains = this.trains.filter((x) => x !== t);
    this.log(`Netzleitstelle: ${t.no} wird wegen Verklemmung bei ${this.il.sig(t.nextSig).name} aus dem Bereich genommen (Teilausfall)`, "warn");
    this.jamCool = this.time + 600;
  }
  private orphanSince = new Map<number, number>();
  private routeJanitor() {
    for (const r of [...this.il.routes.values()]) {
      let orphan = false;
      if (r.used) orphan = r.train !== undefined && !this.trains.some((t) => t.id === r.train);
      else if (this.il.sig(r.path.sig).auto) orphan = !this.trains.some((t) => t.nextSig === r.path.sig || (t.body.length && this.g.edges[t.body[t.body.length - 1]].lock === r.id));
      else {
        // vom Spieler gestellt: nur zurücknehmen, wenn weit und breit kein Zug darauf zufährt (z. B. Zug ist schon weg oder endet)
        const sg = this.il.sig(r.path.sig), sS = this.g.nodes[sg.node].s ?? 0;
        orphan = !this.trains.some((t) => t.nextSig === r.path.sig || (t.dir === sg.dir && t.body.length && (sS - this.headS(t)) * sg.dir > -30 && (sS - this.headS(t)) * sg.dir < 8000));
      }
      if (!orphan) { this.orphanSince.delete(r.id); continue; }
      const since = this.orphanSince.get(r.id) ?? this.time;
      this.orphanSince.set(r.id, since);
      if (this.time - since < (r.used || this.il.sig(r.path.sig).auto ? 180 : 300)) continue;
      this.orphanSince.delete(r.id);
      if (!r.used) {
        if (!this.il.sig(r.path.sig).auto) this.log(`Fahrstraße ${this.il.sig(r.path.sig).name} → ${r.path.endSig ? this.il.sig(r.path.endSig).name : r.path.endPortal} zurückgenommen: seit 5 min kommt kein Zug`, "info");
        this.il.cancel(r.path.sig); continue;
      }
      for (const e of r.path.edges) if (this.g.edges[e].lock === r.id && !this.g.edges[e].occ) this.g.edges[e].lock = 0;
      this.il.releaseOverlap(r);
      this.il.routes.delete(r.id);
      const s = this.il.sig(r.path.sig);
      if (s.route === r.id) s.route = 0;
    }
  }

  // ---------------- Liegengebliebener Zug und Hilfslok ----------------
  // Ein Triebfahrzeug fällt auf der freien Strecke endgültig aus. Die Hilfslok (Diesel der Notfalltechnik) kommt
  // aus Köln-Gremberg oder Siegen als Lokzug bis zum nächsten Bahnhof vor dem Zug, fährt von dort als Sperrfahrt
  // ins gesperrte Gleis, kuppelt vorne an und zieht den Zug bis zu diesem Bahnhof, wo er endet.
  rescues: { broken: number; no: string; st: string; phase: number; at: number; lzKey?: number; tries: number; start?: number }[] = [];
  breakdown(): string | null {
    const g = this.g, r = this.rand;
    if (this.rescues.length) return "es läuft schon ein Hilfseinsatz";
    const plain = (e: number) => { const E = g.edges[e]; return !E.platform && [4, 5].includes(g.nodes[E.a].y) && g.nodes[E.a].y === g.nodes[E.b].y && g.nodes[E.a].swSide === undefined && g.nodes[E.b].swSide === undefined; };
    const cand = this.trains.filter((t) => t.cat !== "G" && t.v > 8 && !t.exiting && !t.fault && !t.shunt && !t.trip.special && t.body.every(plain)
      && !g.nodes.some((n) => n.swSide !== undefined && n.s !== undefined && (n.s - this.headS(t)) * t.dir > -50 && (n.s - this.headS(t)) * t.dir < 400));
    for (let k = 0; k < 6 && cand.length; k++) {
      const t = cand.splice(Math.floor(r() * cand.length), 1)[0];
      const hs = this.headS(t);
      if (hs < 12500 || hs > 68300) continue;
      const st = this.rescueStation(t);
      if (!st) continue;
      const what = ["Hauptschalter fällt immer wieder, Triebfahrzeug lässt sich nicht mehr aufrüsten", "Kompressor ausgefallen, Bremsen lassen sich nicht mehr lösen", "Antrieb ausgefallen, Fahrzeugsteuerung meldet schweren Fehler"][Math.floor(r() * 3)];
      t.fault = `Zug liegt fest: ${what}`;
      t.faultUntil = 1e12;
      t.radio.push({ t: this.time, from: "tf", text: `${t.no}: Mein Zug ist liegengeblieben bei km ${(hs / 1000).toFixed(1).replace(".", ",")}. ${what}. Ich versuche die Störung zu beheben.` });
      this.rescues.push({ broken: t.id, no: t.no, st, phase: 0, at: this.time + 480 + r() * 240, tries: 0, start: this.time });
      this.addFault("vehicle", t.id, 1e12, `${t.no} liegt bei km ${(hs / 1000).toFixed(1).replace(".", ",")} fest (${what})`);
      this.log(`${t.no} ist bei km ${(hs / 1000).toFixed(1).replace(".", ",")} liegengeblieben: ${what}. Tf versucht die Störung zu beheben`, "bad");
      this.note("Störung", `${t.no} liegt bei km ${(hs / 1000).toFixed(1).replace(".", ",")} fest: ${what}`);
      return null;
    }
    return "kein passender Zug auf der freien Strecke";
  }
  // nächster Bahnhof (mit Weichen) vor dem Zug: dorthin kommt die Hilfslok, dort endet der Zug
  private rescueStation(t: Train): string | undefined {
    const g = this.g, hs = this.headS(t);
    // nur Bahnhöfe, die der Zug ohnehin anfährt (gleiche Strecke), mit Weichen für die Sperrfahrt
    const st = t.stops.find((s, i) => i >= t.stopIdx && !s.done && (this.stS(s.st) - hs) * t.dir > 800 && (this.stS(s.st) - hs) * t.dir < 12000
      && g.nodes.some((n) => n.swSide !== undefined && Math.abs((n.s ?? -1e9) - this.stS(s.st)) < 700));
    return st?.st;
  }
  private rescueTrip(R: { broken: number; st: string }): TripSpec | undefined {
    const o = this.trains.find((x) => x.id === R.broken);
    if (!o) return undefined;
    const portal = o.dir > 0 ? "E_BZ" : "W_M";
    const tpl = [...this.pending, ...this.trains.map((x) => x.trip)].find((q) => q.entryPortal === portal && q.cat === "G")
      ?? [...this.pending, ...this.trains.map((x) => x.trip)].find((q) => q.entryPortal === portal);
    if (!tpl) return undefined;
    const at = this.time + 1200 + this.rand() * 900;
    const run = Math.abs((this.g.nodes[this.g.portals[portal].outNode].s ?? 0) - this.stS(R.st)) / 15;
    return { ...tpl, key: this.ops.specialKey++, no: `Lz ${71000 + Math.floor(this.rand() * 900)}`, cat: "G", len: 20, vmax: 100, mass: 85, line: "", initialDelay: 0,
      entryPortal: portal, exitPortal: undefined, entryTime: at, turnInto: undefined, turnedFrom: undefined, special: "Hilfslok",
      stops: [{ st: R.st, arr: at + run, dep: at + run + 60 } as any], from: portal === "E_BZ" ? "Siegen (Notfalltechnik)" : "Köln-Gremberg (Notfalltechnik)", to: this.g.stations[R.st].name };
  }
  // Antwort auf die Frage, wie es weitergeht (aus Ops)
  rescueRequest(id: number, retry: boolean, tech = false) {
    const R = this.rescues.find((x) => x.broken === id);
    const o = this.trains.find((x) => x.id === id);
    if (!R || !o) return;
    if (retry && R.tries < 1) {
      R.tries++;
      if (this.rand() < 0.35) {
        o.fault = "Notdürftig repariert, fährt langsam bis zum nächsten Bahnhof";
        o.faultUntil = this.time + 60; o.towed = true;
        this.rescueEndAt(o, R.st);
        this.faults = this.faults.filter((f) => !(f.kind === "vehicle" && f.target === o.id));
        o.radio.push({ t: this.time, from: "tf", text: `${o.no}: Ich habe ihn wieder aufgerüstet, fahre aber nur noch langsam bis ${this.g.stations[R.st].name}. Dort ist Schluss.` });
        this.log(`${o.no}: Störung notdürftig behoben, Zug fährt langsam bis ${this.g.stations[R.st].name} und endet dort`, "info");
        this.rescues = this.rescues.filter((x) => x !== R);
        return;
      }
      R.phase = 0; R.at = this.time + 600;
      o.radio.push({ t: this.time, from: "tf", text: `${o.no}: Verstanden, ich probiere es noch einmal mit Zurücksetzen der Fahrzeugsteuerung.` });
      return;
    }
    if (tech) {
      R.phase = 5; R.at = this.time + 1800 + this.rand() * 1200;
      o.radio.push({ t: this.time, from: "tf", text: `${o.no}: Verstanden, ich warte auf den Techniker.` });
      this.log(`Techniker ist unterwegs zu ${o.no}, voraussichtlich vor Ort und fertig in ca. ${Math.round((R.at - this.time) / 60)} min`, "info");
      return;
    }
    const q = this.rescueTrip(R);
    if (!q) { R.phase = 0; R.at = this.time + 300; return; }
    R.lzKey = q.key; R.phase = 2;
    this.pending.push(q);
    this.pending.sort((a, b) => a.entryTime + a.initialDelay - (b.entryTime + b.initialDelay));
    const P = this.g.portals[q.entryPortal!];
    this.log(`Notfallmanager: Hilfslok ${q.no} (Diesellok der Notfalltechnik) kommt aus ${P.label}, Einbruch ca. ${clock(q.entryTime)}. Sie fährt bis ${this.g.stations[R.st].name} und von dort als Sperrfahrt an ${o.no}`, "warn");
    this.note("Hilfslok", `Hilfslok ${q.no} für ${o.no} angefordert, kommt aus ${P.label} (Einbruch ca. ${clock(q.entryTime)}), Übergabe in ${this.g.stations[R.st].name}`);
    o.radio.push({ t: this.time, from: "fdl", text: `${o.no}, die Hilfslok ist angefordert und kommt von vorne. Bitte Zug gegen Wegrollen sichern und auf die Hilfslok warten.` });
  }
  // Fdl gibt die Sperrfahrt frei (aus Ops oder automatisch)
  rescueGo(id: number): string | null {
    const R = this.rescues.find((x) => x.broken === id);
    const o = this.trains.find((x) => x.id === id);
    const u = R && this.trains.find((x) => x.trip.key === R.lzKey);
    if (!R || !o || !u) return "Hilfslok ist nicht da";
    const tg = this.coupleTarget(u, o, 9500);
    if (!tg) { R.phase = 3; R.at = this.time + 60; R.tries++; return "Fahrweg zum Zug ist noch nicht frei"; }
    if (tg.dir !== u.dir) this.flip(u);
    const err = this.setShuntSwitches(u, tg.edges);
    if (err) { if (tg.dir !== u.dir) this.flip(u); R.phase = 3; R.at = this.time + 60; R.tries++; return err; }
    for (const e of [...tg.edges, ...(tg.rev?.edges ?? [])]) if (!o.body.includes(e)) this.g.edges[e].lock = -u.id;
    u.couple = o.id;
    u.shunt = { edges: [u.body[u.body.length - 1], ...tg.edges], label: `Sperrfahrt an ${o.no}`, rev: tg.rev };
    u.dwelling = false; u.parked = false;
    R.phase = 6;
    u.radio.push({ t: this.time, from: "fdl", text: `${u.no}, Befehl: Sie fahren als Sperrfahrt in das gesperrte Gleis bis an ${o.no}, auf Sicht, höchstens 40 km/h, zuletzt Schrittgeschwindigkeit.` });
    u.radio.push({ t: this.time, from: "tf", text: `${u.no}: Befehl verstanden, fahre als Sperrfahrt an ${o.no}.` });
    this.note("Befehl", `Sperrfahrt ${u.no} in das gesperrte Gleis bis an ${o.no}`);
    this.log(`Sperrfahrt ${u.no} fährt an ${o.no}`, "info");
    return null;
  }
  private rescueCoupled(u: Train, o: Train) {
    this.rescues = this.rescues.filter((x) => x.broken !== o.id);
    const R = { st: u.stops[0]?.st ?? this.stationOf(u) };
    o.fault = undefined; o.faultUntil = 0; o.towed = true; o.hold = false; o.sight = true; o.orderV = 40;
    this.faults = this.faults.filter((f) => !(f.kind === "vehicle" && f.target === o.id));
    this.rescueEndAt(o, R.st);
    o.dwelling = false;
    o.faultUntil = this.time + 300; o.fault = "Hilfslok gekuppelt, Bremsprobe";
    this.brakeTest(o, 300);
    this.log(`${o.no}: Hilfslok ${u.no} ist gekuppelt. Nach der Bremsprobe wird der Zug nach ${this.g.stations[R.st].name} gezogen und endet dort`, "good");
    this.note("Hilfslok", `${u.no} an ${o.no} gekuppelt, Zug wird nach ${this.g.stations[R.st].name} geschleppt`);
  }
  // Zug endet am Bahnhof st (Teilausfall), höchstens 60 km/h
  private rescueEndAt(o: Train, st: string) {
    let i = o.stops.findIndex((s, k) => k >= o.stopIdx && s.st === st && !s.done);
    const eta = this.time + 600;
    if (i < 0) {
      i = o.stops.findIndex((s, k) => k >= o.stopIdx && !s.done && (this.stS(s.st) - this.stS(st)) * o.dir > 0);
      const ns = { st, arr: eta, dep: eta, done: false, plan: this.planTrack(st, o.dir, o.trip.line, this.g.stations[st].name) } as any;
      if (i < 0) o.stops.push(ns); else o.stops.splice(i, 0, ns);
      i = o.stops.indexOf(ns);
    }
    const lost = o.stops.slice(i + 1).filter((s) => !s.done).length;
    o.stops = o.stops.slice(0, i + 1);
    o.trip = { ...o.trip, key: this.ops.specialKey++, exitPortal: undefined, turnInto: undefined, to: this.g.stations[st].name, stops: o.trip.stops.filter((s) => o.stops.some((x) => x.st === s.st)) };
    o.vmax = Math.min(o.vmax, 60 / 3.6);
    o.sev = `Zug endet in ${this.g.stations[st].name}${lost ? `, weiter mit dem nächsten Zug` : ""}`;
    this.cause(o, "Liegengebliebener Zug (Hilfslok)", 1);
  }
  private rescueTick() {
    for (const R of [...this.rescues]) {
      const o = this.trains.find((x) => x.id === R.broken);
      const u = R.lzKey ? this.trains.find((x) => x.trip.key === R.lzKey) : undefined;
      if (!o) {
        this.rescues = this.rescues.filter((x) => x !== R);
        if (u) { u.rescue = undefined; u.dissolveAt = this.time; }
        continue;
      }
      if (R.phase === 0 && this.time >= R.at) {
        R.phase = 1;
        o.radio.push({ t: this.time, from: "tf", text: `${o.no}: Die Störung lässt sich nicht beheben, der Zug kommt aus eigener Kraft nicht mehr weg.` });
        this.ops.call(`Tf ${o.no}`, "liegen", `${o.no} kommt aus eigener Kraft nicht mehr weg. Ich brauche Hilfe: eine Hilfslok, die von vorne kommt und mich bis ${this.g.stations[R.st].name} zieht, oder einen Techniker. Das müssten Sie beim Notfallmanager anfordern. Oder ich versuche es noch ein letztes Mal.`,
          [{ k: "hilfe", label: "Ich rufe den Notfallmanager" }, { k: "nochmal", label: "Noch einmal versuchen (10 min)" }], 240, { train: o.id });
      }
      if (u && !u.rescue) u.rescue = o.id;
      // Techniker vor Ort, oder die Hilfslok kommt nicht durch: nach spätestens 100 min repariert der Techniker den Zug notdürftig
      const late = R.phase >= 2 && R.phase !== 5 && this.time - (R.start ?? R.at) > (R.phase === 6 ? 7800 : 6000);
      if ((R.phase === 5 && this.time >= R.at) || late) {
        this.rescues = this.rescues.filter((x) => x !== R);
        if (u) { u.rescue = undefined; if (u.shunt || u.dwelling) u.dissolveAt = this.time + 60; }
        o.fault = "Notdürftig repariert, fährt langsam bis zum nächsten Bahnhof";
        o.faultUntil = this.time + 60; o.towed = true;
        this.rescueEndAt(o, R.st);
        this.faults = this.faults.filter((f) => !(f.kind === "vehicle" && f.target === o.id));
        o.radio.push({ t: this.time, from: "tf", text: `${o.no}: Der Techniker hat den Zug notdürftig wieder fahrbereit gemacht. Ich fahre langsam bis ${this.g.stations[R.st].name}, dort ist Schluss.` });
        this.log(`${o.no}: ${late ? "Hilfslok kommt nicht durch, " : ""}Techniker hat den Zug notdürftig repariert, er fährt langsam bis ${this.g.stations[R.st].name} und endet dort`, "info");
        continue;
      }
      if ((R.phase === 2 || R.phase === 3) && !u && R.lzKey && !this.pending.some((q) => q.key === R.lzKey)) { R.lzKey = undefined; this.rescueRequest(o.id, false); continue; }
      if ((R.phase === 2 || R.phase === 3) && u && u.dwelling && this.headEdge(u).platform?.st === R.st && this.time >= R.at) {
        if (this.manualSt(R.st) && R.phase === 2) {
          R.phase = 4;
          this.ops.call(`Hilfslok ${u.no}`, "hilfslok", `Hilfslok ${u.no} steht in ${this.g.stations[R.st].name}. Erbitte Befehl für die Sperrfahrt in das gesperrte Gleis bis an ${o.no}.`,
            [{ k: "ok", label: "Befehl erteilen (Sperrfahrt)" }, { k: "warten", label: "Noch warten" }], 300, { train: o.id });
        } else {
          const why = this.rescueGo(o.id);
          if (why && R.tries > 20) { // geht gar nicht: Zug wird später vom Notfallmanager aus dem Weg geräumt
            this.log(`Hilfslok ${u.no}: ${why}. Notfallmanager lässt ${o.no} langsam bis ${this.g.stations[R.st].name} fahren`, "warn");
            this.rescues = this.rescues.filter((x) => x !== R);
            u.rescue = undefined; u.dissolveAt = this.time + 60;
            o.fault = "Notbetrieb"; o.faultUntil = this.time + 120; this.rescueEndAt(o, R.st);
          }
        }
      }
    }
  }

  // ---------------- Rangieren ----------------
  canShunt(t: Train): string | null {
    if (t.shunt) return "Rangierfahrt läuft bereits";
    if (t.v > 0.1) return "Zug muss stehen";
    if (t.trip.turnInto) return "Zug wendet planmäßig und bleibt am Bahnsteig";
    const last = t.stopIdx === t.stops.length - 1 && !t.trip.exitPortal && t.dwelling;
    if (!last && t.cat !== "G") return "Nur Züge, die hier enden, können rangiert werden";
    if (t.cat === "G" && !t.dwelling && t.waitRed < 30 && !last) return "Güterzug muss vor einem Signal stehen";
    return null;
  }

  shuntTargets(t: Train): ShuntTarget[] {
    const g = this.g, out: (ShuntTarget & { len: number })[] = [];
    const own = new Set(t.body);
    // nur innerhalb des Bahnhofs, in dem der Zug steht
    const hs = this.headS(t);
    const st0 = Object.entries(g.stations).sort((a, b) => Math.abs((a[1].s ?? 0) - hs) - Math.abs((b[1].s ?? 0) - hs))[0];
    const s0 = st0[1].s ?? 0;
    const inArea = (e: number) => Math.abs(((g.nodes[g.edges[e].a].s ?? 0) + (g.nodes[g.edges[e].b].s ?? 0)) / 2 - s0) < 1300;
    const free = (e: number, extra?: Set<number>) => {
      const E = g.edges[e];
      return !own.has(e) && !extra?.has(e) && !E.occ && !E.lock && !E.overlap && !E.closed && inArea(e);
    };
    const label = (E: GEdge, m: number, d: Dir, rev: boolean) => {
      const M = g.nodes[m];
      const dead = (d > 0 ? M.east : M.west).length === 0;
      return `${st0[1].name} ${E.platform ? `Gleis ${E.platform.track}` : dead ? "Stumpfgleis" : "Nebengleis"} (${d > 0 ? "Richtung Betzdorf" : "Richtung Köln"}${rev ? ", mit Sägefahrt" : ""})`;
    };
    const parkable = (E: GEdge, m: number, d: Dir) => {
      const M = g.nodes[m];
      const dead = (d > 0 ? M.east : M.west).length === 0;
      return (E.platform || !E.pref || dead) && E.len >= Math.min(t.len, 200);
    };
    // zweiter Teil einer Sägefahrt: von der Weiche aus in Gegenrichtung ins andere Gleis
    const walk2 = (n: number, d: Dir, path: number[], len: number, used: Set<number>, base: { dir: Dir; edges: number[]; node: number; after: number[]; len: number }) => {
      if (len > 1200 || path.length > 15) return;
      const node = g.nodes[n];
      const opts = d > 0 ? node.east : node.west;
      for (const e of path.length ? opts : opts.filter((x) => !used.has(x))) {
        if (!free(e, used)) continue;
        const E = g.edges[e];
        const m = d > 0 ? E.b : E.a;
        const np = [...path, e];
        if (parkable(E, m, d)) out.push({ label: label(E, m, d, true), dir: base.dir, edges: base.edges, len: base.len + len + E.len, rev: { node: base.node, after: base.after, edges: np } });
        walk2(m, d, np, len + E.len, used, base);
      }
    };
    for (const d of [t.dir, (t.dir * -1) as Dir]) {
      const startEdge = d === t.dir ? t.body[t.body.length - 1] : t.body[0];
      const E0 = g.edges[startEdge];
      const start = d > 0 ? E0.b : E0.a;
      const walk = (n: number, path: number[], len: number, trailing: { node: number; idx: number; dist: number; done: boolean }[]) => {
        if (len > 1800 || path.length > 25) return;
        const node = g.nodes[n];
        const sid = node.sigE || node.sigW;
        if (path.length && (node.portal || (sid && this.il.sig(sid).kind === "block"))) return;
        // rückliegende Weiche (zwei Gleise hinter uns): Kandidat für eine Sägefahrt
        const back = d > 0 ? node.west : node.east;
        const tr = back.length === 2 && path.length ? [...trailing, { node: n, idx: path.length, dist: len, done: false }] : trailing;
        for (const e of d > 0 ? node.east : node.west) {
          if (!free(e)) continue;
          const E = g.edges[e];
          const m = d > 0 ? E.b : E.a;
          const np = [...path, e];
          if (parkable(E, m, d)) out.push({ label: label(E, m, d, false), dir: d, edges: np, len: len + E.len });
          const tr2 = tr.map((x) => ({ ...x }));
          for (const x of tr2) {
            if (x.done || len + E.len - x.dist < t.len + 25) continue;
            x.done = true;
            const after = np.slice(x.idx);
            const came = path[x.idx - 1];
            const used = new Set([...np, ...t.body]);
            used.delete(came);
            const other = (d > 0 ? g.nodes[x.node].west : g.nodes[x.node].east).find((b) => b !== came);
            if (other !== undefined) walk2(x.node, (d * -1) as Dir, [], 0, new Set([...used, came]), { dir: d, edges: np, node: x.node, after, len: len + E.len });
          }
          walk(m, np, len + E.len, tr2);
        }
      };
      walk(start, [], 0, []);
    }
    // je Ziel nur der kürzeste Weg
    const best = new Map<string, ShuntTarget & { len: number }>();
    for (const o of out) if (!best.has(o.label) || best.get(o.label)!.len > o.len) best.set(o.label, o);
    return [...best.values()].sort((a, b) => a.len - b.len).slice(0, 12);
  }

  // Weichen für eine Rangierfahrt ab der Zugspitze stellen
  private setShuntSwitches(t: Train, edges: number[]): string | null {
    const g = this.g;
    let prev = t.body[t.body.length - 1];
    const sw: [number, number][] = [];
    for (const e of edges) {
      const n = this.exitNode(t, prev);
      const node = g.nodes[n];
      if (node.swSide !== undefined) {
        const side = node.swSide > 0 ? node.east : node.west;
        const want = side.indexOf(node.swSide === t.dir ? e : prev);
        if (want >= 0 && want !== node.swPos) {
          if (this.il.faultySwitches.has(n)) return `Weiche ${node.swName} ist gestört`;
          if (this.il.blockedSwitches.has(n)) return `Weiche ${node.swName} ist gesperrt`;
          if (side.some((x) => x !== e && x !== prev && (g.edges[x].occ || (g.edges[x].lock && g.edges[x].lock !== -t.id) || g.edges[x].overlap))) return `Weiche ${node.swName} ist verschlossen`;
          sw.push([n, want]);
        }
      }
      prev = e;
    }
    for (const [n, pos] of sw) g.nodes[n].swPos = pos;
    return null;
  }

  startShunt(t: Train, target: ShuntTarget): string | null {
    const why = this.canShunt(t);
    if (why) return why;
    const g = this.g;
    const all = [...target.edges, ...(target.rev?.edges ?? [])];
    for (const e of all) if (g.edges[e].occ || g.edges[e].lock || g.edges[e].closed) return "Fahrweg nicht mehr frei";
    if (target.dir !== t.dir) this.flip(t);
    const err = this.setShuntSwitches(t, target.edges);
    if (err) return err;
    for (const e of all) g.edges[e].lock = -t.id;
    t.shunt = { edges: [t.body[t.body.length - 1], ...target.edges], label: target.label, rev: target.rev };
    t.dwelling = false;
    this.log(`Rangierfahrt ${t.no} nach ${target.label}`, "info");
    return null;
  }

  private shuntDrive(t: Train, dt: number) {
    const g = this.g, sh = t.shunt!;
    const head = this.headEdge(t);
    const idx = sh.edges.indexOf(head.id);
    let rem = head.len - t.headPos;
    for (let i = idx + 1; i < sh.edges.length; i++) rem += g.edges[sh.edges[i]].len;
    rem -= 10;
    const o = t.couple ? this.trains.find((x) => x.id === t.couple) : undefined;
    if (o && !sh.rev) {
      // bis an den anderen Zug heranfahren (Kupplung)
      const last = sh.edges[sh.edges.length - 1];
      const E = g.edges[last];
      const free = o.body[0] === last && o.dir === t.dir ? this.tailPos(o) : o.body[o.body.length - 1] === last && o.dir !== t.dir ? E.len - o.headPos : E.len;
      rem = rem + 10 - (E.len - free) - 2;
      if (rem <= 0.3) { this.doCouple(t, o); return; }
    }
    if (rem <= 0.3 && sh.rev) {
      // Sägefahrt: Richtung wechseln und ins Zielgleis zurückdrücken
      t.v = 0;
      const oldTail = t.body[0];
      this.flip(t);
      const j = sh.rev.after.indexOf(oldTail);
      const back = (j >= 0 ? sh.rev.after.slice(0, j) : sh.rev.after).reverse().filter((e) => !t.body.includes(e));
      const path = [...back, ...sh.rev.edges];
      const err = this.setShuntSwitches(t, path);
      if (err) {
        this.log(`Rangierfahrt ${t.no}: ${err}, Zug bleibt stehen`, "warn");
        sh.rev = undefined;
        sh.edges = [t.body[t.body.length - 1]];
        return;
      }
      t.shunt = { edges: [t.body[t.body.length - 1], ...path], label: sh.label };
      return;
    }
    if (rem <= 0.3) {
      t.v = 0;
      for (const e of g.edges) if (e.lock === -t.id) e.lock = 0;
      t.shunt = undefined;
      t.shunted = true;
      t.dwelling = true;
      const pl = this.headEdge(t).platform;
      if (t.bereit) {
        const q = this.pending.find((x) => x.key === t.bereit);
        if (q && pl && pl.st === q.stops[0].st) { this.takeOver(t, q); return; }
      }
      if (t.body.some((e) => this.routeEdges().has(e) && !this.g.edges[e].platform)) { t.parked = false; t.dissolveAt = this.time + 30; return; } // Rangierfahrt nicht am Ziel: neu versuchen oder ins Werk
      if (pl) { t.dissolveAt = this.time + 600; t.parked = false; this.log(`${t.no} steht in ${sh.label}`, "info"); }
      else { t.parked = true; t.dissolveAt = 1e12; this.log(`${t.no} steht in ${sh.label} und ist abgestellt`, "good"); }
      return;
    }
    const allowed = Math.min((t.rescue && rem > 400 ? 40 : 25) / 3.6, Math.sqrt(2 * t.dec * rem));
    if (t.v < allowed) t.v = Math.min(allowed, t.v + t.acc * dt);
    else t.v = Math.max(allowed, t.v - t.dec * 1.6 * dt);
    const s = Math.max(0, Math.min(t.v * dt, rem));
    if (s < 0.001) { t.v = Math.max(t.v, 0.5); return; }
    this.move(t, s);
    const keep = new Set([...sh.edges.slice(sh.edges.indexOf(this.headEdge(t).id)), ...(sh.rev ? [...sh.rev.after, ...sh.rev.edges] : [])]);
    for (const e of g.edges) if (e.lock === -t.id && !e.occ && !keep.has(e.id)) e.lock = 0;
  }

  private reverse(t: Train, next: TripSpec) {
    const g = this.g;
    // Position des Zugschlusses in der hintersten Kante bestimmen
    const first = g.edges[t.body[0]];
    let tailPos: number;
    if (t.body.length === 1) tailPos = t.headPos - t.len;
    else {
      let rem = t.len - t.headPos;
      for (let i = 1; i < t.body.length - 1; i++) rem -= g.edges[t.body[i]].len;
      tailPos = first.len - rem;
    }
    const flip = next.dir !== t.dir;
    if (flip) this.flip(t, first.len, tailPos);
    t.trip = next;
    t.no = next.no;
    t.stops = next.stops.map((s) => ({ ...s, done: false, plan: this.planFor(next, s.st) }));
    t.sev = undefined;
    t.stops[0].track = this.headEdge(t).platform?.track;
    t.stopIdx = 0;
    const s0 = t.stops[0];
    s0.actArr = this.time;
    t.dwellUntil = Math.max(this.time + 30, s0.dep);
    t.dwelling = true;
    t.delayIn = Math.max(0, this.time + 30 - s0.dep);
    t.delay = t.delayIn;
    t.reverseAt = 0;
    t.causes = {};
    this.ext.applyPerf(t);
    this.il.releaseOverlapForTrain(t.id);
    this.log(`${next.turnedFrom?.no ?? ""} ${flip ? "wendet und fährt" : "fährt weiter"} als ${t.no} nach ${next.to}`, "info");
  }

  private tripDone(t: Train) {
    this.score.trainsDone++;
    const caused = t.delay - t.delayIn;
    for (const [k, v] of Object.entries(t.causes)) this.score.causes[k] = (this.score.causes[k] ?? 0) + v / 60;
    if (caused > 0) this.score.delayMin += caused / 60;
    if (t.delay >= 360) {
      const top = Object.entries(t.causes).sort((a, b) => b[1] - a[1])[0];
      this.score.late.push({ no: t.no, min: Math.round(t.delay / 60), cause: top ? top[0] : "unbekannt" });
    }
    if (t.delay < 360 || caused < 120) {
      this.score.punctual++;
      this.score.points += 10;
    } else {
      this.score.points -= Math.round(caused / 60);
    }
  }

  private finish(t: Train, viaPortal: boolean) {
    t.gone = true;
    if (viaPortal) {
      this.umlaufExit(t);
      for (let i = t.stopIdx; i < t.stops.length; i++) this.missStop(t, i);
      this.tripDone(t);
    }
  }

  // ---------------- Stellbefehle des Spielers ----------------
  routeTargets(sigId: number): { path: PathDef; why: string | null }[] {
    return (this.il.paths.get(sigId) ?? []).map((p) => ({ path: p, why: this.il.check(p) }));
  }

  setRoute(startSig: number, endSig: number | string): string | null {
    const cands = (this.il.paths.get(startSig) ?? []).filter((p) => (typeof endSig === "string" ? p.endPortal === endSig : p.endSig === endSig));
    if (!cands.length) return "Keine Fahrstraße zwischen diesen Signalen";
    if (typeof endSig === "string" && this.zugmeldung) {
      const t = this.trains.find((x) => x.nextSig === startSig);
      if (t && t.trip.exitPortal === endSig && !this.outAccepted(t)) return `${t.no} ist vom Nachbarn noch nicht angenommen (Zugmeldung)`;
    }
    // Zug, der hier endet und wendet: keine Ausfahrt in die alte Richtung stellen (blockiert sonst die Weichen)
    const here = this.trains.find((x) => x.nextSig === startSig && x.dwelling && x.distNextSig < 400);
    if (here && here.stopIdx === here.stops.length - 1 && !here.trip.exitPortal) {
      const nx = here.trip.turnInto;
      const at = nx ? Math.max(here.reverseAt, nx.stops[0].dep) : 0;
      const hhmm = `${String(Math.floor((at % 86400) / 3600)).padStart(2, "0")}:${String(Math.floor(at / 60) % 60).padStart(2, "0")}`;
      if (!nx) return `${here.no} endet hier und wird abgestellt. Keine Ausfahrt nötig (Rechtsklick auf den Zug: Rangieren)`;
      if (nx.dir !== here.dir) return `${here.no} endet hier und fährt um ${hhmm} als ${nx.no} in die Gegenrichtung (${nx.to}). Ausfahrt erst dann am Signal auf der anderen Seite stellen`;
    }
    cands.sort((a, b) => Number(a.diverging) - Number(b.diverging) || a.len - b.len);
    let why: string | null = null;
    const who = this.trains.find((x) => x.nextSig === startSig);
    for (const p of cands) {
      const lue = this.ops.lueConflict(p, who);
      if (lue) { why ??= lue; continue; }
      const r = this.il.set(p, this.time);
      if (typeof r !== "string") return null;
      why ??= r;
    }
    return why;
  }

  toggleSwitch(n: number): string | null {
    const node = this.g.nodes[n];
    if (node.swSide === undefined) return "Keine Weiche";
    if (this.il.faultySwitches.has(n)) return `Weiche ${node.swName} ist gestört`;
    if (this.il.switchLocked(n)) return `Weiche ${node.swName} ist verschlossen oder besetzt`;
    if (this.il.blockedSwitches.has(n)) return `Weiche ${node.swName} ist gesperrt (Sperre zuerst aufheben)`;
    node.swPos = 1 - node.swPos;
    return null;
  }

  // Zusätzliche Haltezeit für den Fahrgastwechsel je nach Tageszeit und Bahnhof (Sekunden)
  paxDwell(st: string): number {
    const h = (((this.time % 86400) + 86400) % 86400) / 3600;
    const peak = (h >= 6.5 && h < 9) || (h >= 15.5 && h < 18.5) ? 1 : h >= 9 && h < 15.5 ? 0.5 : h >= 18.5 && h < 21 ? 0.4 : 0.15;
    const size = ["TR", "SB"].includes(st) ? 50 : ["HN", "AU", "BZ", "PW", "SP"].includes(st) ? 25 : 10;
    return Math.round(size * peak * (0.4 + this.rand() * 1.2));
  }

  // ---------------- Zuglenkung / Selbststellbetrieb ----------------
  private autoRoutes() {
    // Wartende Züge zuerst bedienen, dann nach Nähe zum Signal
    const cands = this.trains
      .filter((t) => t.nextSig && t.distNextSig < (t.v * t.v) / (2 * t.dec) + 1500)
      .sort((a, b) => b.waitRed - a.waitRed || a.distNextSig - b.distNextSig);
    for (const t of cands) {
      const s = this.il.sig(t.nextSig);
      // Zuglenkung pro Zug: "auto" = auch an selbst gestellten Signalen automatisch, "aus" = nie (außer Blocksignalen)
      const zl = this.zlMode.get(t.trip.key);
      const autoHere = s.kind === "block" ? s.auto : zl === "auto" ? true : zl === "aus" ? false : s.auto;
      if (!autoHere || s.route) continue;
      const paths = this.il.paths.get(s.id) ?? [];
      if (!paths.length) continue;
      if (s.kind === "block") {
        for (const p of paths) {
          if (p.endPortal && this.zugmeldung && !this.outAccepted(t)) continue;
          if (this.ops.lueConflict(p, t)) continue;
          if (this.crossingBlocked(t, p) && t.waitRed < 900) continue; // auch Blocksignale vor eingleisigen Abschnitten beachten die Kreuzung
          if (!this.il.check(p)) { this.il.set(p, this.time); break; }
        }
        continue;
      }
      if (t.stopAheadIsPlatform && !t.dwelling) continue;
      if (t.dwelling && t.dwellUntil - this.time > 40) continue;
      if (t.dwelling && t.stopIdx === t.stops.length - 1 && !t.trip.exitPortal) continue;
      const best = this.bestPath(t, paths);
      if (best) {
        this.il.set(best, this.time);
        // langer Güterzug, der vor dem Zielsignal nicht ganz Platz hat: Ausfahrt gleich mit einstellen, damit er nicht auf Weichen stehen bleibt
        if (t.cat === "G" && t.len > 120 && best.endSig && this.roomBefore(best.endSig) < t.len + 40 && !this.il.sig(best.endSig).route) {
          this.nestedBest = true;
          const nx = this.bestPath(t, this.il.paths.get(best.endSig) ?? []);
          this.nestedBest = false;
          if (nx) this.il.set(nx, this.time);
          else if (t.waitRed < 600 || this.someoneHangs(t, best.endSig)) this.cancelRoute(best.sig); // Ausfahrt geht nicht: lieber hier warten als auf Weichen stehen bleiben
        }
      }
    }
  }

  // Wählt die Fahrstraße, die den Zug am günstigsten zu seinem nächsten Ziel bringt
  bestPath(t: Train, paths: PathDef[]): PathDef | null {
    const goal = this.goalKey(t);
    let best: PathDef | null = null, bestCost = Infinity, ideal = Infinity;
    const costs = paths.map((p) => this.pathCost(p, t, goal));
    for (const c of costs) ideal = Math.min(ideal, c);
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      const c = costs[i];
      // Deutlich schlechtere Umwege (z. B. lange Gegengleisfahrt) nicht wählen, lieber warten
      // (wartet der Zug schon länger, sind auch Umwege und andere Gleise recht)
      if (c > ideal * 1.25 + 800 + (t.waitRed > 120 ? 3000 : 0) + (t.waitRed > 900 ? 1e7 : 0)) continue;
      if (this.singleTrackBlocked(t, p)) continue;
      if (this.ops.lueConflict(p, t)) continue;
      // Zuglänge: lange Züge nicht vor ein Signal schicken, vor dem sie mit dem Ende in den Weichen stehen bleiben würden
      if (this.grabsLastTrack(t, p)) continue;
      if (!this.nestedBest && p.endSig && t.cat === "G" && t.len > 120 && this.roomBefore(p.endSig) < t.len + 40 && (t.waitRed < 600 || this.someoneHangs(t, p.endSig)) && !this.canGoOnFor(t, p.endSig)) continue;
      if (p.endPortal && this.zugmeldung && !this.outAccepted(t)) continue;
      if (this.il.check(p)) continue;
      if (c < bestCost) {
        bestCost = c;
        best = p;
      }
    }
    return bestCost < 1e8 ? best : null;
  }

  // Nicht das letzte freie Gleis belegen, das ein Gegenzug braucht (sonst stehen beide Bahnhöfe voll und nichts geht mehr)
  private grabsLastTrack(t: Train, p: PathDef): boolean {
    const g = this.g;
    const pl = p.edges.map((e) => g.edges[e].platform).find(Boolean);
    if (!pl) return false;
    const st = pl.st, sS = this.stS(st);
    const own = t.stops.find((x, i) => i >= t.stopIdx && x.st === st && !x.done);
    if ((own ? (own.disp ?? own.plan) : this.planTrack(st, t.dir, t.trip.line, t.trip.to)) === pl.track) return false; // eigenes Regelgleis
    // Strecke dahinter staut sich (Zug steht auf der freien Strecke): nicht aufs Gleis der Gegenrichtung ausweichen
    if (t.waitRed < 3600 && this.trains.some((o) => o !== t && o.dir === t.dir && o.v < 0.5 && !o.dwelling && (this.headS(o) - sS) * t.dir > 200 && (this.headS(o) - sS) * t.dir < 4000)) return true;
    const need = new Set<string>();
    let waiting = false;
    for (const o of this.trains) {
      if (o === t || o.dir === t.dir || o.parked || o.shunt || !o.body.length) continue;
      const d = (sS - this.headS(o)) * o.dir;
      if (d < 50 || d > 5000) continue;
      const s = o.stops.find((x, i) => i >= o.stopIdx && x.st === st && !x.done);
      const tr = s ? (s.disp ?? s.plan) : this.planTrack(st, o.dir, o.trip.line, o.trip.to);
      if (tr === pl.track) { need.add(tr); if (o.waitRed > 30 || o.v < 0.5) waiting = true; }
    }
    if (!need.has(pl.track)) return false;
    return waiting || t.waitRed < 2400;
  }
  // Steht schon ein anderer Zug in der Nähe mit dem Zugschluss auf Weichen? Dann nicht auch noch hineinfahren (gegenseitige Blockade)
  private someoneHangs(t: Train, sid: number): boolean {
    const g = this.g, s = g.nodes[this.il.sig(sid).node].s ?? 0;
    return this.trains.some((o) => o !== t && o.cat === "G" && o.len > 120 && o.dir !== t.dir && !o.shunt && o.v < 0.5 && Math.abs(this.headS(o) - s) < 2500
      && o.body.some((e) => g.nodes[g.edges[e].a].swSide !== undefined || g.nodes[g.edges[e].b].swSide !== undefined) && !o.dwelling);
  }
  // Platz vor einem Signal bis zur nächsten Weiche (dort kann ein Zug stehen, ohne Weichen zu blockieren)
  private roomCache = new Map<number, number>();
  roomBefore(sid: number): number {
    const c = this.roomCache.get(sid);
    if (c !== undefined) return c;
    const g = this.g, sg = this.il.sig(sid);
    let n = sg.node, room = 0;
    for (let k = 0; k < 30; k++) {
      const N = g.nodes[n];
      const back = sg.dir > 0 ? N.west : N.east;
      if (back.length !== 1) break;
      const E = g.edges[back[0]];
      room += E.len;
      n = otherEnd(E, n);
      const M = g.nodes[n];
      if (M.swSide !== undefined) { room -= E.len; break; } // die Kante an der Weiche selbst zählt nicht (Flankenschutz)
      if ((sg.dir > 0 ? M.west : M.east).length !== 1 || (sg.dir > 0 ? M.sigE : M.sigW)) break;
    }
    this.roomCache.set(sid, room);
    return room;
  }
  // Kann hinter dem Signal sofort weitergefahren werden (Fahrstraße frei oder schon eingestellt)?
  private nestedBest = false;
  private canGoOnFor(t: Train, sid: number): boolean {
    if (this.il.sig(sid).route) return true;
    this.nestedBest = true;
    const ok = !!this.bestPath(t, this.il.paths.get(sid) ?? []);
    this.nestedBest = false;
    return ok;
  }
  private canGoOn(sid: number): boolean {
    const s = this.il.sig(sid);
    if (s.route) return true;
    return (this.il.paths.get(sid) ?? []).some((q) => !this.il.check(q));
  }

  // ---------------- Eingleisige Abschnitte (Kreuzungslogik der Zuglenkung) ----------------
  singles: { edges: Set<number>; gates: Map<number, Dir> }[] = [];

  private findSingleTracks() {
    const g = this.g;
    const isS = (e: number) => !Number.isInteger(g.nodes[g.edges[e].a].y) && !Number.isInteger(g.nodes[g.edges[e].b].y);
    const seen = new Set<number>();
    for (const e0 of g.edges) {
      if (seen.has(e0.id) || !isS(e0.id)) continue;
      const set = new Set<number>(), stack = [e0.id];
      while (stack.length) {
        const e = stack.pop()!;
        if (set.has(e)) continue;
        set.add(e); seen.add(e);
        for (const n of [g.edges[e].a, g.edges[e].b]) for (const x of [...g.nodes[n].east, ...g.nodes[n].west]) if (isS(x) && !set.has(x)) stack.push(x);
      }
      const gates = new Map<number, Dir>();
      for (const [sid, paths] of this.il.paths) {
        const sg = this.il.sig(sid);
        if (set.has(this.edgeBehind(sg))) continue; // Signal liegt selbst im Abschnitt
        if (paths.some((p) => p.edges.some((x) => set.has(x)))) gates.set(sid, sg.dir);
      }
      this.singles.push({ edges: set, gates });
    }
  }

  // Kante, über die ein Zug an das Signal heranfährt
  private edgeBehind(sg: { node: number; dir: Dir }): number {
    const n = this.g.nodes[sg.node];
    const arr = sg.dir > 0 ? n.west : n.east;
    return arr.length === 1 ? arr[0] : -1;
  }

  // Würde der Zug mit diesem Fahrweg vor einem eingleisigen Abschnitt warten, in dem ein Gegenzug
  // unterwegs ist, und dabei das letzte freie Gleis für den Gegenzug zustellen?
  private crossingBlocked(t: Train, p: PathDef): boolean {
    // Einfahrt in den eingleisigen Abschnitt nur, wenn im Kreuzungsbahnhof am anderen Ende ein Gleis frei ist
    // Hat der Fdl am anderen Ende die Einfahrt für diese Richtung schon gestellt, ist die Kreuzung entschieden
    if (p.endSig) { const r = this.il.routes.get(this.il.sig(p.endSig).route); if (r && !r.used && r.path.dir === t.dir && !this.trains.some((o) => o !== t && (o.nextSig === p.endSig || o.body.some((e) => p.edges.includes(e))))) return false; }
    for (const S of this.singles) {
      if (!p.edges.some((e) => S.edges.has(e))) continue;
      let far = [...S.gates].filter(([, d]) => d !== t.dir);
      if (far.length < 2) continue;
      // nur Bahnsteiggleise zählen (ein Gleis einer abzweigenden Strecke nützt dem Gegenzug nichts)
      const plat = far.filter(([sid]) => { const eb = this.edgeBehind(this.il.sig(sid)); return eb >= 0 && !!this.g.edges[eb].platform; });
      if (plat.length) far = plat;
      const free = far.filter(([sid]) => {
        const eb = this.edgeBehind(this.il.sig(sid));
        if (eb < 0) return false;
        const E = this.g.edges[eb];
        return !E.occ && !E.lock;
      }).length;
      if (free === 0) return true;
    }
    if (!p.endSig) return false;
    for (const S of this.singles) {
      if (S.gates.get(p.endSig) !== t.dir) continue;
      let opposing = false;
      for (const e of S.edges) {
        const E = this.g.edges[e];
        if (E.occ) {
          const tr = this.trains.find((x) => x.body.includes(e));
          if (tr && tr.dir !== t.dir) opposing = true;
        }
        if (E.lock) {
          const r = this.il.routes.get(E.lock);
          if (r && r.path.dir !== t.dir) opposing = true;
        }
      }
      if (!opposing) return false;
      let free = 0;
      for (const [sid, d] of S.gates) {
        if (d !== t.dir) continue;
        const eb = this.edgeBehind(this.il.sig(sid));
        if (eb < 0) continue;
        const E = this.g.edges[eb];
        if (!E.occ && !E.lock && !E.overlap) free++;
      }
      return free < 2;
    }
    return false;
  }

  // Zug soll auf eingleisige Strecke ausfahren, deren Streckengleis noch vom Gegenzug belegt ist
  private singleTrackBlocked(t: Train, p: PathDef): boolean {
    if (this.crossingBlocked(t, p)) return true;
    const ex = t.trip.exitPortal;
    if (!ex) return false;
    const P = this.g.portals[ex];
    if (P.inNode !== P.outNode) return false;
    const n = this.g.nodes[P.outNode];
    const e = this.g.edges[[...n.east, ...n.west][0]];
    if (!e.occ) return false;
    // nur der Bahnhof direkt vor der eingleisigen Strecke ist betroffen, nicht alle Bahnhöfe davor
    const last = t.stops[t.stops.length - 1]?.st;
    return p.edges.some((x) => this.g.edges[x].platform?.st === last) || p.endPortal === ex;
  }

  private goalKey(t: Train): string {
    const ps = t.stops.slice(t.stopIdx).find((s) => !s.done);
    if (ps && t.dwelling && ps === this.pendingStop(t)) {
      const nx = t.stops[t.stopIdx + 1];
      if (nx) return `st:${nx.st}`;
      return t.trip.exitPortal ? `pt:${t.trip.exitPortal}` : "none";
    }
    if (ps) return `st:${ps.st}`;
    return t.trip.exitPortal ? `pt:${t.trip.exitPortal}` : "none";
  }

  // Nächstes Signal in Fahrtrichtung ab Knoten n (gemäß aktueller Weichenlage)
  private sigAhead(n: number, d: Dir): { sid: number; dist: number } | null {
    const g = this.g;
    let dist = 0;
    for (let k = 0; k < 40; k++) {
      const node = g.nodes[n];
      const sid = d > 0 ? node.sigE : node.sigW;
      if (sid) return { sid, dist };
      const e = nextEdge(g, n, d);
      if (e === undefined) return null;
      dist += g.edges[e].len;
      n = otherEnd(g.edges[e], n);
    }
    return null;
  }

  // Kosten, um nach dem Halt an Bahnsteigkante e weiterzukommen (nächster Halt, Streckenende oder Wende)
  private costAfter(t: Train, e: number, d: Dir): number {
    const E = this.g.edges[e];
    const st = E.platform!.st;
    const i = t.stops.findIndex((s, k) => k >= t.stopIdx && s.st === st);
    const after = i >= 0 ? t.stops[i + 1] : undefined;
    let goal = "none", rd = d;
    if (after) goal = `st:${after.st}`;
    else if (t.trip.exitPortal) goal = `pt:${t.trip.exitPortal}`;
    else if (t.trip.turnInto) {
      const nx = t.trip.turnInto;
      rd = nx.dir; // Wende (Richtungswechsel) oder Durchbindung in gleicher Richtung
      goal = nx.stops[1] ? `st:${nx.stops[1].st}` : nx.exitPortal ? `pt:${nx.exitPortal}` : "none";
    }
    if (goal === "none") return 0;
    const sa = this.sigAhead(rd > 0 ? E.b : E.a, rd);
    if (!sa) return 1e9;
    return (sa.dist + this.distSig(sa.sid, goal)) * 0.2;
  }

  private pathCost(p: PathDef, t: Train, goal: string): number {
    let c = 0;
    for (const e of p.edges) {
      const E = this.g.edges[e];
      c += E.len * (E.pref && E.pref !== p.dir ? 3 : 1);
      if (E.platform && goal === `st:${E.platform.st}`) {
        if (E.len < t.len - 10) c += 5000;
        const stp = t.stops.find((x) => !x.done && x.st === E.platform!.st);
        if (stp?.disp && stp.disp !== E.platform.track) return 1e9; // angeordnetes Gleis abwarten
        if (stp && !stp.disp && stp.plan && stp.plan !== E.platform.track) c += 300; // Regelgleis bevorzugen
        if (t.waitFor?.st === E.platform.st && !stp?.disp) {
          // bei angeordneter Überholung nicht das Gleis belegen, das der überholende Zug braucht
          const o = this.trains.find((x) => x.id === t.waitFor!.train);
          const os = o?.stops.find((x) => !x.done && x.st === E.platform!.st);
          const oTrack = o && ((os?.disp ?? os?.plan) ?? this.planTrack(E.platform.st, o.dir, o.trip.line, o.trip.to));
          if (oTrack === E.platform.track) c += 4000;
        }
        return c + (p.diverging ? 30 : 0) + this.costAfter(t, E.id, p.dir);
      }
    }
    if (p.endPortal) return goal === `pt:${p.endPortal}` ? c : 1e9;
    return c + (p.diverging ? 30 : 0) + this.distSig(p.endSig, goal);
  }

  private pathCostStatic(p: PathDef, goal: string): { cost: number; reached: boolean } {
    let c = 0;
    for (const e of p.edges) {
      const E = this.g.edges[e];
      c += E.len * (E.pref && E.pref !== p.dir ? 3 : 1);
      if (E.platform && goal === `st:${E.platform.st}`) return { cost: c, reached: true };
    }
    if (p.endPortal) return { cost: c, reached: goal === `pt:${p.endPortal}` };
    return { cost: c + (p.diverging ? 30 : 0), reached: false };
  }

  // Dijkstra über das Fahrstraßennetz (Signal zu Signal) bis zum Ziel
  private distSig(sid0: number, goal: string): number {
    let m = this.distCache.get(goal);
    if (!m) this.distCache.set(goal, (m = new Map()));
    const key = String(sid0);
    const cached = m.get(key);
    if (cached !== undefined) return cached;
    const dist = new Map<number, number>([[sid0, 0]]);
    const q: [number, number][] = [[0, sid0]];
    let res = 1e9;
    while (q.length) {
      q.sort((a, b) => a[0] - b[0]);
      const [c, s] = q.shift()!;
      if (c > (dist.get(s) ?? Infinity) || c >= res) continue;
      for (const p of this.il.paths.get(s) ?? []) {
        const r = this.pathCostStatic(p, goal);
        if (r.reached) {
          res = Math.min(res, c + r.cost);
          continue;
        }
        if (!p.endSig) continue;
        const nc = c + r.cost;
        if (nc < (dist.get(p.endSig) ?? Infinity)) {
          dist.set(p.endSig, nc);
          q.push([nc, p.endSig]);
        }
      }
    }
    m.set(key, res);
    return res;
  }

  // ---------------- Störungen ----------------
  switchFault(n: number) { return this.il.faultySwitches.has(n); }
  signalFault(sid: number) { return this.il.faultySignals.has(sid); }

  // Liegt dieser Streckenkilometer im Bereich des Spielers?
  mineS(sPos: number): boolean {
    let best = "", bd = Infinity;
    for (const c of Object.keys(this.g.stations)) { const d = Math.abs(this.stS(c) - sPos); if (d < bd) { bd = d; best = c; } }
    return !!best && this.manualSt(best);
  }
  nearStation(x: number): string {
    let best = "", bd = Infinity;
    for (const s of Object.values(this.g.stations)) if (Math.abs(s.x - x) < bd) { bd = Math.abs(s.x - x); best = s.name; }
    return best;
  }

  faultCount = 0;
  addFault(kind: Fault["kind"], target: number, until: number, text: string) {
    this.faultCount++;
    this.faults.push({ id: this.faultId++, kind, target, until, text, from: this.time });
    this.log(text, "warn");
  }

  private faultsTick() {
    // abgelaufene Störungen beheben
    for (const f of this.faults) {
      if (f.until > this.time) continue;
      if (f.kind === "switch") {
        this.il.faultySwitches.delete(f.target);
        this.log(`Weiche ${this.g.nodes[f.target].swName} (${this.nearStation(this.g.nodes[f.target].x)}) ist wieder in Ordnung`, "good");
      }
      if (f.kind === "az") {
        const sec = this.azSections.find((x) => x.id === f.target);
        if (sec) this.azClear(sec, "Techniker hat den Achszähler zurückgesetzt");
      }
      if (f.kind === "signal") {
        this.il.faultySignals.delete(f.target);
        this.log(`Signal ${this.il.sig(f.target).name} ist wieder in Ordnung`, "good");
      }
    }
    this.faults = this.faults.filter((f) => f.until > this.time);
    for (const [sid, until] of this.il.zs1) if (until < this.time) this.il.zs1.delete(sid);
    if (!this.faultRate) return;
    const r = this.rand, k = (10 / 60) * this.faultRate; // Anteil einer Minute
    // Weichenstörung: etwa alle 90 min
    const W = this.ext.f.weather ? this.ext.weather : { sw: 1, sig: 1 };
    if (r() < (k * W.sw) / 90) {
      const sws = this.g.nodes.filter((n) => n.swSide !== undefined && !this.il.faultySwitches.has(n.id));
      const n = sws[Math.floor(r() * sws.length)];
      const dur = 600 + Math.floor(r() * 900);
      this.il.faultySwitches.add(n.id);
      const mine = this.mineS(n.s ?? 0);
      this.addFault("switch", n.id, this.time + (mine ? 1e7 : dur), `Weichenstörung ${n.swName} (${this.nearStation(n.x)}): lässt sich nicht umstellen, ${mine ? "Störungstrupp rufen" : `Techniker ca. ${Math.round(dur / 60)} min`}`);
      if (mine) this.phone.add("weiche", `Weichenstörung ${n.swName}`, this.nearStation(n.x), ["stoerung"], this.faults[this.faults.length - 1].id, true, { work: dur * 0.6 });
    }
    // Signalstörung: etwa alle 120 min
    if (r() < (k * W.sig) / 120) {
      const sg = this.g.signals.filter((x) => !this.il.faultySignals.has(x.id) && !x.route && !this.trains.some((t) => t.nextSig === x.id && t.distNextSig < this.brakeDist(t) + 300));
      const s = sg[Math.floor(r() * sg.length)];
      const dur = 600 + Math.floor(r() * 1200);
      this.il.faultySignals.add(s.id);
      const mine = this.mineS(this.g.nodes[s.node].s ?? 0);
      this.addFault("signal", s.id, this.time + (mine ? 1e7 : dur), `Signalstörung ${s.name}: zeigt keine Fahrt, Ersatzsignal geben (Strg + Klick), ${mine ? "Störungstrupp rufen" : `ca. ${Math.round(dur / 60)} min`}`);
      if (mine) this.phone.add("signal", `Signalstörung ${s.name}`, this.nearStation(this.g.nodes[s.node].x), ["stoerung"], this.faults[this.faults.length - 1].id, true, { work: dur * 0.6 });
    }
    // Fahrzeugstörung: etwa alle 150 min
    if (r() < k / 150) {
      const cand = this.trains.filter((t) => t.v > 8 && !t.exiting && !t.fault);
      if (cand.length) {
        const t = cand[Math.floor(r() * cand.length)];
        const dur = 240 + Math.floor(r() * 720);
        const what = ["Bremsstörung", "Stromabnehmerstörung", "Fahrzeugstörung", "Notbremsung durch Fahrgast"][Math.floor(r() * 4)];
        t.fault = what;
        t.faultUntil = this.time + dur;
        this.addFault("vehicle", t.id, t.faultUntil, `${what} an ${t.no} bei ${this.nearStation(this.g.nodes[this.g.edges[t.body[t.body.length - 1]].a].x)}, ca. ${Math.round(dur / 60)} min`);
      }
    }
    // Liegengebliebener Zug (Hilfslok nötig): etwa alle 6 Stunden
    if (r() < k / 600) this.breakdown();
    // Achszählerstörung: etwa alle 180 min
    if (r() < k / 180) this.azFault();
    this.azAuto();
  }

  // Ersatzsignal (Zs1) für einen Zug am Signal
  giveZs1(sid: number): string | null {
    const s = this.il.sig(sid);
    if (this.il.proceeds(s, this.time)) return "Signal zeigt bereits Fahrt";
    const t = this.trains.find((t) => t.nextSig === sid && t.distNextSig < 400);
    if (!t) return "Kein Zug steht vor diesem Signal";
    const azBlock = (this.il.paths.get(sid) ?? []).every((p) => p.edges.some((e) => this.g.edges[e].az));
    if (!s.route && azBlock) return "Dahinter ist die Gleisfreimeldung gestört: Ersatzsignal reicht nicht, erst Grundstellung, dann schriftlichen Befehl erteilen";
    if (!s.route) {
      // Ohne Fahrstraße nur, wenn die Weichen einen Fahrweg bilden, der nicht in eine andere Fahrstraße führt
      const ok = (this.il.paths.get(sid) ?? []).some((p) =>
        p.sw.every(({ node, pos }) => this.g.nodes[node].swPos === pos) &&
        p.edges.every((e) => !this.g.edges[e].lock && !this.g.edges[e].closed));
      if (!ok) return "Kein gesicherter Fahrweg: erst Fahrstraße einstellen (geht auch bei Signalstörung) oder Weichen passend stellen";
    }
    this.il.zs1.set(sid, this.time + 90);
    this.log(`Ersatzsignal an ${s.name} für ${t.no}`, "info");
    this.note("Zs 1", `Ersatzsignal am ${s.name} für ${t.no}${this.il.faultySignals.has(sid) ? " (Signalstörung)" : ""}`);
    return null;
  }


  // ---------------- Zuglenkung pro Zug ----------------
  zlMode = new Map<number, "auto" | "aus">();
  setZl(tripKey: number, mode: string) {
    const trip = this.trains.find((t) => t.trip.key === tripKey)?.trip ?? this.pending.find((x) => x.key === tripKey);
    if (!trip) return "Zug nicht gefunden";
    if (mode === "auto" || mode === "aus") this.zlMode.set(tripKey, mode); else this.zlMode.delete(tripKey);
    this.log(`Zuglenkung für ${trip.no}: ${mode === "auto" ? "immer automatisch (auch in deinem Stellbereich)" : mode === "aus" ? "aus, du stellst alle Fahrstraßen selbst" : "wie am jeweiligen Signal eingestellt"}`, "info");
    return null;
  }

  // ---------------- Arbeitsbuch (Nachweis der Ersatzhandlungen) ----------------
  book: { t: number; kind: string; text: string }[] = [];
  note(kind: string, text: string) {
    this.book.push({ t: this.time, kind, text });
    if (this.book.length > 300) this.book.shift();
  }

  // ---------------- Gleisfreimeldung: Achszählerstörung, Grundstellung, Räumungsprüfung ----------------
  lastOnEdge = new Map<number, { no: string; id: number; t: number }>();
  azSections: { id: number; edges: number[]; state: number; from: number; name: string; zugschluss?: string; asked?: boolean; entered?: string }[] = [];
  azId = 1;
  azCount = 0; // Zählwerk der Grundstellungen
  private azSectionOf(e0: number): number[] {
    const g = this.g;
    const out = [e0], seen = new Set([e0]);
    const stopAt = (n: number) => { const N = g.nodes[n]; return N.swSide !== undefined || N.sigE || N.sigW || N.portal || N.buffer || N.east.length + N.west.length !== 2; };
    for (const start of [g.edges[e0].a, g.edges[e0].b]) {
      let n = start, cur = e0;
      while (!stopAt(n) && out.length < 12) {
        const nx = [...g.nodes[n].east, ...g.nodes[n].west].find((x) => x !== cur);
        if (nx === undefined || seen.has(nx)) break;
        seen.add(nx); out.push(nx); cur = nx;
        n = g.edges[nx].a === n ? g.edges[nx].b : g.edges[nx].a;
      }
    }
    return out;
  }
  azFault(e0?: number): string | null {
    const g = this.g, r = this.rand;
    if (e0 === undefined) {
      const cand = g.edges.filter((E) => !E.platform && !E.occ && !E.lock && !E.overlap && !E.closed && !E.az && E.len > 150 && g.nodes[E.a].s !== undefined);
      if (!cand.length) return "kein Abschnitt";
      e0 = cand[Math.floor(r() * cand.length)].id;
    }
    const edges = this.azSectionOf(e0).filter((e) => !g.edges[e].occ && !g.edges[e].lock);
    if (!edges.length) return "belegt";
    const E = g.edges[edges[0]];
    const name = E.platform ? `${g.stations[E.platform.st].name} Gleis ${E.platform.track}` : `bei ${this.nearStation(g.nodes[E.a].x)} (km ${(((g.nodes[E.a].s ?? 0) + (g.nodes[E.b].s ?? 0)) / 2000).toFixed(1).replace(".", ",")})`;
    const sec = { id: this.azId++, edges, state: 1, from: this.time, name };
    for (const e of edges) g.edges[e].az = 1;
    this.azSections.push(sec);
    this.addFault("az", sec.id, this.time + 90 * 60, `Achszählerstörung ${name}: Abschnitt zeigt besetzt, obwohl kein Zug gemeldet ist. Zugschluss prüfen, Grundstellung, dann Räumungsprüfung mit Befehl`);
    return null;
  }

  // Gehört der Bahnhof (auch Haltepunkt) zu einem Bereich, den der Spieler stellt?
  manualSt(st: string): boolean {
    const s = this.stS(st);
    let best = "", bd = Infinity;
    for (const c of ["TR", "SB", "HN", "BL", "EI", "AU", "WI", "BZ"]) { const d = Math.abs(this.stS(c) - s); if (d < bd) { bd = d; best = c; } }
    return this.manualAreas.has(st) || this.manualAreas.has(best);
  }
  // In Bereichen, die der Spieler nicht stellt, erledigt der Nachbar-Fdl den Ablauf selbst
  private azOwnerManual(sec: { edges: number[] }) {
    const x = this.g.nodes[this.g.edges[sec.edges[0]].a].x;
    let best = "", bd = Infinity;
    for (const [c, st] of Object.entries(this.g.stations)) if (Math.abs(st.x - x) < bd) { bd = Math.abs(st.x - x); best = c; }
    return this.manualAreas.has(best);
  }
  private azAuto() {
    for (const sec of [...this.azSections]) {
      if (this.azOwnerManual(sec)) continue;
      if (sec.state === 1 && this.time - sec.from > 300) {
        sec.zugschluss = sec.zugschluss ?? "Nachbar-Fdl";
        this.azReset(sec.id);
      } else if (sec.state === 2) {
        const t = this.trains.find((x) => x.v < 0.5 && x.nextSig && x.distNextSig < 400 && !x.raeum && !this.il.zs1.has(x.nextSig) && !this.orders.some((o) => o.train === x.id && (o.state !== "gültig" || this.time - o.at < 120)) && this.orderCheck(x, "vorbei").raeum === sec.id);
        if (t) this.issueOrder(t.id, "vorbei");
      }
    }
  }
  // letzter Zug, der den Abschnitt verlassen hat
  azLastTrain(id: number) {
    const sec = this.azSections.find((x) => x.id === id);
    if (!sec) return undefined;
    let best: { no: string; id: number; t: number } | undefined;
    for (const e of sec.edges) { const l = this.lastOnEdge.get(e); if (l && (!best || l.t > best.t)) best = l; }
    return best;
  }
  pendingRadio: { at: number; train: number; text: string; then?: () => void }[] = [];
  azAskZugschluss(id: number): string | null {
    const sec = this.azSections.find((x) => x.id === id);
    if (!sec) return "Störung ist schon behoben";
    if (sec.state !== 1) return "Grundstellung ist schon erfolgt";
    const last = this.azLastTrain(id);
    if (!last) return "Seit Spielbeginn ist kein Zug durch diesen Abschnitt gefahren. Prüfe im Bildfahrplan, ob er frei sein muss, und stelle dann ohne Zugschlussmeldung grund (wird im Arbeitsbuch vermerkt)";
    const t = this.trains.find((x) => x.id === last.id);
    sec.asked = true;
    if (t) {
      t.radio.push({ t: this.time, from: "fdl", text: `${t.no}, bitte melden Sie mir Zugschluss: Ist Ihr Zug vollständig, Schlusssignal vorhanden?` });
      this.pendingRadio.push({ at: this.time + 25, train: t.id, text: `${t.no}: Zug ist vollständig, Schlusssignal ist vorhanden. Zugschluss ${sec.name} um ${String(Math.floor((last.t % 86400) / 3600)).padStart(2, "0")}:${String(Math.floor(last.t / 60) % 60).padStart(2, "0")}.`, then: () => { sec.zugschluss = last.no; this.note("Zugschluss", `Zugschlussmeldung ${last.no} für Abschnitt ${sec.name} erhalten`); } });
    } else {
      sec.zugschluss = last.no;
      this.note("Zugschluss", `Zugschluss ${last.no} (Abschnitt ${sec.name}) vom Nachbar-Fdl bestätigt, Zug hat den Bereich verlassen`);
      this.log(`Nachbar-Fdl bestätigt: ${last.no} ist vollständig angekommen`, "good");
    }
    return null;
  }
  azReset(id: number): string | null {
    const sec = this.azSections.find((x) => x.id === id);
    if (!sec) return "Störung ist schon behoben";
    if (sec.state !== 1) return "Grundstellung ist schon erfolgt";
    if (sec.edges.some((e) => this.g.edges[e].occ)) return "Im Abschnitt steht ein Zug, keine Grundstellung möglich";
    this.azCount++;
    sec.state = 2;
    for (const e of sec.edges) this.g.edges[e].az = 2;
    const proof = sec.zugschluss ? `Zugschlussmeldung ${sec.zugschluss}` : "ohne Zugschlussmeldung";
    if (!sec.zugschluss) { this.score.points -= 25; this.log("Grundstellung ohne Nachweis, dass der Abschnitt frei ist: −25 Punkte", "bad"); }
    this.note("AzGrT", `Achszähler-Grundstellung Nr. ${this.azCount}, Abschnitt ${sec.name} (${proof}). Räumungsprüfung durch den nächsten Zug nötig`);
    this.log(`Grundstellung ${sec.name} ausgeführt. Der nächste Zug fährt mit Befehl auf Sicht durch (Räumungsprüfung)`, "info");
    return null;
  }
  private azLeft(e: number, t: Train) {
    const sec = this.azSections.find((x) => x.edges.includes(e));
    if (!sec || sec.state !== 2) return;
    // frei, sobald der Zug den ganzen Abschnitt verlassen hat
    const still = sec.edges.some((x) => x !== e && this.g.edges[x].occ) || this.g.edges[e].occ > 1;
    if (still || !t.body.every((x) => !sec.edges.includes(x) || x === e)) return;
    if (t.body.some((x) => sec.edges.includes(x) && x !== e)) return;
    this.pendingRadio.push({ at: this.time + 15, train: t.id, text: `${t.no}: Abschnitt ${sec.name} auf Sicht befahren, keine Hindernisse. Zugschluss vollständig.` });
    this.azClear(sec, `Räumungsprüfung durch ${t.no} abgeschlossen`);
  }
  private azClear(sec: { id: number; edges: number[]; name: string }, why: string) {
    for (const e of sec.edges) this.g.edges[e].az = undefined;
    this.azSections = this.azSections.filter((x) => x !== sec);
    this.faults = this.faults.filter((f) => !(f.kind === "az" && f.target === sec.id));
    this.note("AzGrT", `${why}: Abschnitt ${sec.name} wieder frei gemeldet`);
    this.log(`${why}: Abschnitt ${sec.name} wieder frei`, "good");
  }

  // ---------------- Schriftliche Befehle (per Funk diktiert) ----------------
  orders: { id: number; no: number; train: number; kind: string; sig: number; v: number; text: string; state: string; at: number; raeum?: number }[] = [];
  orderNo = 1;
  orderCheck(t: Train, kind: string): { why: string | null; raeum?: number } {
    if (kind === "vorbei") {
      if (!t.nextSig || t.distNextSig > 400) return { why: "Der Zug steht nicht vor einem Signal" };
      const s = this.il.sig(t.nextSig);
      if (this.il.proceeds(s, this.time)) return { why: "Das Signal zeigt bereits Fahrt" };
      if (this.orders.some((o) => o.train === t.id && o.state !== "gültig")) return { why: "Für den Zug wird gerade schon ein Befehl übermittelt" };
      let raeum: number | undefined;
      const ok = (this.il.paths.get(s.id) ?? []).some((p) => {
        if (!p.sw.every(({ node, pos }) => this.g.nodes[node].swPos === pos)) return false;
        for (const e of p.edges) {
          const E = this.g.edges[e];
          if (E.closed || (E.lock && this.il.routes.get(E.lock)?.path.sig !== s.id) || (E.occ && !t.body.includes(e)) || E.az === 1) return false;
          if (E.az === 2) raeum = this.azSections.find((x) => x.edges.includes(e))?.id;
        }
        return true;
      });
      if (!ok) {
        const az1 = (this.il.paths.get(s.id) ?? []).some((p) => p.edges.some((e) => this.g.edges[e].az === 1));
        return { why: az1 ? "Dahinter ist die Gleisfreimeldung gestört: zuerst Zugschluss prüfen und Grundstellung ausführen" : "Kein gesicherter Fahrweg: Weichen passend stellen oder Fahrstraße einstellen, Abschnitt muss frei und nicht gesperrt sein" };
      }
      return { why: null, raeum };
    }
    if (kind === "sicht") return { why: null };
    return { why: "Unbekannte Befehlsart" };
  }
  issueOrder(trainId: number, kind: string, v = 40, reason = ""): string | null {
    const t = this.trains.find((x) => x.id === trainId);
    if (!t) return "Zug nicht im Bereich";
    const c = this.orderCheck(t, kind);
    if (c.why) return c.why;
    const no = this.orderNo++;
    const sig = t.nextSig;
    let text = "";
    if (kind === "vorbei") {
      const sec = c.raeum !== undefined ? this.azSections.find((x) => x.id === c.raeum) : undefined;
      text = `Befehl Nr. ${no} für Zug ${t.no}: Sie dürfen am Halt zeigenden Signal ${this.il.sig(sig).name} vorbeifahren. ` +
        (sec ? `Der Abschnitt ${sec.name} ist nach Grundstellung des Achszählers nicht frei gemeldet. Räumungsprüfung: Fahren Sie auf Sicht mit höchstens 40 km/h und melden Sie Besonderheiten.` : `Fahren Sie bis zum nächsten Hauptsignal auf Sicht, höchstens 40 km/h.`);
    } else {
      text = `Befehl Nr. ${no} für Zug ${t.no}: Fahren Sie ab sofort bis zum nächsten Hauptsignal auf Sicht, höchstens ${v} km/h.${reason ? ` Grund: ${reason}.` : ""}`;
    }
    this.orders.push({ id: no, no, train: t.id, kind, sig, v, text, state: "diktiert", at: this.time + 30, raeum: c.raeum });
    t.radio.push({ t: this.time, from: "fdl", text: `Ich diktiere einen Befehl. ${text}` });
    this.log(`Befehl Nr. ${no} an ${t.no} wird diktiert`, "info");
    return null;
  }
  // Weichen im Fahrweg eines Befehls gegen Umstellen sichern, bis der Zug das nächste Fahrt zeigende Signal erreicht
  orderSw: { node: number; train: number; until: number }[] = [];
  private lockOrderPath(t: Train, sig: number) {
    const p = (this.il.paths.get(sig) ?? []).find((p) => p.sw.every(({ node, pos }) => this.g.nodes[node].swPos === pos) && p.edges.every((e) => !this.g.edges[e].closed && (!this.g.edges[e].occ || t.body.includes(e))));
    if (!p) return;
    for (const { node } of p.sw) {
      if (this.il.blockedSwitches.has(node)) continue;
      this.il.blockedSwitches.add(node);
      this.orderSw.push({ node, train: t.id, until: this.time + 1200 });
    }
  }
  releaseOrderSw(train?: number) {
    if (!this.orderSw.length) return;
    const keep: typeof this.orderSw = [];
    for (const x of this.orderSw) {
      if (x.train === train || x.until < this.time || !this.trains.some((t) => t.id === x.train)) this.il.blockedSwitches.delete(x.node);
      else keep.push(x);
    }
    this.orderSw = keep;
  }
  private ordersTick() {
    for (const p of [...this.pendingRadio]) {
      if (p.at > this.time) continue;
      this.pendingRadio = this.pendingRadio.filter((x) => x !== p);
      const t = this.trains.find((x) => x.id === p.train);
      if (t) t.radio.push({ t: this.time, from: "tf", text: p.text });
      this.log(p.text, "info");
      p.then?.();
    }
    for (const o of this.orders) {
      if (o.state === "gültig" || o.at > this.time) continue;
      const t = this.trains.find((x) => x.id === o.train);
      if (!t) { o.state = "gültig"; continue; }
      if (o.state === "diktiert") {
        t.radio.push({ t: this.time, from: "tf", text: `${t.driver}, ich wiederhole: ${o.text.replace(/^Befehl Nr\. \d+ für Zug \S+ \S+: /, `Befehl Nr. ${o.no}, `)}` });
        o.state = "wiederholt";
        o.at = this.time + 10;
      } else if (o.state === "wiederholt") {
        t.radio.push({ t: this.time, from: "fdl", text: `Richtig. Befehl Nr. ${o.no} gilt ab ${String(Math.floor((this.time % 86400) / 3600)).padStart(2, "0")}:${String(Math.floor(this.time / 60) % 60).padStart(2, "0")} Uhr.` });
        o.state = "gültig";
        if (o.kind === "vorbei") {
          const c = this.orderCheck(t, "vorbei");
          if (c.why && !/schon/.test(c.why)) { this.log(`Befehl Nr. ${o.no} kann nicht mehr ausgeführt werden: ${c.why}`, "warn"); continue; }
          this.il.zs1.set(o.sig, this.time + 300);
          this.lockOrderPath(t, o.sig);
          t.raeum = o.raeum;
          t.orderV = 40;
        } else {
          t.sight = true;
          t.orderV = o.v;
        }
        this.note("Befehl", o.text);
        this.log(`Befehl Nr. ${o.no} an ${t.no} gilt`, "good");
      }
    }
    this.orders = this.orders.filter((o) => o.state !== "gültig" || this.time - o.at < 600);
  }

  // ---------------- Zugmeldungen ----------------
  private reportsTick() {
    // Nachbar bietet einfahrende Züge etwa 4 Minuten vor Einfahrt an
    for (const trip of this.pending) {
      if (!trip.entryPortal) continue;
      const at = trip.entryTime + trip.initialDelay;
      if (at - 480 > this.time) break;
      if (at - this.ops.lead(trip.entryPortal) > this.time) continue;
      if (this.reports.some((r) => r.trip === trip && r.kind === "in")) continue;
      const auto = !this.manualAreas.has(PORTAL_AREA[trip.entryPortal] ?? "");
      // manchmal vergisst der Nachbar das Anbieten und meldet den Zug erst, wenn er schon unterwegs ist
      const forgot = !auto && this.rand() < this.ops.forget(trip.entryPortal);
      const r: Report = { id: this.reportId++, no: trip.no, trip, portal: trip.entryPortal, kind: "in", state: auto || forgot ? "accepted" : "offered", t: this.time, note: forgot ? "nicht angeboten" : undefined };
      this.reports.push(r);
      if (forgot) { this.log(`Fdl ${this.g.portals[trip.entryPortal].label}: „Sorry, ${trip.no} ist schon unterwegs, hab vergessen ihn anzubieten.“`, "warn"); continue; }
      if (!auto) this.log(`Zugmeldung: Fdl ${this.g.portals[trip.entryPortal].label} bietet ${trip.no} an. Annehmen?`, "warn");
    }
    // abgelehnte Züge bietet der Nachbar später erneut an
    for (const r of this.reports) if (r.kind === "in" && r.state === "refused" && r.respondAt && this.time >= r.respondAt) {
      r.state = "offered";
      r.respondAt = undefined;
      r.t = this.time;
      this.log(`Zugmeldung: Fdl ${this.g.portals[r.portal].label} bietet ${r.no} erneut an`, "warn");
    }
    // Ausfahrende Züge dem Nachbarn anbieten
    for (const t of this.trains) {
      const ex = t.trip.exitPortal;
      if (!ex || t.stops.some((s, i) => i >= t.stopIdx && !s.done)) continue;
      const P = this.g.portals[ex];
      const ps = this.g.nodes[P.outNode].s ?? 0;
      if (Math.abs(ps - this.headS(t)) > 6000) continue;
      const old = this.reports.find((r) => r.trip === t.trip && r.kind === "out");
      if (!old) {
        this.reports.push({ id: this.reportId++, no: t.no, trip: t.trip, portal: ex, kind: "out", state: "offered", t: this.time, respondAt: this.time + 10 + this.rand() * 35 });
        continue;
      }
      if (old.respondAt && this.time >= old.respondAt && old.state !== "accepted") {
        if (old.state === "offered" && this.rand() < this.ops.refuseP(ex)) {
          old.state = "refused";
          const why = ["Strecke noch belegt", "Gleis im Nachbarbahnhof besetzt", "Gegenzug muss erst durch"][Math.floor(this.rand() * 3)];
          old.note = why;
          old.respondAt = this.time + 120 + this.rand() * 240;
          this.log(`Zugmeldung: Fdl ${P.label} lehnt ${t.no} ab (${why}), erneut anbieten in ${Math.round((old.respondAt - this.time) / 60)} min`, "warn");
        } else {
          old.state = "accepted";
          old.respondAt = undefined;
          old.t = this.time;
        }
      }
    }
    // Alte Meldungen aufräumen
    if (this.reports.length > 80) {
      const live = new Set(this.trains.map((t) => t.trip));
      this.reports = this.reports.filter((r) => r.state === "offered" || live.has(r.trip) || this.pending.includes(r.trip) || this.time - r.t < 900);
    }
  }

  refuseReport(id: number, why: string): string | null {
    const r = this.reports.find((x) => x.id === id);
    if (!r || r.kind !== "in" || r.state !== "offered") return "Meldung nicht mehr offen";
    r.state = "refused";
    r.note = why;
    r.respondAt = this.time + 180;
    r.t = this.time;
    this.log(`Zugmeldung: ${r.no} von ${this.g.portals[r.portal].label} abgelehnt (${why}), Nachbar bietet in 3 min erneut an`, "info");
    return null;
  }

  outAccepted(t: Train): boolean {
    return this.reports.some((r) => r.trip === t.trip && r.kind === "out" && r.state === "accepted");
  }

  acceptReport(id: number): string | null {
    const r = this.reports.find((x) => x.id === id);
    if (!r || r.kind !== "in" || r.state !== "offered") return "Meldung nicht mehr offen";
    r.state = "accepted";
    r.t = this.time;
    this.log(`Zugmeldung: ${r.no} von ${this.g.portals[r.portal].label} angenommen`, "info");
    return null;
  }

  // ---------------- Dispositive Maßnahmen ----------------
  stS(st: string) { return this.g.stations[st].s ?? 0; }

  // Bahnhöfe, in denen der Zug vorzeitig wenden kann (Halt liegt vor dem Ziel und im Rückfahrplan)
  // Außerplanmäßiger Halt (Netzleitstelle): Zug hält zusätzlich an einem Bahnhof, durch den er sonst durchfährt
  addStop(t: Train, st: string, dwell = 60): string | null {
    if (t.stops.some((x, i) => i >= t.stopIdx && x.st === st && !x.done)) return `${t.no} hält dort ohnehin`;
    const d = (this.stS(st) - this.headS(t)) * t.dir;
    if (d < 1500) return `${t.no} ist schon zu nah dran oder vorbei`;
    const eta = this.time + d / Math.max(10, t.vmax * 0.8);
    const ns = { st, arr: eta, dep: eta + dwell, done: false, plan: this.planTrack(st, t.dir, t.trip.line, t.trip.to), extra: true } as any;
    const i = t.stops.findIndex((x, k) => k >= t.stopIdx && !x.done && (this.stS(x.st) - this.stS(st)) * t.dir > 0);
    if (i < 0) t.stops.push(ns); else t.stops.splice(i, 0, ns);
    this.log(`Disposition: ${t.no} hält außerplanmäßig in ${this.g.stations[st].name}`, "info");
    return null;
  }

  shortTurnOptions(t: Train): string[] {
    const nx = t.trip.turnInto;
    const rest = t.stops.slice(t.stopIdx, t.stops.length - (t.trip.exitPortal ? 0 : 1)).filter((x) => !x.done && !x.betr);
    const big = (st: string) => this.platformTracks(st).length >= 2;
    return rest.filter((x) => big(x.st) && this.exitBack(x.st, x.disp ?? x.plan, -t.dir as Dir) && (!nx || nx.dir === t.dir || nx.stops.some((y) => y.st === x.st))).map((x) => x.st);
  }
  // Hat das Bahnsteiggleis ein Ausfahrsignal in Gegenrichtung? (sonst kann dort kein Zug wenden)
  exitBack(st: string, track: string | undefined, dir: Dir): boolean {
    const g = this.g;
    const pe = g.edges.filter((E) => E.platform?.st === st && (!track || E.platform.track === track));
    if (!pe.length) return false;
    return pe.some((E) => {
      const y = g.nodes[E.a].y;
      const lo = Math.min(g.nodes[E.a].s ?? 0, g.nodes[E.b].s ?? 0) - 250, hi = Math.max(g.nodes[E.a].s ?? 0, g.nodes[E.b].s ?? 0) + 250;
      return g.signals.some((sg) => sg.dir === dir && g.nodes[sg.node].y === y && (g.nodes[sg.node].s ?? -1e9) >= lo && (g.nodes[sg.node].s ?? 1e9) <= hi);
    });
  }

  shortTurn(trainId: number, st: string): string | null {
    const t = this.trains.find((x) => x.id === trainId);
    if (!t) return "Zug nicht im Bereich";
    if (!this.shortTurnOptions(t).includes(st)) return "Dort ist keine vorzeitige Wende möglich";
    const i = t.stops.findIndex((x, k) => k >= t.stopIdx && x.st === st);
    const ti = t.trip.stops.findIndex((x) => x.st === st);
    const name = this.g.stations[st].name;
    const old = t.trip;
    const nx = old.turnInto && old.turnInto.dir !== old.dir ? old.turnInto : undefined;
    const trip: TripSpec = { ...old, stops: old.stops.slice(0, ti + 1), exitPortal: undefined, to: name, turnInto: undefined };
    if (nx) {
      const j = nx.stops.findIndex((x) => x.st === st);
      trip.turnInto = { ...nx, stops: nx.stops.slice(j), entryPortal: undefined, from: name, turnedFrom: trip };
    }
    t.trip = trip;
    t.stops = t.stops.slice(0, i + 1);
    // Steht der Zug schon dort, braucht er die Ausfahrt in die alte Richtung nicht mehr
    if (i === t.stopIdx && t.distNextSig < 1500) {
      const sg = this.il.sig(t.nextSig), r = this.il.routes.get(sg.route);
      if (r && !r.used) { this.il.cancel(sg.id); this.log(`Fahrstraße ${sg.name} zurückgenommen: ${t.no} wendet hier`, "info"); }
    }
    if (!nx) this.umlaufCancel(old, `endet vorzeitig in ${name}`);
    this.log(nx ? `Disposition: ${t.no} wendet vorzeitig in ${name} und fährt als ${nx.no} zurück (Halte dahinter entfallen)` : `Disposition: ${t.no} endet vorzeitig in ${name} (Teilausfall)`, "warn");
    return null;
  }

  cancelTrip(key: number): string | null {
    const trip = this.pending.find((x) => x.key === key);
    if (!trip) return "Zug ist schon unterwegs oder nicht gefunden";
    this.pending = this.pending.filter((x) => x !== trip);
    this.reports = this.reports.filter((r) => r.trip !== trip);
    this.log(`Disposition: ${trip.no} (${trip.from} → ${trip.to}) fällt aus`, "warn");
    this.umlaufCancel(trip, "Ausfall");
    return null;
  }

  // Bahnhöfe mit mindestens drei Bahnsteiggleisen, in denen ein Zug überholt werden kann
  overtakeStations(t: Train): string[] {
    const hs = this.headS(t);
    // Überholgleis muss lang genug für den Zug sein (lange Güterzüge passen nicht überall)
    return Object.keys(this.g.stations).filter((st) => this.platformTracks(st).length >= 3 && this.platformTracks(st).filter((x) => x.len >= t.len + 20).length >= 2 && (this.stS(st) - hs) * t.dir > 300 && (this.stS(st) - hs) * t.dir < 30000);
  }
  // Züge, die t überholen könnten: gleiche Richtung, dahinter
  overtakers(t: Train): Train[] {
    const hs = this.headS(t);
    return this.trains.filter((o) => o !== t && o.dir === t.dir && (hs - this.headS(o)) * t.dir > 0 && (hs - this.headS(o)) * t.dir < 25000 && this.passesBeyond(o, hs + 2000 * t.dir));
  }
  // fährt der Zug in seiner jetzigen Richtung noch über den Streckenpunkt s hinaus (endet/wendet nicht vorher)?
  passesBeyond(o: Train, s: number): boolean {
    if (o.trip.exitPortal) return true;
    const last = o.stops[o.stops.length - 1];
    return !!last && (this.stS(last.st) - s) * o.dir > 300;
  }

  overtake(trainId: number, st: string, otherId: number): string | null {
    const t = this.trains.find((x) => x.id === trainId), o = this.trains.find((x) => x.id === otherId);
    if (!t || !o) return "Zug nicht im Bereich";
    if (!this.overtakeStations(t).includes(st)) return "Überholung dort nicht möglich";
    if (!this.passesBeyond(o, this.stS(st))) return `${o.no} endet oder wendet vor ${this.g.stations[st].name} und kann dort nicht überholen`;
    let stop = t.stops.find((x, k) => k >= t.stopIdx && x.st === st && !x.done);
    if (!stop) {
      const eta = this.time + Math.abs(this.stS(st) - this.headS(t)) / Math.max(8, t.v);
      stop = { st, arr: eta, dep: eta, done: false, betr: true };
      let k = t.stopIdx;
      while (k < t.stops.length && (this.stS(t.stops[k].st) - this.stS(st)) * t.dir < 0) k++;
      t.stops.splice(k, 0, stop);
    }
    t.waitFor = { st, train: otherId, no: o.no };
    this.log(`Disposition: ${t.no} wird in ${this.g.stations[st].name} von ${o.no} überholt`, "info");
    return null;
  }

  // ---------------- Fahrstraßenspeicher (vorgemerkte Fahrstraßen) ----------------
  queued: { start: number; end: number | string; t: number }[] = [];
  canQueue(why: string) { return !/Keine Fahrstraße|endet hier|gesperrt \(|ist gesperrt|Annäherung/.test(why); }
  queueRoute(start: number, end: number | string): string | null {
    if (this.queued.some((q) => q.start === start)) return `Ab ${this.il.sig(start).name} ist schon eine Fahrstraße vorgemerkt`;
    this.queued.push({ start, end, t: this.time });
    const en = typeof end === "string" ? this.g.portals[end].label : this.il.sig(end).name;
    this.log(`Fahrstraße ${this.il.sig(start).name} → ${en} vorgemerkt`, "info");
    return null;
  }
  unqueue(start: number) { this.queued = this.queued.filter((q) => q.start !== start); }
  queuedPath(q: { start: number; end: number | string }): PathDef | undefined {
    const c = (this.il.paths.get(q.start) ?? []).filter((p) => (typeof q.end === "string" ? p.endPortal === q.end : p.endSig === q.end));
    return c.sort((a, b) => Number(a.diverging) - Number(b.diverging) || a.len - b.len)[0];
  }
  private queueTick() {
    for (const q of [...this.queued]) {
      if (this.il.sig(q.start).route) continue; // erst wenn die vorige Fahrstraße ab diesem Signal aufgelöst ist
      const why = this.setRoute(q.start, q.end);
      if (why && this.canQueue(why)) continue;
      this.queued = this.queued.filter((x) => x !== q);
      const en = typeof q.end === "string" ? this.g.portals[q.end].label : this.il.sig(q.end).name;
      this.log(why ? `Vorgemerkte Fahrstraße ${this.il.sig(q.start).name} → ${en} verworfen: ${why}` : `Vorgemerkte Fahrstraße ${this.il.sig(q.start).name} → ${en} eingestellt`, why ? "warn" : "good");
    }
  }

  // ---------------- Gleisänderung (Disposition) ----------------
  dispTrack = new Map<string, string>(); // "Fahrt-Schlüssel|Bahnhof" -> Gleis
  private ptCache = new Map<string, { track: string; len: number }[]>();
  platformTracks(st: string): { track: string; len: number }[] {
    const c = this.ptCache.get(st);
    if (c) return c;
    const r = this.platformTracksRaw(st);
    this.ptCache.set(st, r);
    return r;
  }
  private platformTracksRaw(st: string): { track: string; len: number }[] {
    const m = new Map<string, number>();
    for (const e of this.g.edges) if (e.platform?.st === st) m.set(e.platform.track, Math.max(m.get(e.platform.track) ?? 0, e.len));
    return [...m].map(([track, len]) => ({ track, len })).sort((a, b) => (parseInt(a.track) || 99) - (parseInt(b.track) || 99));
  }
  setTrack(tripKey: number, st: string, track: string | undefined): string | null {
    const t = this.trains.find((x) => x.trip.key === tripKey);
    const trip = t?.trip ?? this.allPending().find((x) => x.key === tripKey);
    if (!trip) return "Zug nicht gefunden";
    const stop = t ? t.stops.find((x) => x.st === st && !x.done) : trip.stops.find((x) => x.st === st);
    if (!stop) return "Halt schon vorbei";
    if (t && t.dwelling && t.stops[t.stopIdx] === stop) return "Zug steht bereits am Bahnsteig";
    if (track && !this.platformTracks(st).some((x) => x.track === track)) return "Gleis gibt es dort nicht";
    const k = `${tripKey}|${st}`;
    const plan = (stop as StopState).plan ?? this.planTrack(st, trip.dir, trip.line, trip.to);
    if (!track || track === plan) this.dispTrack.delete(k);
    else this.dispTrack.set(k, track);
    if (t) (stop as StopState).disp = this.dispTrack.get(k);
    const name = this.g.stations[st].name;
    this.log(track && track !== plan ? `Gleisänderung angeordnet: ${trip.no} hält in ${name} auf Gleis ${track} statt ${plan ?? "?"}` : `Gleisänderung aufgehoben: ${trip.no} hält in ${name} wieder auf Gleis ${plan ?? "?"}`, "info");
    return null;
  }
  allPending(): TripSpec[] { return this.pending; }

  // Anschluss halten: Abbringer wartet am Umsteigebahnhof
  holdConnection(id: number): string | null {
    const c = this.connAlerts.find((x) => x.id === id);
    if (!c) return "Anschluss nicht mehr aktuell";
    const b = this.trains.find((t) => t.id === c.conn);
    if (!b) return "Zug ist nicht mehr im Bereich";
    const sec = Math.min(20, Math.max(1, c.wait)) * 60;
    const stop = b.stops[b.stopIdx];
    if (b.dwelling && stop?.st === c.st) {
      b.dwellUntil = Math.max(b.dwellUntil, stop.dep + sec);
      this.cause(b, "Anschluss abgewartet (Disposition)", sec);
    } else if (b.stops.some((s, i) => i >= b.stopIdx && s.st === c.st && !s.done)) b.holdFor = { st: c.st, sec };
    else return `${b.no} ist schon abgefahren`;
    this.connAlerts = this.connAlerts.filter((x) => x !== c);
    this.log(`Disposition: ${b.no} wartet in ${this.g.stations[c.st].name} bis zu ${sec / 60} min auf den Anschluss`, "info");
    return null;
  }
  dropConnection(id: number) {
    const c = this.connAlerts.find((x) => x.id === id);
    if (!c) return;
    this.connAlerts = this.connAlerts.filter((x) => x !== c);
    const b = this.trains.find((t) => t.id === c.conn);
    this.log(`Disposition: Anschluss an ${b?.no ?? "?"} in ${this.g.stations[c.st].name} wird nicht gehalten`, "info");
  }

  // ---------------- Zugpersonal, Position, Zustand ----------------
  private crew(trip: TripSpec): { driver: string; tfz: string } {
    const first = ["Anna", "Jonas", "Mehmet", "Sabine", "Lukas", "Elif", "Thomas", "Katharina", "Dirk", "Nadine", "Paul", "Olga", "Marco", "Julia", "Sven", "Aylin", "Frank", "Lea", "Bernd", "Mia"];
    const last = ["Becker", "Schmitz", "Yilmaz", "Weber", "Hoffmann", "Krause", "Neumann", "Wagner", "Klein", "Lange", "Kowalski", "Brandt", "Schäfer", "Arslan", "Richter", "Vogel"];
    const r = rng(trip.key * 7919);
    const tfz = trip.cat === "S" ? "423" : trip.cat === "ICE" ? (r() < 0.5 ? "403" : "407") : trip.cat === "G" ? (r() < 0.5 ? "185" : "193") : trip.line === "RE9" ? "429" : trip.line === "RB90" || trip.line === "RB96" || trip.line === "RB97" ? "622" : "429";
    return { driver: `${first[Math.floor(r() * first.length)]} ${last[Math.floor(r() * last.length)]}`, tfz };
  }

  cause(t: Train, what: string, sec: number) {
    if (sec <= 0) return;
    t.causes[what] = (t.causes[what] ?? 0) + sec;
  }

  // Streckenmeter der Zugspitze
  headS(t: Train): number {
    const E = this.headEdge(t);
    const a = this.g.nodes[E.a], b = this.g.nodes[E.b];
    const f = Math.min(1, Math.max(0, t.headPos / E.len));
    const sa = a.s ?? 0, sb = b.s ?? 0;
    return t.dir > 0 ? sa + (sb - sa) * f : sb - (sb - sa) * f;
  }

  // Lage des Zuges in Worten
  position(t: Train): { km: number; text: string; track: string } {
    const g = this.g;
    const s = this.headS(t);
    const E = this.headEdge(t);
    const y = (g.nodes[E.a].y + g.nodes[E.b].y) / 2;
    const branch = y >= 10 && s > 7700;
    const st = Object.entries(g.stations).filter(([c]) => (["FH", "SM"].includes(c) ? branch : !branch || ["TR"].includes(c)));
    let before: [string, any] | undefined, after: [string, any] | undefined;
    for (const e of st) {
      const ss = e[1].s ?? 0;
      if (t.dir > 0 ? ss <= s : ss >= s) { if (!before || Math.abs(ss - s) < Math.abs((before[1].s ?? 0) - s)) before = e; }
      else if (!after || Math.abs(ss - s) < Math.abs((after[1].s ?? 0) - s)) after = e;
    }
    const near = [before, after].filter(Boolean).sort((p, q) => Math.abs(p![1].s - s) - Math.abs(q![1].s - s))[0];
    let text: string;
    if (E.platform) text = `im Bahnhof ${g.stations[E.platform.st].name}, Gleis ${E.platform.track}`;
    else if (near && Math.abs(near[1].s - s) < 450) text = `im Bereich ${near[1].name}`;
    else if (before && after) text = `zwischen ${before[1].name} und ${after[1].name}`;
    else if (after) text = `vor ${after[1].name}`;
    else if (before) text = `hinter ${before[1].name}`;
    else text = "auf der Strecke";
    const track = E.platform ? `Gleis ${E.platform.track}` : E.pref && E.pref !== t.dir ? "Gegengleis" : !Number.isInteger(y) ? "eingleisige Strecke" : "Regelgleis";
    return { km: s / 1000, text, track };
  }

  // Liste von Zuständen für das Zugfenster
  status(t: Train): { text: string; kind: "ok" | "warn" | "bad" | "info" }[] {
    const out: { text: string; kind: "ok" | "warn" | "bad" | "info" }[] = [];
    const ps = this.pendingStop(t);
    const E = this.headEdge(t);
    if (t.hold) out.push({ text: "Halt auf Anordnung (Funk)", kind: "warn" });
    if (t.fault && t.faultUntil > this.time) out.push({ text: t.faultUntil > this.time + 86400 ? t.fault : `${t.fault}, noch ca. ${Math.max(1, Math.round((t.faultUntil - this.time) / 60))} min`, kind: "bad" });
    if (t.rescue) out.push({ text: `Hilfslok für ${this.trains.find((x) => x.id === t.rescue)?.no ?? "?"}`, kind: "warn" });
    if (t.towed) out.push({ text: "Wird geschleppt bzw. fährt im Notbetrieb, höchstens 60 km/h", kind: "warn" });
    if (t.dwelling) {
      const isLast = t.stopIdx === t.stops.length - 1 && !t.trip.exitPortal;
      if (isLast && t.trip.turnInto) out.push({ text: `Endstation, wendet als ${t.trip.turnInto.no}${t.reverseAt ? ` um ${clock(t.reverseAt)}` : ""}`, kind: "info" });
      else if (isLast && t.bereit) { const q = this.pending.find((x) => x.key === t.bereit); out.push({ text: `Abgestellt, wird bereitgestellt als ${q?.no ?? "?"}${q ? ` (ab ${clock(q.stops[0].dep)})` : ""}`, kind: "info" }); }
      else if (isLast && t.parked) out.push({ text: "Abgestellt, wartet auf die nächste Leistung", kind: "info" });
      else if (isLast) out.push({ text: "Endstation, wird abgestellt", kind: "info" });
      else if (t.stopIdx === 0 && !t.trip.entryPortal && !t.trip.turnedFrom && this.time < t.dwellUntil) out.push({ text: `Bremsprobe und Vorbereitung, abfahrbereit ca. ${clock(t.dwellUntil)}`, kind: "info" });
      else if (this.time < t.dwellUntil) out.push({ text: `Fahrgastwechsel, Abfahrt ${clock(t.dwellUntil)}`, kind: "info" });
      else if (t.nextSig && !this.il.proceeds(this.il.sig(t.nextSig), this.time)) out.push({ text: `Abfahrbereit, wartet auf Ausfahrt ${this.il.sig(t.nextSig).name}`, kind: "warn" });
      else out.push({ text: "Abfahrbereit", kind: "ok" });
    } else if (t.v < 0.1) {
      if (t.nextSig && t.distNextSig < 60 && this.il.proceeds(this.il.sig(t.nextSig), this.time)) {
        if (!t.hold && !(t.faultUntil > this.time)) out.push({ text: `${this.il.sig(t.nextSig).name} zeigt Fahrt, Zug fährt an`, kind: "info" });
      } else if (t.nextSig && t.distNextSig < 60) out.push({ text: `Steht vor Halt zeigendem Signal ${this.il.sig(t.nextSig).name} ${t.waitRed < 60 ? "(gerade eben)" : `seit ${Math.floor(t.waitRed / 60)} min`}`, kind: t.waitRed > 120 ? "bad" : "warn" });
      else out.push({ text: "Steht", kind: "warn" });
    } else {
      out.push({ text: `Fährt ${Math.round(t.v * 3.6)} km/h (zulässig ${Math.round(Math.min(t.vmax * 3.6, vEdge(E)))})`, kind: "ok" });
      if (t.nextSig) {
        const a = this.il.aspect(this.il.sig(t.nextSig), this.time);
        const nm = this.il.sig(t.nextSig).name;
        if (a.stop) out.push({ text: `Bremst: ${nm} zeigt Halt (${Math.round(t.distNextSig)} m)`, kind: "warn" });
        else out.push({ text: `${nm} zeigt Fahrt${a.zs3 ? ` mit ${a.zs3 * 10} km/h` : ""}${a.expectStop ? ", Halt erwarten" : ""}`, kind: "info" });
      }
    }
    if (t.sight) out.push({ text: "Fahrt auf Sicht (Ersatzsignal)", kind: "warn" });
    if (t.body.some((e) => this.g.edges[e].slow)) out.push({ text: `In Langsamfahrstelle ${Math.min(...t.body.map((e) => this.g.edges[e].slow ?? 999))} km/h`, kind: "warn" });
    if (t.medStop) out.push({ text: `Rettungsdienst erwartet den Zug in ${this.g.stations[t.medStop.st].name}`, kind: "warn" });
    if (t.holdFor) out.push({ text: `Wartet in ${this.g.stations[t.holdFor.st].name} ${Math.round(t.holdFor.sec / 60)} min auf Anschluss`, kind: "info" });
    if (t.extraDwell) out.push({ text: `Wartet beim nächsten Halt ${Math.round(t.extraDwell / 60)} min auf Anschluss`, kind: "info" });
    if (ps && !t.dwelling) {
      out.push({ text: `Nächster Halt ${this.g.stations[ps.st].name} plan ${clock(ps.arr)}, erwartet ${clock(this.eta(t, ps))}`, kind: "info" });
    }
    if (t.trip.exitPortal && !ps) out.push({ text: `Verlässt den Bereich Richtung ${this.g.portals[t.trip.exitPortal].label}`, kind: "info" });
    return out;
  }

  // Prognose für die Ankunft an einem Halt: planmäßige Zeit plus aktuelle Verspätung (mit Fahrzeitreserve 10 %)
  eta(t: Train, st: StopState): number {
    if (st.actArr !== undefined) return st.actArr;
    const idx = t.stops.indexOf(st);
    const legs = Math.max(0, idx - t.stopIdx);
    const late = Math.max(0, this.liveDelay(t) - legs * 30);
    return st.arr + late;
  }

  // laufende Verspätung (auch während der Fahrt)
  liveDelay(t: Train): number {
    const ps = t.stops[t.stopIdx];
    if (!ps) return t.delay;
    const isLast = t.stopIdx === t.stops.length - 1 && !t.trip.exitPortal;
    if (t.dwelling && isLast) return Math.max(0, (ps.actArr ?? ps.arr) - ps.arr);
    if (t.dwelling) return Math.max(t.delay, this.time - ps.dep);
    // Fahrzeit bis zum nächsten Halt grob schätzen
    const dist = Math.abs((this.g.stations[ps.st].s ?? 0) - this.headS(t));
    const v = Math.max(8, Math.min(t.vmax, 30));
    return Math.max(t.delay, this.time + dist / v - ps.arr);
  }

  upcoming(limit = 30): TripSpec[] {
    return this.pending.slice(0, limit);
  }

  trainOnEdge(e: number): Train | undefined {
    return this.trains.find((t) => t.body.includes(e));
  }
}
