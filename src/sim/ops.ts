import { PathDef } from "./interlocking";
import { TripSpec } from "./timetable";
import { Train, World } from "./world";

// Betriebsführung rund um den Fahrdienstleiter: Netzleitstelle (Anrufe, Weisungen, Sonderzüge, Umleitungen, SEV),
// Personaldisposition (Ablösung), Lademaßüberschreitungen und das Verhalten der Nachbarstellwerke.

export interface Call {
  id: number; t: number; from: string; text: string; kind: string;
  opts: { k: string; label: string }[]; answered?: string; expires: number; data?: any;
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
  specialKey = 900000;
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
    for (const p of Object.keys(this.w.g.portals)) this.neighbors[p] = { lead: 180 + r() * 300, refuse: 0.02 + r() * 0.12, forget: r() * 0.05 };
    this.nextNlz = this.w.time + 600 + r() * 900;
    this.nextSpecial = this.w.time + 1800 + r() * 3600;
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
      case "personal": {
        const t = tr(D.train);
        if (!t) return "Zug ist nicht mehr im Bereich";
        if (k === "ende") return w.shortTurn(t.id, D.st);
        t.dwellUntil = Math.max(t.dwellUntil, w.time + D.wait);
        w.cause(t, "Personal (Ablösung verspätet)", D.wait);
        w.log(`${t.no} wartet in ${w.g.stations[D.st].name} auf den Ersatz-Tf (ca. ${Math.round(D.wait / 60)} min)`, "info");
        return null;
      }
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
    this.closures();
    this.sevTick();
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
      if (trip.cat !== "G" || trip.entryTime > D.until) continue;
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
        if (t.cat === "G" || t.sev) continue;
        const hs = w.headS(t);
        if (!this.crosses({ dir: t.dir, stops: t.stops, exitPortal: t.trip.exitPortal }, x.a, x.b, hs)) continue;
        const before = t.dir > 0 ? (w.stS(x.a) < w.stS(x.b) ? x.a : x.b) : (w.stS(x.a) < w.stS(x.b) ? x.b : x.a);
        if ((w.stS(before) - hs) * t.dir < -50) continue; // schon dahinter
        const opts = w.shortTurnOptions(t);
        if (!opts.includes(before)) continue;
        if (!w.shortTurn(t.id, before)) {
          t.sev = `Ersatzverkehr mit Bussen ab ${w.g.stations[before].name}`;
          w.cause(t, "Ersatzverkehr (Streckensperrung)", 1);
        }
      }
    }
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
      nextNlz: this.nextNlz, nextSpecial: this.nextSpecial, specialKey: this.specialKey, neighbors: this.neighbors,
      specials: [...specials.values()].map(({ turnInto, turnedFrom, ...t }) => t),
      lue: this.all.filter((t) => t.special === "Lü").map((t) => t.key),
    };
  }
  load(d: any, all: TripSpec[], byKey: Map<number, TripSpec>) {
    this.calls = d.calls ?? []; this.id = d.id ?? 1; this.sev = d.sev ?? [];
    this.crewChange = new Map(d.crew ?? []); this.crewDone = new Set(d.crewDone ?? []); this.hapSeen = new Set(d.hapSeen ?? []);
    this.nextNlz = d.nextNlz ?? this.nextNlz; this.nextSpecial = d.nextSpecial ?? this.nextSpecial; this.specialKey = d.specialKey ?? this.specialKey;
    this.neighbors = d.neighbors ?? this.neighbors;
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
