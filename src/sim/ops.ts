import { PathDef } from "./interlocking";
import { TripSpec } from "./timetable";
import { Train, World } from "./world";
import { SECTIONS } from "./extras";

// Betriebsführung rund um den Fahrdienstleiter: Netzleitstelle (Anrufe, Weisungen, Sonderzüge, Umleitungen, SEV),
// Personaldisposition (Ablösung), Lademaßüberschreitungen und das Verhalten der Nachbarstellwerke.

export interface Call {
  id: number; t: number; from: string; text: string; kind: string;
  opts: { k: string; label: string }[]; answered?: string; expires: number; data?: any;
}

// Schienenersatzverkehr: ein Bus je gewendetem Zug, fährt zum anderen Ende der Sperrung
export interface Bus { id: number; no: string; from: string; to: string; dep: number; arr: number; pax: number; feeder: string; done?: boolean; result?: string }

// Rotte: Arbeitstrupp an der Strecke, gesichert durch einen Sicherungsposten (warnt mit Signalhorn vor Zügen)
export interface Rotte {
  name: string; men: number; job: string; a: string; b: string; lane: number; s: number; edges: number[];
  phase: number; // 0 angemeldet, 1 arbeitet neben dem Gleis, 2 wartet auf Sperrung, 3 Gleis gesperrt, 4 meldet Ende der Sperrung, 5 Restarbeiten
  at: number; until: number; prev: [number, { slow?: number; closed?: boolean }][]; seen: number[]; asked: number;
}

const hm = (t: number) => `${String(Math.floor(((t % 86400) + 86400) % 86400 / 3600)).padStart(2, "0")}:${String(Math.floor(t / 60) % 60).padStart(2, "0")}`;

export class Ops {
  calls: Call[] = [];
  id = 1;
  sev: { a: string; b: string; until: number }[] = [];
  crewChange = new Map<number, string>(); // Fahrt -> Bahnhof mit Personalwechsel
  crewDone = new Set<number>();
  hapSeen = new Set<number>();
  ovAsked = new Set<string>();
  nextNlz = 0;
  nextSpecial = 0;
  nextNotruf = 0;
  notruf?: { s: number; reason: string; trains: number[]; clearAt: number; from: string; phase: number };
  specialKey = 900000;
  nextRotte = 0;
  buses: Bus[] = [];
  busNo = 1;
  rotte?: Rotte;
  private timer = 0;
  // Persönlichkeit der Nachbar-Fdl: wie früh sie anbieten, wie oft sie ablehnen, wie oft sie etwas vergessen
  neighbors: Record<string, { lead: number; refuse: number; forget: number }> = {};

  constructor(private w: World) {}

  private get rand() { return (this.w as any).rand as () => number; }

  private all: TripSpec[] = [];
  start(trips: TripSpec[]) {
    this.all = trips;
    const r = this.rand;
    for (const t of trips) {
      if (t.cat === "G" && r() < 0.08) t.special = "Lü";
      if (t.cat !== "G" && t.cat !== "S" && r() < 0.15) {
        const st = t.stops.slice(1, -1).find((s) => ["AU", "SB", "BZ"].includes(s.st));
        if (st) this.crewChange.set(t.key, st.st);
      }
    }
    this.addUebergaben(trips);
    for (const p of Object.keys(this.w.g.portals)) this.neighbors[p] = { lead: 180 + r() * 300, refuse: 0.02 + r() * 0.12, forget: r() * 0.05 };
    this.nextNlz = this.w.time + 600 + r() * 900;
    this.nextSpecial = this.w.time + 1800 + r() * 3600;
    this.nextNotruf = this.w.time + 5400 + r() * 9000;
    this.nextRotte = this.w.time + 1800 + r() * 5400;
  }

  // Übergabegüterzüge Betzdorf <-> Köln-Gremberg: beginnen/enden im Bereich (Bremsprobe, Abstellung im Güterbahnhof)
  private addUebergaben(trips: TripSpec[]) {
    const w = this.w;
    const west = trips.find((t) => t.cat === "G" && t.exitPortal === "W_M" && t.entryPortal === "E_BZ");
    const east = trips.find((t) => t.cat === "G" && t.entryPortal === "W_M" && t.exitPortal === "E_BZ");
    if (!west || !east) return;
    const P = (w as any).pending as TripSpec[];
    const mk = (base: TripSpec, no: string, t0: number, start: boolean): TripSpec => ({
      ...base, key: this.specialKey++, no, len: 240, vmax: 100, mass: 950, initialDelay: 0, special: "Übergabe", turnInto: undefined, turnedFrom: undefined,
      entryPortal: start ? undefined : base.entryPortal, exitPortal: start ? base.exitPortal : undefined,
      entryTime: start ? t0 - 900 : t0, stops: [{ st: "BZ", arr: t0, dep: t0 } as any],
      from: start ? "Betzdorf (Sieg) Gbf" : base.from, to: start ? base.to : "Betzdorf (Sieg) Gbf",
    });
    const add: TripSpec[] = [];
    // morgens und nachmittags hin, später zurück
    for (const [h, n] of [[5.2, 1], [13.4, 3]] as const) add.push(mk(east, `EK 5530${n}`, h * 3600, false));
    for (const [h, n] of [[9.1, 2], [17.6, 4]] as const) add.push(mk(west, `EK 5530${n}`, h * 3600, true));
    for (const t of add) {
      if (t.entryPortal) t.stops[0].arr = t.stops[0].dep = t.entryTime + 3600; // Ankunft im Gbf nach Fahrt durch den Bereich
      if (t.entryTime + 600 >= w.time) P.push(t);
    }
    P.sort((a, b) => a.entryTime + a.initialDelay - (b.entryTime + b.initialDelay));
  }

  call(from: string, kind: string, text: string, opts: { k: string; label: string }[], ttl = 300, data?: any): Call {
    const c: Call = { id: this.id++, t: this.w.time, from, kind, text, opts, expires: this.w.time + ttl, data };
    this.calls.push(c);
    if (this.calls.length > 60) this.calls.shift();
    this.w.log(`☎ ${from}: ${text}`, "warn");
    return c;
  }

  answer(id: number, k: string): string | null {
    const c = this.calls.find((x) => x.id === id);
    if (!c || c.answered) return "Gespräch ist schon beendet";
    c.answered = k;
    return this.resolve(c, k, false);
  }

  private resolve(c: Call, k: string, timeout: boolean): string | null {
    const w = this.w;
    const D = c.data ?? {};
    const tr = (id: number) => w.trains.find((t) => t.id === id);
    switch (c.kind) {
      case "prognose": {
        const t = tr(D.train);
        if (timeout) { w.score.points -= 5; w.log(`Netzleitstelle hat keine Prognose für ${D.no} erhalten (−5 Punkte)`, "warn"); return null; }
        if (!t) return "Zug ist nicht mehr im Bereich";
        const s = t.stops.find((x) => x.st === D.st && !x.done);
        const eta = s ? w.eta(t, s) : w.time;
        w.score.points += 5;
        w.log(`Du an Netzleitstelle: ${t.no} voraussichtlich ${hm(eta)} in ${w.g.stations[D.st].name} (+${Math.max(0, Math.round((eta - (s?.arr ?? eta)) / 60))} min). Danke!`, "good");
        return null;
      }
      case "vorrang": {
        if (k === "ok") return w.overtake(D.slow, D.st, D.fast);
        if (k === "nein") { w.log(`Du an Netzleitstelle: Überholung von ${D.slowNo} durch ${D.fastNo} ist nicht möglich`, "info"); return null; }
        if (timeout) { w.score.points -= 5; w.log("Netzleitstelle: Weisung zur Zugreihenfolge blieb unbeantwortet (−5 Punkte)", "warn"); }
        return null;
      }
      case "sonder": {
        this.addSpecial(D);
        if (!timeout) w.log(`Du an Netzleitstelle: ${D.no} verstanden, wird eingelegt`, "info");
        return null;
      }
      case "sperrung": {
        if (k === "sev" || timeout) this.applyDiversion(D, timeout);
        else w.log("Du an Netzleitstelle: Wir warten die Sperrung ab, keine Umleitung", "info");
        return null;
      }
      case "notruf": {
        if (timeout) { w.score.points -= 10; w.log("GSM-R-Notruf wurde nicht quittiert (−10 Punkte)", "warn"); }
        else w.log("Du: Notruf verstanden, alle Züge im Bereich bleiben stehen", "info");
        return null;
      }
      case "notrufende": {
        const n = this.notruf;
        if (!n) return null;
        if (k === "sperren") {
          n.clearAt = w.time + 900; n.phase = 1;
          w.log(`Abschnitt bei km ${(n.s / 1000).toFixed(1).replace(".", ",")} bleibt gesperrt, Polizei und Notfallmanager sind unterwegs (ca. 15 min)`, "info");
          w.note("Notruf", `Abschnitt nach GSM-R-Notruf (${n.reason}) vorübergehend gesperrt`);
          return null;
        }
        this.notrufRelease(timeout);
        return null;
      }
      case "rotte": {
        const R = this.rotte;
        if (!R) return null;
        if (k === "spaeter" || timeout) { this.rotte = undefined; w.log(timeout ? "Rotte hat keine Arbeitserlaubnis bekommen und fängt später an" : "Du an Rotte: Jetzt nicht, bitte in einer Stunde noch einmal melden", "info"); this.nextRotte = w.time + 3600; return null; }
        this.rotteBegin();
        return null;
      }
      case "rottesperr": {
        const R = this.rotte;
        if (!R || R.phase !== 2) return null;
        if (k === "sperren") { R.phase = 3; R.at = 0; w.log(`Du an Rotte: Gleis wird gesperrt, sobald es frei ist. Erst nach meiner Bestätigung ins Gleis gehen!`, "info"); return null; }
        if (k === "spaeter") { R.phase = 1; R.asked = w.time + 600; w.log("Du an Rotte: Noch nicht, erst nach dem nächsten Zug. Ich melde mich", "info"); return null; }
        R.phase = 5; R.until = w.time + 900;
        w.log(timeout ? "Rotte hat keine Antwort bekommen und arbeitet nur neben dem Gleis weiter" : "Du an Rotte: Sperrung heute nicht möglich, bitte nur neben dem Gleis arbeiten", "info");
        return null;
      }
      case "rotteende": {
        if (timeout) { w.score.points -= 5; w.log("Gleissperrung für die Rotte wurde erst verspätet aufgehoben (−5 Punkte)", "warn"); }
        this.rotteUnlock();
        return null;
      }
      case "liegen": {
        w.rescueRequest(D.train, k === "nochmal" && !timeout, k === "techniker" && !timeout);
        if (timeout) w.log("Notfallmanager hat die Hilfslok selbst angefordert", "info");
        return null;
      }
      case "hilfslok": {
        const R = w.rescues.find((x) => x.broken === D.train);
        if (!R) return null;
        if (k === "warten" && !timeout) { R.phase = 2; R.at = w.time + 180; return null; }
        const why = w.rescueGo(D.train);
        if (why) w.log(`Sperrfahrt noch nicht möglich: ${why}. Neuer Versuch gleich`, "warn");
        return null;
      }
      case "personal": {
        const t = tr(D.train);
        if (!t) return "Zug ist nicht mehr im Bereich";
        if (k === "ende") return w.shortTurn(t.id, D.st);
        t.dwellUntil = Math.max(t.dwellUntil, w.time + D.wait);
        w.cause(t, "Personal (Ablösung verspätet)", D.wait);
        w.log(`${t.no} wartet in ${w.g.stations[D.st].name} auf den Ersatz-Tf (ca. ${Math.round(D.wait / 60)} min)`, "info");
        return null;
      }
      default: return this.w.life.resolve(c, k, timeout);
    }
    return null;
  }

  step(dt: number) {
    this.timer += dt;
    if (this.timer < 5) return;
    this.timer = 0;
    const w = this.w;
    for (const c of this.calls) if (!c.answered && c.expires <= w.time) { c.answered = "timeout"; this.resolve(c, c.opts[0]?.k ?? "", true); }
    if (w.time >= this.nextNlz) { this.nlzCall(); this.nextNlz = w.time + 1200 + this.rand() * 1800; }
    if (w.time >= this.nextSpecial) { this.specialCall(); this.nextSpecial = w.time + 3600 + this.rand() * 3600; }
    if (w.time >= this.nextNotruf) { if (w.faultRate > 0) this.notrufStart(); this.nextNotruf = w.time + (10800 + this.rand() * 14400) / Math.max(0.3, w.faultRate); }
    this.notrufTick();
    if (w.time >= this.nextRotte) { if (w.ext.f.baustellen && !this.rotte) this.rotteStart(); this.nextRotte = w.time + 3 * 3600 + this.rand() * 4 * 3600; }
    this.rotteTick();
    this.closures();
    this.sevTick();
    this.busTick();
    this.crewTick();
  }

  private mine(st: string) { return this.w.manualAreas.has(st); }

  // Netzleitstelle: Prognoseanfrage oder Weisung zur Zugreihenfolge
  private nlzCall() {
    const w = this.w, r = this.rand;
    if (r() < 0.55) {
      const cand = w.trains.filter((t) => t.cat !== "G" && t.stops.some((s, i) => i >= t.stopIdx && !s.done && this.mine(s.st)));
      const t = cand[Math.floor(r() * cand.length)];
      if (!t) return;
      const s = t.stops.find((x, i) => i >= t.stopIdx && !x.done && this.mine(x.st))!;
      this.call("Netzleitstelle", "prognose", `Wie sieht es mit ${t.no} aus? Wann ist er in ${w.g.stations[s.st].name}?`, [{ k: "ok", label: "Prognose durchgeben" }], 300, { train: t.id, no: t.no, st: s.st });
    } else {
      for (const slow of w.trains) {
        if (slow.cat !== "G" && slow.cat !== "RB" && slow.cat !== "S") continue;
        const fast = w.overtakers(slow).find((o) => (o.cat === "ICE" || o.cat === "RE") && o.vmax > slow.vmax);
        if (!fast || this.ovAsked.has(`${slow.id}-${fast.id}`)) continue;
        const st = w.overtakeStations(slow).find((x) => this.mine(x) && w.passesBeyond(fast, w.stS(x)));
        if (!st) continue;
        this.ovAsked.add(`${slow.id}-${fast.id}`);
        this.call("Netzleitstelle", "vorrang", `${fast.no} hat Vorrang. Bitte ${slow.no} in ${w.g.stations[st].name} überholen lassen.`, [{ k: "ok", label: "Überholung anordnen" }, { k: "nein", label: "Geht nicht" }], 240,
          { slow: slow.id, slowNo: slow.no, fast: fast.id, fastNo: fast.no, st });
        return;
      }
    }
  }

  // GSM-R-Notruf: ein Tf meldet eine Gefahr, alle Züge in der Nähe halten sofort
  private notrufStart() {
    const w = this.w, r = this.rand;
    if (this.notruf) return;
    const cand = w.trains.filter((t) => t.v > 10 && !t.exiting && !t.shunt);
    const t = cand[Math.floor(r() * cand.length)];
    if (!t) return;
    const s = w.headS(t);
    const reasons = ["Personen im Gleis", "Gegenstand im Gleis (Äste nach Sturm)", "Tiere im Gleis (Rinder auf der Strecke)", "Kinder an der Strecke, spielen am Gleis"];
    const reason = reasons[Math.floor(r() * reasons.length)];
    const near = w.trains.filter((o) => Math.abs(w.headS(o) - s) < 4500 && !o.shunt && !o.parked);
    for (const o of near) {
      o.hold = true;
      o.radio.push({ t: w.time, from: "tf", text: o === t ? `Notruf, Notruf! Hier ${t.no} bei km ${(s / 1000).toFixed(1).replace(".", ",")}: ${reason}! Alle Züge sofort anhalten!` : `${o.no}: Notruf gehört, ich halte an.` });
    }
    const km = (s / 1000).toFixed(1).replace(".", ",");
    this.notruf = { s, reason, trains: near.map((o) => o.id), clearAt: w.time + 300 + r() * 420, from: t.no, phase: 0 };
    w.log(`GSM-R-Notruf von ${t.no} bei km ${km} (${w.nearStation(w.g.nodes[w.g.edges[t.body[t.body.length - 1]].a].x)}): ${reason}. ${near.length} Züge halten sofort`, "bad");
    w.note("Notruf", `GSM-R-Notruf von ${t.no} bei km ${km}: ${reason}`);
    this.call(`GSM-R-Notruf (${t.no})`, "notruf", `Notruf bei km ${km}: ${reason}. Alle Züge im Umkreis haben eine Zwangsbremsung eingeleitet und stehen.`, [{ k: "ok", label: "Notruf quittieren" }], 90);
  }
  private notrufTick() {
    const n = this.notruf, w = this.w;
    if (!n || w.time < n.clearAt) return;
    if (n.phase === 0) {
      n.phase = 2; n.clearAt = Infinity;
      const t = w.trains.find((x) => x.no === n.from);
      if (t) t.radio.push({ t: w.time, from: "tf", text: `${t.no}: Die Lage hat sich geklärt (${n.reason}), die Gefahr ist vorbei.` });
      this.call(`GSM-R (${n.from})`, "notrufende", `${n.from} meldet: Gefahr vorbei. Wie geht es weiter? Die Züge dürfen nur auf Sicht weiter, bis sie am nächsten Hauptsignal sind.`,
        [{ k: "sicht", label: "Züge auf Sicht weiterfahren lassen" }, { k: "sperren", label: "Abschnitt noch sperren" }], 240);
    } else if (n.phase === 1) this.notrufRelease(true);
  }
  private notrufRelease(auto: boolean) {
    const n = this.notruf, w = this.w;
    if (!n) return;
    let k = 0;
    for (const id of n.trains) {
      const t = w.trains.find((x) => x.id === id);
      if (!t) continue;
      t.hold = false; t.sight = true; t.orderV = 40; k++;
      t.radio.push({ t: w.time, from: "fdl", text: `${t.no}, Notruf ist aufgehoben. Fahren Sie bis zum nächsten Hauptsignal auf Sicht, höchstens 40 km/h.` });
    }
    w.log(`${auto ? "Notfallmanager: " : ""}Notruf aufgehoben, ${k} Züge fahren auf Sicht weiter`, "good");
    w.note("Notruf", `Notruf aufgehoben, ${k} Züge auf Sicht weiter`);
    this.notruf = undefined;
  }

  // ---------------- Rotte mit Sicherungsposten ----------------
  // Ablauf: Rotte meldet sich an (Fdl erlaubt) → arbeitet neben dem Gleis, Sicherungsposten warnt vor jedem Zug,
  // Züge geben Achtungssignal und fahren langsamer → Rotte bittet um Sperrung → Fdl sperrt, wenn das Gleis frei ist,
  // und bestätigt → Arbeit im Gleis → Rotte meldet "Gleis geräumt und befahrbar" → Fdl hebt die Sperrung auf.
  private rotteStart() {
    const w = this.w, r = this.rand;
    const secs = SECTIONS.filter(([a, b]) => !w.ext.happenings.some((h) => h.sec && h.sec[0] === a && h.sec[1] === b));
    const [a, b] = secs[Math.floor(r() * secs.length)];
    const lane = r() < 0.5 ? 4 : 5;
    const all = w.ext.sectionEdges(a, b).filter((e) => [lane, 4.5].includes(w.ext.laneOf(e)) && !w.g.edges[e].closed && !w.g.edges[e].work);
    if (!all.length) return;
    const pick = all[Math.floor(r() * all.length)];
    const E = w.g.edges[pick];
    const s = ((w.g.nodes[E.a].s ?? 0) + (w.g.nodes[E.b].s ?? 0)) / 2;
    const edges = all.filter((e) => { const X = w.g.edges[e]; const m = ((w.g.nodes[X.a].s ?? 0) + (w.g.nodes[X.b].s ?? 0)) / 2; return Math.abs(m - s) < 500 || e === pick; });
    const names = ["Becker", "Schmitz", "Wagner", "Krämer", "Hoffmann", "Yilmaz", "Neumann", "Jung"];
    const jobs = ["Schienenstoß schweißen", "Schwellen tauschen", "Kleineisen nachziehen", "Schotter nachstopfen", "Entwässerung freilegen", "Rückschnitt am Gleis"];
    this.rotte = { name: `Rotte ${names[Math.floor(r() * names.length)]}`, men: 4 + Math.floor(r() * 5), job: jobs[Math.floor(r() * jobs.length)], a, b, lane, s, edges,
      phase: 0, at: w.time, until: 0, prev: [], seen: [], asked: 0 };
    const R = this.rotte;
    if (!w.manualSt(a) && !w.manualSt(b)) { this.rotteBegin(); w.log(`${R.name} arbeitet im Bereich des Nachbar-Fdl bei km ${this.km(s)}`, "info"); return; }
    const gl = lane === 4 ? "Gleis Richtung Siegburg" : "Gleis Richtung Betzdorf";
    this.call(R.name, "rotte", `Hier ${R.name}, ${R.men} Mann. Wir möchten bei km ${this.km(s)} zwischen ${w.g.stations[a].name} und ${w.g.stations[b].name} arbeiten (${R.job}, ${gl}). Gesichert durch einen Sicherungsposten mit Signalhorn. Erst arbeiten wir neben dem Gleis, später brauchen wir eine Sperrung von etwa 20 Minuten.`,
      [{ k: "ok", label: "Arbeiten erlauben" }, { k: "spaeter", label: "Jetzt nicht" }], 300);
  }
  private km(s: number) { return (s / 1000).toFixed(1).replace(".", ","); }
  private rotteBegin() {
    const w = this.w, R = this.rotte!;
    R.phase = 1; R.asked = w.time + 900 + this.rand() * 900;
    R.prev = R.edges.map((e) => [e, { slow: w.g.edges[e].slow, closed: w.g.edges[e].closed }]);
    for (const e of R.edges) { const E = w.g.edges[e]; E.slow = Math.min(E.slow ?? 999, 80); E.rotte = true; }
    w.log(`${R.name} arbeitet neben dem Gleis bei km ${this.km(R.s)}. Züge geben Achtungssignal (Zp 1) und fahren dort höchstens 80 km/h`, "info");
    w.note("Rotte", `${R.name} (${R.men} Mann, ${R.job}) bei km ${this.km(R.s)} zwischen ${w.g.stations[R.a].name} und ${w.g.stations[R.b].name}, Sicherung durch Sicherungsposten`);
  }
  private rotteTick() {
    const w = this.w, R = this.rotte, r = this.rand;
    if (!R || R.phase === 0) return;
    const set = new Set(R.edges);
    // Sicherungsposten warnt, Tf gibt Achtungssignal
    for (const t of w.trains) {
      if (R.seen.includes(t.id) || !t.body.some((e) => set.has(e))) continue;
      R.seen.push(t.id);
      if (R.seen.length > 60) R.seen.shift();
      if (R.phase === 3) continue;
      if (r() < 0.04) {
        t.fault = "Schnellbremsung: Rotte hat das Gleis zu spät geräumt";
        t.faultUntil = w.time + 120 + r() * 120;
        t.radio.push({ t: w.time, from: "tf", text: `${t.no}: Schnellbremsung bei km ${this.km(R.s)}! Die Rotte war noch im Gleis, der Sicherungsposten hat zu spät gewarnt. Niemand verletzt, ich fahre gleich weiter.` });
        w.log(`${t.no}: Schnellbremsung an der Rotte bei km ${this.km(R.s)}, Sicherungsposten hat zu spät gewarnt`, "bad");
        w.note("Rotte", `Gefährliches Ereignis: ${t.no} Schnellbremsung an ${R.name}, Rotte zu spät geräumt`);
      } else t.radio.push({ t: w.time, from: "tf", text: `${t.no}: Achtungssignal gegeben, ${R.name} bei km ${this.km(R.s)} hat geräumt.` });
    }
    const mine = w.manualSt(R.a) || w.manualSt(R.b);
    if (R.phase === 1 && w.time >= R.asked && !mine) { R.phase = 3; R.at = 0; }
    if (R.phase === 1 && w.time >= R.asked) {
      R.phase = 2;
      this.call(R.name, "rottesperr", `Wir brauchen jetzt das ${R.lane === 4 ? "Gleis Richtung Siegburg" : "Gleis Richtung Betzdorf"} zwischen ${w.g.stations[R.a].name} und ${w.g.stations[R.b].name} gesperrt, etwa 20 Minuten. Wann geht das?`,
        [{ k: "sperren", label: "Gleis sperren, sobald frei" }, { k: "spaeter", label: "Erst nach dem nächsten Zug" }, { k: "nein", label: "Heute nicht, nur neben dem Gleis" }], 300);
    }
    if (R.phase === 3 && !R.at) {
      if (R.edges.some((e) => w.g.edges[e].occ || w.g.edges[e].lock)) return; // erst wenn frei
      for (const e of R.edges) w.g.edges[e].closed = true;
      for (const x of [...w.il.routes.values()]) if (!x.used && x.path.edges.some((e) => set.has(e))) w.cancelRoute(x.path.sig);
      R.at = w.time; R.until = w.time + 900 + r() * 900;
      w.log(`Gleis bei km ${this.km(R.s)} für ${R.name} gesperrt. Du an Rotte: "Gleis ist gesperrt, Sie dürfen ins Gleis."`, "info");
      w.note("Sperrung", `Gleis zwischen ${w.g.stations[R.a].name} und ${w.g.stations[R.b].name} (km ${this.km(R.s)}) für ${R.name} gesperrt, Sperre im Stellwerk eingegeben`);
    } else if (R.phase === 3 && w.time >= R.until && !mine) this.rotteUnlock();
    else if (R.phase === 3 && w.time >= R.until) {
      R.phase = 4;
      this.call(R.name, "rotteende", `Arbeiten im Gleis beendet. Alle Leute und Geräte sind aus dem Gleis, das Gleis ist befahrbar. Sie können die Sperrung aufheben.`,
        [{ k: "ok", label: "Sperrung aufheben" }], 240);
    } else if (R.phase === 5 && w.time >= R.until) this.rotteEnd();
  }
  private rotteUnlock() {
    const w = this.w, R = this.rotte;
    if (!R) return;
    for (const [e, p] of R.prev) w.g.edges[e].closed = p.closed;
    R.phase = 5; R.until = w.time + 300 + this.rand() * 600;
    w.log(`Sperrung für ${R.name} aufgehoben, Gleis wieder befahrbar. Restarbeiten neben dem Gleis`, "good");
    w.note("Sperrung", `Gleissperrung für ${R.name} aufgehoben (Rotte meldet: Gleis geräumt und befahrbar)`);
  }
  private rotteEnd() {
    const w = this.w, R = this.rotte;
    if (!R) return;
    for (const [e, p] of R.prev) { const E = w.g.edges[e]; E.slow = p.slow; E.closed = p.closed; E.rotte = undefined; }
    w.log(`${R.name} hat die Arbeiten beendet und meldet sich ab`, "good");
    w.note("Rotte", `${R.name} hat sich abgemeldet`);
    this.rotte = undefined;
  }

  // Sonderzüge: Lokzug, Messzug, Bauzug, Überführung
  private specialCall() {
    const w = this.w, r = this.rand;
    const tpl = w.allPending().filter((t) => t.cat === "G" && t.entryPortal && t.exitPortal && t.entryTime > w.time + 600);
    const base = tpl[Math.floor(r() * tpl.length)];
    if (!base) return;
    const kinds = [
      { no: `Lz ${70000 + Math.floor(r() * 9000)}`, what: "Lokzug", len: 20, vmax: 120, mass: 90 },
      { no: `Mess ${91000 + Math.floor(r() * 800)}`, what: "Messzug (Oberbaumessung)", len: 45, vmax: 100, mass: 120 },
      { no: `Bauz ${92000 + Math.floor(r() * 800)}`, what: "Bauzug mit Schotterwagen", len: 160, vmax: 80, mass: 900 },
      { no: `DbZ ${78000 + Math.floor(r() * 900)}`, what: "Überführungsfahrt (leere Triebwagen)", len: 110, vmax: 120, mass: 220 },
    ];
    const k = kinds[Math.floor(r() * kinds.length)];
    const at = w.time + 900 + r() * 900;
    const P = w.g.portals;
    this.call("Netzleitstelle", "sonder", `Heute zusätzlich: ${k.no}, ${k.what}, von ${P[base.entryPortal!].label} nach ${P[base.exitPortal!].label}, Einbruch ca. ${hm(at)}. Bitte einlegen.`, [{ k: "ok", label: "Verstanden" }], 240,
      { no: k.no, what: k.what, len: k.len, vmax: k.vmax, mass: k.mass, at, base: base.key });
  }
  private addSpecial(D: any) {
    const w = this.w;
    const base = w.allPending().find((t) => t.key === D.base);
    if (!base) return;
    const trip: TripSpec = { ...base, key: this.specialKey++, no: D.no, len: D.len, vmax: D.vmax, mass: D.mass, entryTime: D.at, initialDelay: 0, stops: [], special: D.what, turnInto: undefined, turnedFrom: undefined, from: w.g.portals[base.entryPortal!].label, to: w.g.portals[base.exitPortal!].label };
    (w as any).pending.push(trip);
    (w as any).pending.sort((a: TripSpec, b: TripSpec) => a.entryTime + a.initialDelay - (b.entryTime + b.initialDelay));
  }

  // Längere Sperrungen: Netzleitstelle schlägt Umleitung der Güterzüge und Ersatzverkehr vor
  private closures() {
    const w = this.w;
    for (const h of w.ext.happenings) {
      if (this.hapSeen.has(h.id) || !h.sec || h.until - w.time < 1200 || !h.edges.some((e) => w.g.edges[e].closed)) continue;
      this.hapSeen.add(h.id);
      const [a, b] = h.sec;
      const nm = (c: string) => w.g.stations[c].name;
      this.call("Netzleitstelle", "sperrung", `Die Sperrung ${nm(a)} – ${nm(b)} dauert voraussichtlich bis ${hm(h.until)}. Vorschlag: Güterzüge über andere Strecken umleiten, Personenzüge vor der Sperrung wenden, Ersatzverkehr mit Bussen ${nm(a)} – ${nm(b)}.`,
        [{ k: "sev", label: "Umleiten und Ersatzverkehr einrichten" }, { k: "warten", label: "Abwarten" }], 300, { a, b, until: h.until, hid: h.id });
    }
    this.sev = this.sev.filter((x) => x.until > w.time);
  }
  private crosses(t: { dir: number; stops: { st: string; done?: boolean }[]; exitPortal?: string }, a: string, b: string, fromS: number) {
    const w = this.w;
    const sa = w.stS(a), sb = w.stS(b);
    const lo = Math.min(sa, sb), hi = Math.max(sa, sb);
    const rest = t.stops.filter((s) => !s.done).map((s) => w.stS(s.st));
    const end = t.exitPortal ? t.dir * 1e9 : rest.length ? rest[rest.length - 1] : fromS;
    return Math.min(fromS, end) < hi - 100 && Math.max(fromS, end) > lo + 100;
  }
  private applyDiversion(D: any, timeout: boolean) {
    const w = this.w;
    const nm = (c: string) => w.g.stations[c].name;
    let n = 0;
    for (const trip of [...w.allPending()]) {
      if (trip.cat !== "G" || trip.entryTime > D.until || trip.special === "Hilfslok") continue;
      const fromS = trip.entryPortal ? w.g.nodes[w.g.portals[trip.entryPortal].outNode].s ?? 0 : w.stS(trip.stops[0]?.st ?? "TR");
      if (!this.crosses({ dir: trip.dir, stops: trip.stops, exitPortal: trip.exitPortal }, D.a, D.b, fromS)) continue;
      (w as any).pending = w.allPending().filter((x) => x !== trip);
      w.reports = w.reports.filter((r) => r.trip !== trip);
      n++;
    }
    this.sev.push({ a: D.a, b: D.b, until: D.until });
    w.log(`${timeout ? "Netzleitstelle hat entschieden: " : ""}${n} Güterzüge werden umgeleitet. Ersatzverkehr mit Bussen ${nm(D.a)} – ${nm(D.b)} bis ca. ${hm(D.until)}, Personenzüge wenden vor der Sperrung`, "info");
    w.note("SEV", `Ersatzverkehr ${nm(D.a)} – ${nm(D.b)} eingerichtet, ${n} Güterzüge umgeleitet`);
  }
  // Personenzüge vor der Sperrung wenden lassen
  private sevTick() {
    const w = this.w;
    for (const x of this.sev) {
      for (const t of w.trains) {
        if (t.cat === "G" || t.towed || w.rescues.some((r) => r.broken === t.id)) continue;
        const hs = w.headS(t);
        if (!this.crosses({ dir: t.dir, stops: t.stops, exitPortal: t.trip.exitPortal }, x.a, x.b, hs)) continue;
        const before = t.dir > 0 ? (w.stS(x.a) < w.stS(x.b) ? x.a : x.b) : (w.stS(x.a) < w.stS(x.b) ? x.b : x.a);
        if ((w.stS(before) - hs) * t.dir < -50) continue; // schon dahinter
        const opts = w.shortTurnOptions(t);
        if (!opts.includes(before)) continue;
        if (!w.shortTurn(t.id, before)) {
          t.sev = `Ersatzverkehr mit Bussen ab ${w.g.stations[before].name}`;
          w.cause(t, "Ersatzverkehr (Streckensperrung)", 1);
          const other = before === x.a ? x.b : x.a;
          const st = t.stops.find((s) => s.st === before && !s.done);
          const dep = (st ? w.eta(t, st) : w.time) + 300;
          const arr = dep + (Math.abs(w.stS(other) - w.stS(before)) * 1.35) / (45 / 3.6) + 240;
          const pax = t.cat === "RE" ? 60 + Math.floor(this.rand() * 120) : 20 + Math.floor(this.rand() * 80);
          this.buses = this.buses.filter((x) => !(x.feeder === t.no && w.time < x.dep));
          const b: Bus = { id: this.busNo, no: `SEV ${this.busNo++}`, from: before, to: other, dep, arr, pax, feeder: t.no };
          this.buses.push(b);
          w.log(`${b.no}: Bus ab ${w.g.stations[before].name} ${hm(dep)} nach ${w.g.stations[other].name} (an ca. ${hm(arr)}), Reisende aus ${t.no}`, "info");
        }
      }
    }
  }

  // Busse: Ankunft am anderen Ende; Reisende steigen in den nächsten Zug in Fahrtrichtung um
  private busDir(b: Bus) { return Math.sign(this.w.stS(b.to) - this.w.stS(b.from)); }
  // Zug, der am Zielbahnhof des Busses in Fahrtrichtung weiterfährt (Anschluss)
  busConn(b: Bus): Train | undefined {
    const w = this.w, d = this.busDir(b);
    const c: { t: Train; dep: number }[] = [];
    for (const t of w.trains) {
      if (t.cat === "G") continue;
      const i = t.stops.findIndex((s, k) => k >= t.stopIdx && s.st === b.to);
      if (i < 0) continue;
      const s = t.stops[i];
      const last = i === t.stops.length - 1 && !t.trip.exitPortal;
      if (t.dir === d && !last && !s.done) c.push({ t, dep: Math.max(s.dep, w.eta(t, s)) });
      else if (last && t.trip.turnInto && t.trip.turnInto.dir === d) c.push({ t, dep: Math.max(t.trip.turnInto.stops[0]?.dep ?? 0, (s.done ? w.time : w.eta(t, s)) + 240) });
    }
    return c
      .filter((x) => x.dep > b.arr - 1200 && x.dep < b.arr + 1800).sort((a, c) => Math.abs(a.dep - b.arr) - Math.abs(c.dep - b.arr))[0]?.t;
  }
  busesAt(st: string) { return this.buses.filter((b) => b.to === st && !b.done); }
  // Fdl lässt einen Zug am Bahnhof auf den Bus warten
  waitBus(trainId: number, busId: number): string | null {
    const t = this.w.trains.find((x) => x.id === trainId), b = this.buses.find((x) => x.id === busId);
    if (!t || !b || b.done) return "Bus ist schon angekommen";
    t.waitBus = b.id;
    this.w.log(`${t.no} wartet in ${this.w.g.stations[b.to].name} auf ${b.no} (an ca. ${hm(b.arr)})`, "info");
    return null;
  }
  busHolds(t: Train): boolean {
    const b = this.buses.find((x) => x.id === t.waitBus);
    if (!b || this.w.time >= b.arr + 120) { t.waitBus = undefined; return false; }
    const s = t.stops[t.stopIdx];
    if (!s || s.st !== b.to) return false;
    const k = `Anschluss vom ${b.no} abwarten`;
    if (!t.causes[k]) this.w.cause(t, k, 1);
    return true;
  }
  private busTick() {
    const w = this.w;
    for (const b of this.buses) {
      if (b.done || w.time < b.arr) continue;
      b.done = true;
      const d = this.busDir(b);
      let conn = this.busConn(b);
      if (conn) { const s = conn.stops.find((x, k) => k >= conn!.stopIdx && x.st === b.to); if (s && !s.done && !(conn.dwelling && conn.stops[conn.stopIdx] === s) && w.eta(conn, s) > w.time + 900) conn = undefined; }
      const nm = w.g.stations[b.to].name;
      const missed = w.trains.find((t) => t.dir === d && t.cat !== "G" && t.stops.some((s) => s.st === b.to && s.done && s.actDep !== undefined && s.actDep > b.arr - 600 && s.actDep <= b.arr));
      if (conn) { b.result = `Reisende steigen in ${conn.no} um`; w.score.points += 3; w.log(`${b.no} ist in ${nm} angekommen, ${b.pax} Reisende steigen in ${conn.no} um (+3)`, "good"); }
      else if (missed) { b.result = `Anschluss an ${missed.no} verpasst`; w.score.points -= 3; w.log(`${b.no} kommt in ${nm} an, aber ${missed.no} ist gerade weg. ${b.pax} Reisende warten auf den nächsten Zug (−3)`, "warn"); }
      else { b.result = "Reisende warten auf den nächsten Zug"; w.log(`${b.no} ist in ${nm} angekommen, ${b.pax} Reisende`, "info"); }
    }
    this.buses = this.buses.filter((b) => !b.done || w.time < b.arr + 1800);
  }

  // Personalwechsel: kurzer Zusatzhalt, bei großer Verspätung ist der Ablöser schon weg
  private crewTick() {
    const w = this.w, r = this.rand;
    for (const t of w.trains) {
      const st = this.crewChange.get(t.trip.key);
      if (!st || this.crewDone.has(t.trip.key) || !t.dwelling) continue;
      const s = t.stops[t.stopIdx];
      if (!s || s.st !== st) continue;
      this.crewDone.add(t.trip.key);
      t.dwellUntil = Math.max(t.dwellUntil, w.time + 60);
      t.radio.push({ t: w.time, from: "tf", text: `${t.no}: Personalwechsel in ${w.g.stations[st].name}, ich übergebe an meine Ablösung.` });
      if (w.liveDelay(t) > 720 && r() < 0.6) {
        const wait = 600 + Math.floor(r() * 600);
        this.call("Personaldisposition", "personal", `${t.no} ist so spät, dass die Ablösung in ${w.g.stations[st].name} schon einen anderen Dienst übernommen hat. Ein Ersatz-Tf ist in ca. ${Math.round(wait / 60)} min da. Warten oder den Zug hier enden lassen?`,
          [{ k: "warten", label: "Auf Ersatz-Tf warten" }, { k: "ende", label: "Zug endet hier (Teilausfall)" }], 180, { train: t.id, st, wait });
        t.dwellUntil = Math.max(t.dwellUntil, w.time + 180);
      }
    }
  }

  // ---------------- Lademaßüberschreitung (Lü): Begegnungsverbot auf der freien Strecke ----------------
  private span(edges: number[]): [number, number] | null {
    const g = this.w.g;
    let lo = Infinity, hi = -Infinity;
    for (const e of edges) {
      const E = g.edges[e];
      if (E.platform) continue;
      for (const n of [E.a, E.b]) { const s = g.nodes[n].s; if (s !== undefined) { lo = Math.min(lo, s); hi = Math.max(hi, s); } }
    }
    return lo <= hi ? [lo, hi] : null;
  }
  lueConflict(p: PathDef, t?: Train): string | null {
    const w = this.w;
    const dir = p.dir;
    const ps = this.span(p.edges);
    if (!ps) return null;
    // Nur Züge, die tatsächlich auf der freien Strecke daneben stehen oder fahren (eingestellte Fahrstraßen zählen nicht, sonst blockieren sich beide)
    const hit = (o: Train) => { const sp = this.span(o.body); return sp && sp[0] < ps[1] + 150 && sp[1] > ps[0] - 150; };
    if (t && t.waitRed > 600) return null; // nach 10 min Wartezeit erlaubt die Netzleitstelle die Begegnung mit Schrittgeschwindigkeit
    for (const o of w.trains) {
      if (o.dir === dir || o === t) continue;
      if (o.trip.special === "Lü" && o.v > 1 && hit(o)) return `Begegnungsverbot: ${o.no} ist eine Lü-Sendung (Lademaßüberschreitung), auf der freien Strecke daneben darf kein Gegenzug fahren`;
      if (t?.trip.special === "Lü" && hit(o)) return `Begegnungsverbot: ${t.no} ist eine Lü-Sendung, ${o.no} kommt auf dem Nachbargleis entgegen`;
    }
    return null;
  }

  // ---------------- Spielstand ----------------
  save() {
    const w = this.w;
    const specials = new Map<number, TripSpec>();
    for (const t of [...w.allPending(), ...w.trains.map((x) => x.trip), ...w.reports.map((r) => r.trip)]) if (t.key >= 900000) specials.set(t.key, t);
    return {
      calls: this.calls, id: this.id, sev: this.sev, crew: [...this.crewChange], crewDone: [...this.crewDone], hapSeen: [...this.hapSeen],
      nextNlz: this.nextNlz, nextNotruf: this.nextNotruf, nextRotte: this.nextRotte, rotte: this.rotte, buses: this.buses, busNo: this.busNo, notruf: this.notruf ? { ...this.notruf, clearAt: Math.min(this.notruf.clearAt, 1e12) } : undefined, nextSpecial: this.nextSpecial, specialKey: this.specialKey, neighbors: this.neighbors,
      specials: [...specials.values()].map(({ turnInto, turnedFrom, ...t }) => t),
      lue: this.all.filter((t) => t.special === "Lü").map((t) => t.key),
    };
  }
  load(d: any, all: TripSpec[], byKey: Map<number, TripSpec>) {
    this.calls = d.calls ?? []; this.id = d.id ?? 1; this.sev = d.sev ?? [];
    this.crewChange = new Map(d.crew ?? []); this.crewDone = new Set(d.crewDone ?? []); this.hapSeen = new Set(d.hapSeen ?? []);
    this.nextNlz = d.nextNlz ?? this.nextNlz; this.nextSpecial = d.nextSpecial ?? this.nextSpecial; this.specialKey = d.specialKey ?? this.specialKey;
    this.neighbors = d.neighbors ?? this.neighbors;
    this.nextNotruf = d.nextNotruf ?? this.nextNotruf; this.notruf = d.notruf;
    this.nextRotte = d.nextRotte ?? this.nextRotte; this.rotte = d.rotte; this.buses = d.buses ?? []; this.busNo = d.busNo ?? 1;
    if (this.rotte && this.rotte.phase > 0) for (const e of this.rotte.edges) this.w.g.edges[e].rotte = true;
    const lue = new Set<number>(d.lue ?? []);
    this.all = all;
    for (const t of all) { if (t.special === "Lü") t.special = undefined; if (lue.has(t.key)) t.special = "Lü"; }
    for (const t of d.specials ?? []) byKey.set(t.key, t);
  }

  // ---------------- Nachbarstellwerke ----------------
  lead(portal: string) { return this.neighbors[portal]?.lead ?? 240; }
  refuseP(portal: string) { return this.neighbors[portal]?.refuse ?? 0.07; }
  forget(portal: string) { return this.neighbors[portal]?.forget ?? 0; }
}
