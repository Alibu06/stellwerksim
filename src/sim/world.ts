import { Extras } from "./extras";
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
  stillT?: number; // Sekunden Stillstand außerhalb des Bahnsteighalts
  reverseAt: number; // geplante Wende
  dissolveAt: number; // Abstellung
  fault?: string; // aktuelle Störung am Zug
  faultUntil: number;
  sight: boolean; // Fahrt auf Sicht nach Ersatzsignal
  hold: boolean; // Halt auf Anordnung des Fahrdienstleiters (Funk)
  causes: Record<string, number>; // erfasste Wartezeiten nach Ursache (Sekunden)
  reason?: string; // vom Fahrdienstleiter eingetragene Verspätungsursache
  reasonNote?: string;
  extraDwell: number; // Anschluss abwarten (Sekunden, beim nächsten Halt)
  holdFor?: { st: string; sec: number };
  waitFor?: { st: string; train: number; since?: number; no?: string }; // Überholung abwarten
  shunt?: { edges: number[]; label: string; rev?: ShuntTarget["rev"] }; // laufende Rangierfahrt
  shunted?: boolean; // Anschluss abwarten an bestimmtem Bahnhof (Disposition)
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
  kind: "switch" | "signal" | "door" | "vehicle" | "bue" | "event";
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
  connAlerts: { id: number; feeder: number; conn: number; st: string; t: number; wait: number }[] = [];

  constructor(public g: Graph, trips: TripSpec[], startTime: number) {
    this.il = new Interlocking(g);
    this.time = startTime;
    this.findSingleTracks();
    this.ext = new Extras(this);
    // Züge, deren Fahrt bei Spielbeginn schon vorbei ist, entfallen; Wendezüge werden vom Vorgänger übernommen
    this.pending = trips.filter((t) => !t.turnedFrom && t.entryTime + t.initialDelay >= startTime - 60);
  }

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
    this.spawn();
    for (const t of this.trains) this.drive(t, dt);
    this.trains = this.trains.filter((t) => !t.gone);
    this.faultTimer += dt;
    if (this.faultTimer >= 10) {
      this.faultTimer = 0;
      this.faultsTick();
    }
    this.zlTimer += dt;
    if (this.zlTimer >= 2) {
      this.zlTimer = 0;
      this.autoRoutes();
      this.queueTick();
    }
  }

  // ---------------- Züge einsetzen ----------------
  private spawn() {
    while (this.pending.length && this.pending[0].entryTime + this.pending[0].initialDelay <= this.time) {
      const trip = this.pending[0];
      const ok = trip.entryPortal ? this.spawnAtPortal(trip) : this.spawnAtPlatform(trip);
      if (!ok) {
        // Einbruch nicht möglich (Gleis belegt): später erneut versuchen
        trip.initialDelay += 20;
        this.pending.sort((a, b) => a.entryTime + a.initialDelay - (b.entryTime + b.initialDelay));
        if (this.pending[0] === trip) break;
        continue;
      }
      this.pending.shift();
    }
  }

  private newTrain(trip: TripSpec, body: number[], headPos: number): Train {
    const t: Train = {
      id: this.nextTrainId++, trip, no: trip.no, cat: trip.cat, len: trip.len, vmax: trip.vmax / 3.6,
      acc: trip.acc, dec: trip.dec, v: 0, dir: trip.dir, body, headPos,
      stops: trip.stops.map((s) => ({ ...s, done: false, plan: this.planTrack(s.st, trip.dir, trip.line, trip.to) })), stopIdx: 0, dwellUntil: 0, dwelling: false,
      exiting: false, gone: false, delay: trip.initialDelay, delayIn: trip.initialDelay, nextSig: 0, distNextSig: Infinity,
      stopAheadIsPlatform: false, waitRed: 0, standStill: 0, reverseAt: 0, dissolveAt: 0, faultUntil: 0, sight: false, hold: false, causes: trip.initialDelay > 60 ? { "Verspätung aus dem Vorbereich": trip.initialDelay } : {}, extraDwell: 0, radio: [], ...this.crew(trip),
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
    return true;
  }

  // Regelgleis eines Bahnhofs je Fahrtrichtung (durchgehendes Hauptgleis mit Bahnsteig, sonst kleinste Gleisnummer)
  private planCache = new Map<string, string | undefined>();
  trackPlan?: Record<string, string>; // Regelgleise je Linie|Richtung|Bahnhof (aus data/tracks.json)
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
    if (t.sight) vLimit = Math.min(vLimit, 40 / 3.6);
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
      } else limits.push({ d, v: vEdge(NE) / 3.6 });
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
    if (t.stillT > 25 && t.v < 0.05) this.il.releaseOverlapForTrain(t.id);
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
        if (t.standStill > 20) this.il.releaseOverlapForTrain(t.id);
      }
      if (la.platformStop && la.stopDist < 4) this.arrive(t, false);
      return;
    }
    t.standStill = 0;
    t.waitRed = 0;
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
        } else t.sight = false;
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
        this.vacate(t.body.shift()!);
      } else {
        if (t.exiting && t.headPos - this.headEdge(t).len >= t.len) {
          this.vacate(t.body.shift()!);
          this.finish(t, true);
        }
        break;
      }
    }
  }

  private vacate(e: number) {
    const E = this.g.edges[e];
    E.occ--;
    if (E.occ <= 0) {
      E.occ = 0;
      this.il.edgeCleared(e);
    }
  }

  private enteredEdge(t: Train, e: number) {
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
    if (t.extraDwell > 0 && !startHere) {
      t.dwellUntil = Math.max(t.dwellUntil, s.dep + t.extraDwell);
      this.cause(t, "Anschluss abgewartet (Disposition)", Math.max(0, t.dwellUntil - Math.max(this.time + minDwell, s.dep)));
      t.extraDwell = 0;
    }
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
      if (s.actArr !== undefined && this.time - s.actArr > 30) this.il.releaseOverlapForTrain(t.id);
      if (t.trip.turnInto && this.time >= t.reverseAt) this.reverse(t, t.trip.turnInto);
      else if (!t.trip.turnInto && this.time >= t.dissolveAt) {
        for (const e of t.body) this.vacate(e);
        t.body = [];
        this.il.releaseTrain(t.id);
        this.finish(t, false);
      }
      return;
    }
    // Durchrutschweg hinter dem Bahnsteig nach 30 s Stillstand auflösen, damit die Weichen dahinter frei werden
    if (s.actArr !== undefined && this.time - s.actArr > 30) this.il.releaseOverlapForTrain(t.id);
    if (this.time < t.dwellUntil || t.hold) return;
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
      t.dissolveAt = this.time + 120;
      this.log(`${t.no} steht in ${sh.label} und wird abgestellt`, "good");
      return;
    }
    const allowed = Math.min(25 / 3.6, Math.sqrt(2 * t.dec * rem));
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
    t.stops = next.stops.map((s) => ({ ...s, done: false, plan: this.planTrack(s.st, next.dir, next.line, next.to) }));
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
    for (const p of cands) {
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

  // ---------------- Zuglenkung / Selbststellbetrieb ----------------
  private autoRoutes() {
    // Wartende Züge zuerst bedienen, dann nach Nähe zum Signal
    const cands = this.trains
      .filter((t) => t.nextSig && t.distNextSig < (t.v * t.v) / (2 * t.dec) + 1500)
      .sort((a, b) => b.waitRed - a.waitRed || a.distNextSig - b.distNextSig);
    for (const t of cands) {
      const s = this.il.sig(t.nextSig);
      if (!s.auto || s.route) continue;
      const paths = this.il.paths.get(s.id) ?? [];
      if (!paths.length) continue;
      if (s.kind === "block") {
        for (const p of paths) {
          if (p.endPortal && this.zugmeldung && !this.outAccepted(t)) continue;
          if (!this.il.check(p)) { this.il.set(p, this.time); break; }
        }
        continue;
      }
      if (t.stopAheadIsPlatform && !t.dwelling) continue;
      if (t.dwelling && t.dwellUntil - this.time > 40) continue;
      if (t.dwelling && t.stopIdx === t.stops.length - 1 && !t.trip.exitPortal) continue;
      const best = this.bestPath(t, paths);
      if (best) this.il.set(best, this.time);
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
      if (c > ideal * 1.25 + 800 + (t.waitRed > 120 ? 3000 : 0)) continue;
      if (this.singleTrackBlocked(t, p)) continue;
      if (p.endPortal && this.zugmeldung && !this.outAccepted(t)) continue;
      if (this.il.check(p)) continue;
      if (c < bestCost) {
        bestCost = c;
        best = p;
      }
    }
    return bestCost < 1e8 ? best : null;
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
    for (const S of this.singles) {
      if (!p.edges.some((e) => S.edges.has(e))) continue;
      const far = [...S.gates].filter(([, d]) => d !== t.dir);
      if (far.length < 2) continue;
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
      this.addFault("switch", n.id, this.time + dur, `Weichenstörung ${n.swName} (${this.nearStation(n.x)}): lässt sich nicht umstellen, Techniker ca. ${Math.round(dur / 60)} min`);
    }
    // Signalstörung: etwa alle 120 min
    if (r() < (k * W.sig) / 120) {
      const sg = this.g.signals.filter((x) => !this.il.faultySignals.has(x.id) && !x.route && !this.trains.some((t) => t.nextSig === x.id && t.distNextSig < this.brakeDist(t) + 300));
      const s = sg[Math.floor(r() * sg.length)];
      const dur = 600 + Math.floor(r() * 1200);
      this.il.faultySignals.add(s.id);
      this.addFault("signal", s.id, this.time + dur, `Signalstörung ${s.name}: zeigt keine Fahrt, Ersatzsignal geben (Strg + Klick), ca. ${Math.round(dur / 60)} min`);
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
  }

  // Ersatzsignal (Zs1) für einen Zug am Signal
  giveZs1(sid: number): string | null {
    const s = this.il.sig(sid);
    if (this.il.proceeds(s, this.time)) return "Signal zeigt bereits Fahrt";
    const t = this.trains.find((t) => t.nextSig === sid && t.distNextSig < 400);
    if (!t) return "Kein Zug steht vor diesem Signal";
    if (!s.route) {
      // Ohne Fahrstraße nur, wenn die Weichen einen Fahrweg bilden, der nicht in eine andere Fahrstraße führt
      const ok = (this.il.paths.get(sid) ?? []).some((p) =>
        p.sw.every(({ node, pos }) => this.g.nodes[node].swPos === pos) &&
        p.edges.every((e) => !this.g.edges[e].lock && !this.g.edges[e].closed));
      if (!ok) return "Kein gesicherter Fahrweg: erst Fahrstraße einstellen (geht auch bei Signalstörung) oder Weichen passend stellen";
    }
    this.il.zs1.set(sid, this.time + 90);
    this.log(`Ersatzsignal an ${s.name} für ${t.no}`, "info");
    return null;
  }

  // ---------------- Zugmeldungen ----------------
  private reportsTick() {
    // Nachbar bietet einfahrende Züge etwa 4 Minuten vor Einfahrt an
    for (const trip of this.pending) {
      if (!trip.entryPortal) continue;
      const at = trip.entryTime + trip.initialDelay;
      if (at - 240 > this.time) break;
      if (this.reports.some((r) => r.trip === trip && r.kind === "in")) continue;
      const auto = !this.manualAreas.has(PORTAL_AREA[trip.entryPortal] ?? "");
      const r: Report = { id: this.reportId++, no: trip.no, trip, portal: trip.entryPortal, kind: "in", state: auto ? "accepted" : "offered", t: this.time };
      this.reports.push(r);
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
        if (old.state === "offered" && this.rand() < 0.07) {
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
  shortTurnOptions(t: Train): string[] {
    const nx = t.trip.turnInto;
    const rest = t.stops.slice(t.stopIdx, t.stops.length - (t.trip.exitPortal ? 0 : 1)).filter((x) => !x.done && !x.betr);
    const big = (st: string) => this.platformTracks(st).length >= 2;
    return rest.filter((x) => big(x.st) && (!nx || nx.dir === t.dir || nx.stops.some((y) => y.st === x.st))).map((x) => x.st);
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
    this.log(nx ? `Disposition: ${t.no} wendet vorzeitig in ${name} und fährt als ${nx.no} zurück (Halte dahinter entfallen)` : `Disposition: ${t.no} endet vorzeitig in ${name} (Teilausfall)`, "warn");
    return null;
  }

  cancelTrip(key: number): string | null {
    const trip = this.pending.find((x) => x.key === key);
    if (!trip) return "Zug ist schon unterwegs oder nicht gefunden";
    this.pending = this.pending.filter((x) => x !== trip);
    this.reports = this.reports.filter((r) => r.trip !== trip);
    this.log(`Disposition: ${trip.no} (${trip.from} → ${trip.to}) fällt aus`, "warn");
    return null;
  }

  // Bahnhöfe mit mindestens drei Bahnsteiggleisen, in denen ein Zug überholt werden kann
  overtakeStations(t: Train): string[] {
    const hs = this.headS(t);
    return Object.keys(this.g.stations).filter((st) => this.platformTracks(st).length >= 3 && (this.stS(st) - hs) * t.dir > 300 && (this.stS(st) - hs) * t.dir < 30000);
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
    if (t.fault && t.faultUntil > this.time) out.push({ text: `${t.fault}, noch ca. ${Math.max(1, Math.round((t.faultUntil - this.time) / 60))} min`, kind: "bad" });
    if (t.dwelling) {
      const isLast = t.stopIdx === t.stops.length - 1 && !t.trip.exitPortal;
      if (isLast && t.trip.turnInto) out.push({ text: `Endstation, wendet als ${t.trip.turnInto.no}${t.reverseAt ? ` um ${clock(t.reverseAt)}` : ""}`, kind: "info" });
      else if (isLast) out.push({ text: "Endstation, wird abgestellt", kind: "info" });
      else if (this.time < t.dwellUntil) out.push({ text: `Fahrgastwechsel, Abfahrt ${clock(t.dwellUntil)}`, kind: "info" });
      else if (t.nextSig && !this.il.proceeds(this.il.sig(t.nextSig), this.time)) out.push({ text: `Abfahrbereit, wartet auf Ausfahrt ${this.il.sig(t.nextSig).name}`, kind: "warn" });
      else out.push({ text: "Abfahrbereit", kind: "ok" });
    } else if (t.v < 0.1) {
      if (t.nextSig && t.distNextSig < 60) out.push({ text: `Steht vor Halt zeigendem Signal ${this.il.sig(t.nextSig).name} ${t.waitRed < 60 ? "(gerade eben)" : `seit ${Math.floor(t.waitRed / 60)} min`}`, kind: t.waitRed > 120 ? "bad" : "warn" });
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
