import { GEdge } from "./graph";
import { Train, World } from "./world";

// Zusatzfunktionen, die beim Dienstbeginn einzeln an- und abgeschaltet werden:
// Wetter, Bahnübergänge, Baustellen und Ereignisse (Feuerwehr, Personen im Gleis, Notarzt …)

export interface Features {
  zugmeldung: boolean;
  faults: number; // 0 = aus, 0.5 selten, 1 normal, 2 häufig
  weather: boolean;
  bue: boolean;
  baustellen: boolean;
  ereignisse: boolean;
  vorbereich: boolean; // Verspätungen aus dem Vorbereich
  gueter: boolean;
  anschluss: boolean;
}

export const DEFAULT_FEATURES: Features = {
  zugmeldung: true, faults: 1, weather: true, bue: true, baustellen: true, ereignisse: true, vorbereich: true, gueter: true, anschluss: true,
};

export const FEATURE_LABELS: [keyof Features, string, string][] = [
  ["zugmeldung", "Zugmeldungen", "Einfahrende Züge musst du dem Nachbarn abnehmen, ausfahrende werden angeboten."],
  ["weather", "Wetter", "Regen, Laub, Nebel, Schnee und Sturm verändern Bremswege und Geschwindigkeiten."],
  ["bue", "Bahnübergänge", "15 Bahnübergänge an der Siegstrecke, die gestört sein können."],
  ["baustellen", "Baustellen", "Langsamfahrstellen und gesperrte Bahnsteiggleise während der Schicht."],
  ["ereignisse", "Ereignisse", "Feuerwehreinsatz, Personen im Gleis, Notarzt, Polizei, Baum im Gleis."],
  ["vorbereich", "Verspätungen von außen", "Züge kommen teils verspätet in deinen Bereich."],
  ["gueter", "Güterverkehr", "Generierte Güterzüge zwischen den Personenzügen."],
  ["anschluss", "Anschlüsse", "Hinweise, wenn ein Anschluss wegen Verspätung zu platzen droht."],
];

// ---------------- Wetter ----------------
export type WxKind = "klar" | "wolkig" | "regen" | "nebel" | "laub" | "schnee" | "sturm" | "gewitter";
interface WxDef { label: string; icon: string; acc: number; dec: number; vcap: number; dwell: number; sw: number; sig: number; tree: number; text: string; }
export const WX: Record<WxKind, WxDef> = {
  klar: { label: "klar", icon: "☀", acc: 1, dec: 1, vcap: 999, dwell: 0, sw: 1, sig: 1, tree: 0, text: "Trocken, gute Sicht." },
  wolkig: { label: "bewölkt", icon: "☁", acc: 1, dec: 1, vcap: 999, dwell: 0, sw: 1, sig: 1, tree: 0, text: "Bewölkt, trocken." },
  regen: { label: "Regen", icon: "🌧", acc: 0.9, dec: 0.88, vcap: 999, dwell: 5, sw: 1.2, sig: 1.2, tree: 0.2, text: "Nasse Schienen, etwas längere Bremswege." },
  nebel: { label: "Nebel", icon: "🌫", acc: 0.95, dec: 0.95, vcap: 160, dwell: 5, sw: 1, sig: 1, tree: 0, text: "Dichter Nebel, Schnellfahrstrecke höchstens 160 km/h." },
  laub: { label: "Laub auf den Schienen", icon: "🍂", acc: 0.7, dec: 0.72, vcap: 999, dwell: 0, sw: 1.3, sig: 1, tree: 0.3, text: "Schlechte Haftwerte: Züge fahren langsam an und bremsen früher." },
  schnee: { label: "Schneefall", icon: "❄", acc: 0.75, dec: 0.75, vcap: 160, dwell: 15, sw: 3, sig: 1.5, tree: 0.5, text: "Weichenheizungen laufen, Weichen frieren trotzdem öfter ein. Höchstens 160 km/h." },
  sturm: { label: "Sturm", icon: "🌬", acc: 0.95, dec: 0.95, vcap: 120, dwell: 0, sw: 1.2, sig: 1.3, tree: 5, text: "Sturmböen: alle Züge höchstens 120 km/h, Bäume können ins Gleis fallen." },
  gewitter: { label: "Gewitter", icon: "⛈", acc: 0.9, dec: 0.85, vcap: 999, dwell: 5, sw: 1.5, sig: 3, tree: 2, text: "Blitzeinschläge können Signale stören." },
};
// Gewichte für November
const WX_WEIGHT: [WxKind, number][] = [["wolkig", 30], ["regen", 24], ["laub", 16], ["nebel", 12], ["klar", 9], ["sturm", 5], ["schnee", 3], ["gewitter", 1]];

// ---------------- Bahnübergänge (Lage nach OpenStreetMap) ----------------
const BUE_LIST: [number, string, "full" | "half"][] = [
  [18467, "Hennef 5", "half"], [18953, "Hennef Bröltalstraße", "half"], [23359, "Stein", "half"], [23828, "Blankenberg 2", "full"],
  [25812, "Merten", "half"], [28976, "Eitorf 1", "half"], [29920, "Eitorf 2", "half"], [30509, "Eitorf 3", "half"], [31020, "Eitorf 4", "half"],
  [33295, "Bach", "half"], [39759, "Herchen Ost", "half"], [48817, "Rosbach Ost", "full"], [50075, "Au West", "half"],
  [54544, "Etzbach", "half"], [66838, "Scheuerfeld", "half"],
];

export interface Crossing { id: number; name: string; s: number; full: boolean; edges: number[]; closed: boolean; closedFor: number; faultUntil: number; blockedUntil: number; }

// ---------------- Baustellen und Ereignisse ----------------
export interface Site {
  id: number; kind: "la" | "gleis"; text: string; edges: number[]; from: number; until: number; v?: number;
  active: boolean; prev: Map<number, { slow?: number; closed?: boolean }>;
}
export interface Happening {
  id: number; kind: "feuer" | "personen" | "notarzt" | "polizei" | "baum" | "pkw" | "ol"; text: string; edges: number[]; until: number;
  prev: Map<number, { slow?: number; closed?: boolean }>; station?: string; sec?: [string, string];
}

// Abschnitte zwischen benachbarten Bahnhöfen (für Ereignisse)
export const SECTIONS: [string, string][] = [
  ["SB", "HN"], ["HN", "BL"], ["BL", "ME"], ["ME", "EI"], ["EI", "HE"], ["HE", "DA"], ["DA", "SL"], ["SL", "RO"], ["RO", "AU"], ["AU", "EZ"], ["EZ", "WI"], ["WI", "NH"], ["NH", "SF"], ["SF", "BZ"],
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SituationItem {
  id: string; kind: "stoerung" | "bue" | "zug" | "ereignis" | "baustelle" | "fdl" | "wetter"; icon: string; title: string; where: string;
  effect: string; from?: number; until?: number; planned?: boolean; trains: string[];
}

export class Extras {
  f: Features = { ...DEFAULT_FEATURES };
  wx: WxKind = "wolkig";
  wxUntil = Infinity;
  crossings: Crossing[] = [];
  sites: Site[] = [];
  happenings: Happening[] = [];
  private rand = rng(90210);
  private id = 1;
  private tick = 0;
  private evTimer = 0;
  private points = new Map<number, { s: number; v: number; why: string }[]>();
  connWarned = new Set<string>();

  constructor(private w: World) {
    const g = w.g;
    for (const [s, name, kind] of BUE_LIST) {
      const edges = g.edges.filter((e) => this.spans(e, s)).map((e) => e.id);
      if (edges.length) this.crossings.push({ id: this.id++, name: `BÜ ${name}`, s, full: kind === "full", edges, closed: false, closedFor: 0, faultUntil: 0, blockedUntil: 0 });
    }
  }

  sOf(n: number) { return this.w.g.nodes[n].s ?? 0; }
  spans(e: GEdge, s: number) {
    const a = this.sOf(e.a), b = this.sOf(e.b);
    return Math.min(a, b) <= s && s <= Math.max(a, b) && a !== b;
  }

  // ---------- Start ----------
  start(f: Features, shiftStart: number) {
    this.f = f;
    if (f.weather) {
      this.wx = this.pickWx();
      this.wxUntil = shiftStart + 2400 + this.rand() * 5400;
    } else this.wx = "wolkig";
    this.applyPerfAll();
    if (f.baustellen) this.planSites(shiftStart);
    this.rebuildPoints();
  }

  private pickWx(): WxKind {
    const sum = WX_WEIGHT.reduce((a, [, w]) => a + w, 0);
    let r = this.rand() * sum;
    for (const [k, w] of WX_WEIGHT) if ((r -= w) <= 0) return k;
    return "wolkig";
  }

  get weather() { return WX[this.wx]; }

  applyPerf(t: Train) {
    const W = this.f.weather ? WX[this.wx] : WX.wolkig;
    t.acc = t.trip.acc * W.acc;
    t.dec = t.trip.dec * W.dec;
    t.vmax = Math.min(t.trip.vmax, W.vcap) / 3.6;
  }
  applyPerfAll() { for (const t of this.w.trains) this.applyPerf(t); }

  // ---------- Takt (jede Sekunde) ----------
  step(dt: number) {
    this.tick += dt;
    if (this.tick < 1) return;
    const sec = this.tick;
    this.tick = 0;
    const w = this.w;
    if (this.f.weather && w.time >= this.wxUntil) {
      const old = this.wx;
      let nx = this.pickWx();
      if (nx === old) nx = this.pickWx();
      this.wx = nx;
      this.wxUntil = w.time + 2700 + this.rand() * 6300;
      if (nx !== old) w.log(`Wetter: ${WX[nx].icon} ${WX[nx].label}. ${WX[nx].text}`, nx === "sturm" || nx === "schnee" || nx === "laub" ? "warn" : "info");
      this.applyPerfAll();
    }
    if (this.f.bue) this.crossingsStep(sec);
    if (this.f.baustellen) this.sitesStep();
    this.happeningsStep();
    this.evTimer += sec;
    if (this.evTimer >= 10) {
      this.evTimer = 0;
      this.randomEvents();
      if (this.f.anschluss) this.connections();
    }
  }

  // ---------- Bahnübergänge ----------
  private crossingsStep(sec: number) {
    const w = this.w;
    let changed = false;
    for (const c of this.crossings) {
      let need = false;
      for (const t of w.trains) {
        if (!t.body.some((e) => c.edges.includes(e)) && !this.approaching(t, c)) continue;
        need = true;
        break;
      }
      if (need !== c.closed) {
        c.closed = need;
        if (!need) c.closedFor = 0;
      }
      if (c.closed) {
        c.closedFor += sec;
        if (Math.abs(c.closedFor - 900) < sec) w.log(`${c.name} ist seit 15 Minuten geschlossen, Autofahrer beschweren sich`, "warn");
      }
      if (c.faultUntil && c.faultUntil <= w.time) {
        c.faultUntil = 0;
        changed = true;
        w.log(`${c.name}: Störung behoben, Bahnübergang wieder technisch gesichert`, "good");
      }
      if (c.blockedUntil && c.blockedUntil <= w.time) c.blockedUntil = 0;
    }
    // Störung: Schranke schließt nicht, Züge müssen vor dem BÜ halten und ihn mit Schrittgeschwindigkeit befahren
    if (this.f.faults && this.rand() < (sec / 60) * this.f.faults * (this.f.weather ? WX[this.wx].sig : 1) / 180) {
      const c = this.crossings[Math.floor(this.rand() * this.crossings.length)];
      if (!c.faultUntil) {
        const dur = 900 + this.rand() * 1800;
        c.faultUntil = w.time + dur;
        changed = true;
        const what = c.full ? "Vollschranke lässt sich nicht schließen" : ["Halbschranke klemmt", "Blinklicht ausgefallen", "Einschaltkontakt gestört"][Math.floor(this.rand() * 3)];
        w.addFault("bue", c.id, c.faultUntil, `${c.name} gestört (${what}): Züge halten vor dem BÜ und fahren mit Schrittgeschwindigkeit darüber, ca. ${Math.round(dur / 60)} min`);
      }
    }
    if (changed) this.rebuildPoints();
  }

  private approaching(t: Train, c: Crossing): boolean {
    const hs = this.w.headS(t);
    const ds = (c.s - hs) * t.dir;
    return ds > 0 && ds < Math.max(180, t.v * 40 + 120);
  }

  // Punktförmige Geschwindigkeitsbeschränkungen (gestörter BÜ)
  private rebuildPoints() {
    this.points.clear();
    for (const c of this.crossings) {
      if (!c.faultUntil) continue;
      for (const e of c.edges) {
        const l = this.points.get(e) ?? [];
        l.push({ s: c.s, v: 1.4, why: `${c.name} gestört` });
        this.points.set(e, l);
      }
    }
  }
  pointsOn(e: number) { return this.points.get(e); }

  // ---------- Baustellen ----------
  private planSites(t0: number) {
    const g = this.w.g;
    const r = this.rand;
    const n = 2 + Math.floor(r() * 2);
    const used = new Set<number>();
    for (let i = 0; i < n; i++) {
      const [a, b] = SECTIONS[Math.floor(r() * SECTIONS.length)];
      const sec = this.sectionEdges(a, b);
      if (!sec.length) continue;
      const lane = r() < 0.6 ? (r() < 0.5 ? 4 : 5) : 0;
      const edges = sec.filter((e) => !used.has(e) && (!lane || this.laneOf(e) === lane || this.laneOf(e) === 4.5));
      if (!edges.length) continue;
      edges.forEach((e) => used.add(e));
      const v = [40, 60, 70, 80][Math.floor(r() * 4)];
      const why = ["Gleiserneuerung", "Brückenarbeiten", "Arbeiten an der Oberleitung", "Böschungssicherung", "Schwellenwechsel"][Math.floor(r() * 5)];
      const from = r() < 0.5 ? t0 - 3600 : t0 + 1800 + r() * 4 * 3600;
      const until = from + 3 * 3600 + r() * 6 * 3600;
      const gl = lane ? (lane === 4 ? "Gleis Richtung Siegburg" : "Gleis Richtung Betzdorf") : "beide Gleise";
      this.sites.push({ id: this.id++, kind: "la", text: `Baustelle ${g.stations[a].name} – ${g.stations[b].name} (${why}): La ${v} km/h, ${gl}`, edges, from, until, v, active: false, prev: new Map() });
    }
    // Bahnsteiggleis gesperrt (Bahnsteigsanierung)
    if (r() < 0.8) {
      const cand = ["TR", "SB", "HN", "EI", "AU", "WI", "BZ"];
      const st = cand[Math.floor(r() * cand.length)];
      const tracks = [...new Set(g.edges.filter((e) => e.platform?.st === st).map((e) => e.platform!.track))];
      if (tracks.length >= 3) {
        const tr = tracks[Math.floor(r() * tracks.length)];
        const edges = g.edges.filter((e) => e.platform?.st === st && e.platform.track === tr).map((e) => e.id);
        const from = t0 + 600 + r() * 3 * 3600;
        this.sites.push({ id: this.id++, kind: "gleis", text: `Bahnsteigsanierung ${g.stations[st].name} Gleis ${tr}: Gleis gesperrt, Züge auf andere Gleise legen`, edges, from, until: from + 2 * 3600 + r() * 3 * 3600, active: false, prev: new Map() });
      }
    }
  }

  private sitesStep() {
    const w = this.w, g = w.g;
    for (const s of this.sites) {
      if (!s.active && w.time >= s.from && w.time < s.until) {
        if (s.kind === "gleis" && s.edges.some((e) => g.edges[e].occ || g.edges[e].lock)) continue; // erst wenn frei
        s.active = true;
        for (const e of s.edges) {
          const E = g.edges[e];
          s.prev.set(e, { slow: E.slow, closed: E.closed });
          if (s.kind === "la") E.slow = Math.min(E.slow ?? 999, s.v!);
          else E.closed = true;
          E.work = true;
        }
        w.log(`Baustelle beginnt: ${s.text}`, "warn");
      } else if (s.active && w.time >= s.until) {
        s.active = false;
        this.restore(s.edges, s.prev);
        w.log(`Baustelle beendet: ${s.text.split(":")[0]}`, "good");
      }
    }
  }

  private restore(edges: number[], prev: Map<number, { slow?: number; closed?: boolean }>) {
    const g = this.w.g;
    for (const e of edges) {
      const p = prev.get(e);
      g.edges[e].slow = p?.slow;
      g.edges[e].closed = p?.closed;
      g.edges[e].work = undefined;
    }
    prev.clear();
  }

  laneOf(e: number) { return this.w.g.nodes[this.w.g.edges[e].a].y; }

  sectionEdges(a: string, b: string): number[] {
    const g = this.w.g;
    const sa = g.stations[a].s ?? 0, sb = g.stations[b].s ?? 0;
    const lo = Math.min(sa, sb) + 300, hi = Math.max(sa, sb) - 300;
    return g.edges.filter((e) => {
      const m = (this.sOf(e.a) + this.sOf(e.b)) / 2;
      const y = g.nodes[e.a].y, y2 = g.nodes[e.b].y;
      return m > lo && m < hi && !e.platform && [4, 5, 4.5].includes(y) && [4, 5, 4.5].includes(y2);
    }).map((e) => e.id);
  }

  // ---------- Ereignisse ----------
  private randomEvents() {
    const w = this.w, r = this.rand;
    const k = 10 / 60; // Anteil einer Minute
    const W = this.f.weather ? WX[this.wx] : WX.wolkig;
    if (this.f.ereignisse && this.happenings.length < 2) {
      if (r() < k / 75) this.startHappening(["feuer", "personen", "notarzt", "polizei", "notarzt", "personen"][Math.floor(r() * 6)] as Happening["kind"]);
      else if (W.tree && r() < (k * W.tree) / 400) this.startHappening("baum");
      else if (this.f.bue && r() < k / 400) this.startHappening("pkw");
      else if (r() < (k * (W.tree ? 2 : 1)) / 540) this.startHappening("ol");
    }
  }

  startHappening(kind: Happening["kind"]): string | null {
    const w = this.w, g = w.g, r = this.rand;
    const sec = SECTIONS[Math.floor(r() * SECTIONS.length)];
    const nm = (c: string) => g.stations[c].name;
    const h: Happening = { id: this.id++, kind, text: "", edges: [], until: 0, prev: new Map(), sec: [sec[0], sec[1]] };
    switch (kind) {
      case "feuer": {
        const dur = 1200 + r() * 1800;
        h.edges = this.sectionEdges(...sec);
        h.until = w.time + dur;
        h.text = `Feuerwehreinsatz an der Strecke ${nm(sec[0])} – ${nm(sec[1])} (${["Böschungsbrand", "Brand eines Gebäudes neben dem Gleis", "Fahrzeugbrand an der Strecke"][Math.floor(r() * 3)]}): Strecke gesperrt`;
        this.close(h, true);
        this.emergencyStop(h.edges, "Nothalt (Feuerwehreinsatz)", 120 + r() * 180);
        break;
      }
      case "personen": {
        const dur = 600 + r() * 1200;
        h.edges = this.sectionEdges(...sec);
        h.until = w.time + dur;
        h.text = `Personen im Gleis zwischen ${nm(sec[0])} und ${nm(sec[1])}: Fahrt auf Sicht, höchstens 30 km/h, Bundespolizei verständigt`;
        this.close(h, false, 30);
        this.emergencyStop(h.edges, "Schnellbremsung (Personen im Gleis)", 60 + r() * 120);
        break;
      }
      case "baum": {
        const lane = r() < 0.5 ? 4 : 5;
        h.edges = this.sectionEdges(...sec).filter((e) => this.laneOf(e) === lane || this.laneOf(e) === 4.5);
        h.until = w.time + 1800 + r() * 2400;
        h.text = `Baum im Gleis zwischen ${nm(sec[0])} und ${nm(sec[1])} (${lane === 4 ? "Gleis Richtung Siegburg" : "Gleis Richtung Betzdorf"}): Gleis gesperrt, Notfallmanager unterwegs`;
        this.close(h, true);
        this.emergencyStop(h.edges, "Schnellbremsung (Baum im Gleis)", 180 + r() * 300);
        break;
      }
      case "ol": {
        // nur in einem Abschnitt, in dem gerade kein Zug fährt (sonst stünde er ohne Strom)
        const free = SECTIONS.filter(([a, b]) => { const ed = new Set(this.sectionEdges(a, b)); return ed.size && !w.trains.some((t) => t.body.some((e) => ed.has(e))) && !this.happenings.some((x) => x.sec?.[0] === a); });
        if (!free.length) return "kein freier Abschnitt";
        const [a, b] = free[Math.floor(r() * free.length)];
        h.sec = [a, b];
        h.edges = this.sectionEdges(a, b);
        h.until = w.time + 3600 + r() * 5400;
        h.text = `Oberleitungsstörung zwischen ${nm(a)} und ${nm(b)} (${["Fahrdraht gerissen", "Ast in der Oberleitung", "Isolator defekt, Kurzschluss", "Ausleger nach Sturm verbogen"][Math.floor(r() * 4)]}): Strecke ohne Strom, keine Fahrten, Störungstrupp unterwegs`;
        this.close(h, true);
        break;
      }
      case "pkw": {
        const c = this.crossings[Math.floor(r() * this.crossings.length)];
        h.edges = [...c.edges];
        h.until = w.time + 1200 + r() * 1500;
        c.blockedUntil = h.until;
        h.text = `Pkw auf dem ${c.name} liegengeblieben: Gleise am BÜ gesperrt, Abschleppdienst unterwegs`;
        this.close(h, true);
        this.emergencyStop(h.edges, "Nothalt (Hindernis am Bahnübergang)", 120);
        break;
      }
      case "notarzt": case "polizei": {
        const cand = w.trains.filter((t) => t.cat !== "G" && t.dwelling && w.time < t.dwellUntil && t.stopIdx < t.stops.length - 1);
        if (!cand.length) return "kein Zug am Bahnsteig";
        const t = cand[Math.floor(r() * cand.length)];
        const st = t.stops[t.stopIdx].st;
        const dur = kind === "notarzt" ? 480 + r() * 900 : 600 + r() * 1200;
        t.dwellUntil = Math.max(t.dwellUntil, w.time + dur);
        t.fault = kind === "notarzt" ? "Notarzteinsatz im Zug" : "Polizeieinsatz im Zug";
        t.faultUntil = t.dwellUntil;
        w.cause(t, t.fault, dur);
        h.until = t.dwellUntil;
        h.station = st;
        h.text = kind === "notarzt" ? `Notarzteinsatz in ${t.no} in ${nm(st)}: Zug steht ca. ${Math.round(dur / 60)} min` : `Polizeieinsatz in ${t.no} in ${nm(st)} (${["Fahrgast ohne Fahrschein randaliert", "Streit unter Fahrgästen", "verdächtiges Gepäckstück"][Math.floor(r() * 3)]}): Zug steht ca. ${Math.round(dur / 60)} min`;
        break;
      }
    }
    if (!h.until) return "nicht möglich";
    this.happenings.push(h);
    w.addFault("event", h.id, h.until, h.text);
    return null;
  }

  private close(h: Happening, closed: boolean, slow?: number) {
    const w = this.w, g = w.g;
    const set = new Set(h.edges);
    for (const e of h.edges) {
      const E = g.edges[e];
      h.prev.set(e, { slow: E.slow, closed: E.closed });
      if (closed) E.closed = true;
      if (slow) E.slow = Math.min(E.slow ?? 999, slow);
    }
    if (closed) {
      // noch nicht befahrene Fahrstraßen in den gesperrten Bereich zurücknehmen
      for (const r of [...w.il.routes.values()]) if (!r.used && r.path.edges.some((e) => set.has(e))) w.cancelRoute(r.path.sig);
    }
  }

  private emergencyStop(edges: number[], why: string, dur: number) {
    const w = this.w;
    const set = new Set(edges);
    for (const t of w.trains) {
      if (!t.body.some((e) => set.has(e)) || t.dwelling) continue;
      t.fault = why;
      t.faultUntil = Math.max(t.faultUntil, w.time + dur);
      t.sight = true;
    }
  }

  private happeningsStep() {
    const w = this.w;
    for (const h of this.happenings) {
      if (h.until > w.time) continue;
      this.restore(h.edges, h.prev);
      w.log(`Ereignis beendet: ${h.text.split(":")[0]}. ${h.edges.length ? "Strecke wieder frei." : ""}`, "good");
    }
    this.happenings = this.happenings.filter((h) => h.until > w.time);
  }

  // ---------- Anschlüsse ----------
  // Ein Anschluss: Zubringer kommt an Station X an, Abbringer fährt 2–8 min später ab (andere Linie)
  connections() {
    const w = this.w;
    const hubs = ["TR", "SB", "HN", "AU", "BZ"];
    for (const a of w.trains) {
      if (a.cat === "G") continue;
      for (let i = a.stopIdx; i < a.stops.length; i++) {
        const sa = a.stops[i];
        if (sa.done || !hubs.includes(sa.st)) continue;
        const etaA = w.eta(a, sa);
        for (const b of w.trains) {
          if (b === a || b.cat === "G" || b.trip.line === a.trip.line) continue;
          const sb = b.stops.find((s) => s.st === sa.st && !s.done);
          if (!sb || sb === b.stops[b.stops.length - 1] && !b.trip.exitPortal) continue;
          const gap = sb.dep - sa.arr;
          if (gap < 120 || gap > 480) continue;
          if (b.trip.from === a.trip.to || b.cat === "S" || b.cat === "ICE") continue;
          // nur echte Umstiege: der Abbringer fährt dorthin, wohin der Zubringer nicht fährt
          const aRest = new Set(a.stops.slice(i).map((x) => x.st));
          const bIdx = b.stops.indexOf(sb);
          const bRest = b.stops.slice(bIdx + 1).map((x) => x.st);
          if (b.dir === a.dir && bRest.every((x) => aRest.has(x)) && (b.trip.exitPortal ?? "") === (a.trip.exitPortal ?? "")) continue;
          const key = `${a.no}>${b.no}@${sa.st}`;
          if (this.connWarned.has(key)) continue;
          // gefährdet, wenn der Zubringer erst nach der planmäßigen Abfahrt (minus 1 min Umstieg) ankommt
          const need = Math.ceil((etaA + 60 - Math.max(sb.dep, w.eta(b, sb))) / 60);
          if (need >= 2 && need <= 10 && etaA + 60 - sb.dep < 900) {
            this.connWarned.add(key);
            w.connAlerts.push({ id: this.id++, feeder: a.id, conn: b.id, st: sa.st, t: w.time, wait: Math.ceil((etaA + 60 - sb.dep) / 60) });
            w.log(`Anschluss gefährdet in ${w.g.stations[sa.st].name}: ${a.no} (${a.trip.line}) → ${b.no} (${b.trip.line}), ${Math.ceil((etaA + 60 - sb.dep) / 60)} min Wartezeit nötig`, "warn");
          }
        }
      }
    }
    w.connAlerts = w.connAlerts.filter((c) => w.time - c.t < 1200 && w.trains.some((t) => t.id === c.conn));
  }

  // ---------------- Lagebild für den zweiten Monitor ----------------
  // Alles, was gerade den Betrieb beeinflusst: Störungen, Baustellen, Ereignisse, vom Fdl angeordnete La und Sperrungen, Wetter.
  situation(): SituationItem[] {
    const w = this.w, g = w.g, now = w.time;
    const out: SituationItem[] = [];
    const edgeS = (e: number) => {
      const E = g.edges[e];
      const a = g.nodes[E.a].s, b = g.nodes[E.b].s;
      return a !== undefined && b !== undefined ? [Math.min(a, b), Math.max(a, b)] : a !== undefined ? [a, a] : b !== undefined ? [b, b] : null;
    };
    const span = (edges: number[]): [number, number] | null => {
      let lo = Infinity, hi = -Infinity;
      for (const e of edges) { const r = edgeS(e); if (r) { lo = Math.min(lo, r[0]); hi = Math.max(hi, r[1]); } }
      return lo <= hi ? [lo, hi] : null;
    };
    // Züge, deren restlicher Laufweg den Bereich berührt (oder die schon darin sind)
    const affected = (edges: number[]): string[] => {
      const set = new Set(edges);
      const sp = span(edges);
      const res: string[] = [];
      for (const t of w.trains) {
        if (t.body.some((e) => set.has(e))) { res.push(t.no); continue; }
        if (!sp) continue;
        const hs = w.headS(t);
        const last = t.stops[t.stops.length - 1];
        const end = t.trip.exitPortal ? t.dir * Infinity : last ? w.stS(last.st) : hs;
        const lo = Math.min(hs, end), hi = Math.max(hs, end);
        if (hi >= sp[0] - 50 && lo <= sp[1] + 50 && Math.abs((t.dir > 0 ? sp[0] : sp[1]) - hs) < 20000) res.push(t.no);
      }
      return res;
    };
    const loc = (edges: number[]) => {
      const pl = edges.map((e) => g.edges[e].platform).find(Boolean);
      if (pl) return `${g.stations[pl.st].name}, Gleis ${pl.track}`;
      const sp = span(edges);
      if (!sp) return "";
      const mid = (sp[0] + sp[1]) / 2;
      const st = Object.entries(g.stations).filter(([c]) => !["FH", "SM"].includes(c)).map(([c, x]) => ({ c, name: x.name, s: x.s ?? 0 })).sort((a, b) => a.s - b.s);
      const near = st.reduce((p, q) => (Math.abs(q.s - mid) < Math.abs(p.s - mid) ? q : p));
      if (Math.abs(near.s - mid) < 500) return `Bahnhof ${near.name}`;
      const before = [...st].reverse().find((x) => x.s <= mid), after = st.find((x) => x.s > mid);
      return before && after ? `zwischen ${before.name} und ${after.name}` : near.name;
    };
    const covered = new Set<number>();
    for (const x of [...this.sites.filter((s) => s.active), ...this.happenings]) for (const e of x.edges) covered.add(e);
    for (const b of w.ops.buses) {
      if (b.done && now > b.arr + 600) continue;
      const conn = b.done ? undefined : w.ops.busConn(b);
      out.push({ id: `bus${b.id}`, kind: "fdl", icon: "🚌", title: `${b.no}: ${g.stations[b.from].name} → ${g.stations[b.to].name}`, where: `Bus ab ${g.stations[b.from].name}`, from: b.dep, until: b.arr,
        effect: b.done ? `Angekommen: ${b.result ?? ""}` : `${b.pax} Reisende aus ${b.feeder}. ${conn ? `Anschluss in ${g.stations[b.to].name}: ${conn.no}${conn.waitBus === b.id ? " (wartet)" : ". Soll er warten? Im Zugfenster \"Auf Bus warten\""}` : "Noch kein Anschlusszug in Sicht."}`,
        trains: conn ? [conn.no] : [] });
    }
    const R = w.ops.rotte;
    if (R && R.phase > 0) {
      for (const e of R.edges) covered.add(e);
      const eff = ["", "Rotte arbeitet neben dem Gleis, der Sicherungsposten warnt vor jedem Zug. Züge geben Achtungssignal und fahren höchstens 80 km/h.",
        "Rotte wartet auf die Gleissperrung (Anruf beantworten).", "Gleis gesperrt, die Rotte arbeitet im Gleis. Züge über das Gegengleis führen oder warten lassen.",
        "Rotte meldet: Gleis geräumt und befahrbar. Sperrung aufheben!", "Restarbeiten neben dem Gleis, Achtungssignal, höchstens 80 km/h."][R.phase];
      out.push({ id: "rotte", kind: "baustelle", icon: "👷", title: `${R.name} (${R.men} Mann, ${R.job})`, where: loc(R.edges), from: R.at || undefined, until: R.phase === 3 && R.at ? R.until : undefined, effect: eff, trains: affected(R.edges) });
    }

    for (const f of w.faults) {
      if (f.kind === "event") continue; // als Ereignis unten
      const base = { id: `f${f.id}`, from: f.from, until: f.until - now > 86400 ? undefined : f.until };
      if (f.kind === "switch") {
        const n = g.nodes[f.target];
        out.push({ ...base, kind: "stoerung", icon: "⚠", title: `Weichenstörung ${n.swName ?? ""}`.trim(), where: w.nearStation(n.x),
          effect: "Die Weiche lässt sich nicht umstellen. Fahrstraßen über diese Weiche gehen nur in ihrer jetzigen Lage, sonst Umweg über andere Gleise.",
          trains: affected([...n.east, ...n.west]) });
      } else if (f.kind === "signal") {
        const sg = w.il.sig(f.target);
        const n = g.nodes[sg.node];
        out.push({ ...base, kind: "stoerung", icon: "⚠", title: `Signalstörung ${sg.name}`, where: w.nearStation(n.x),
          effect: "Das Signal zeigt nur Halt. Züge fahren erst mit Ersatzsignal (Zs1) weiter, danach auf Sicht bis zum nächsten Signal. Jeder Zug verliert so 1 bis 3 Minuten.",
          trains: w.trains.filter((t) => t.nextSig === f.target).map((t) => t.no) });
      } else if (f.kind === "az") {
        const sec = w.azSections.find((x) => x.id === f.target);
        out.push({ ...base, kind: "stoerung", icon: "⚠", title: `Gleisfreimeldung gestört ${sec?.name ?? ""}`, where: sec?.name ?? "",
          effect: sec?.state === 2 ? "Grundstellung ist erfolgt. Der nächste Zug fährt mit schriftlichem Befehl auf Sicht durch (Räumungsprüfung), danach ist der Abschnitt wieder frei."
            : "Der Abschnitt zeigt besetzt, keine Fahrstraße hinein. Ablauf: Zugschluss des letzten Zuges prüfen, Grundstellung, dann Räumungsprüfung mit Befehl. Ohne dich behebt ein Techniker das erst nach Stunden.",
          trains: sec ? affected(sec.edges) : [] });
      } else if (f.kind === "bue") {
        const c = this.crossings.find((x) => x.id === f.target);
        out.push({ ...base, kind: "bue", icon: "⛔", title: `BÜ gestört: ${c?.name ?? ""}`, where: c ? loc(c.edges) : "",
          effect: "Die Schranken sind nicht gesichert. Jeder Zug hält vor dem Bahnübergang und fährt mit Schrittgeschwindigkeit darüber, das kostet etwa 1 bis 2 Minuten pro Zug.",
          trains: c ? affected(c.edges) : [] });
      } else {
        const t = w.trains.find((x) => x.id === f.target);
        out.push({ ...base, kind: "zug", icon: "🚆", title: f.kind === "door" ? `Türstörung ${t?.no ?? ""}` : `Fahrzeugstörung ${t?.no ?? ""}`, where: t ? w.position(t).text : "",
          effect: f.kind === "door" ? "Der Zug kann nicht abfahren, bis die Tür geschlossen ist. Folgezüge auf diesem Gleis warten." : f.until - now > 86400 ? "Der Zug liegt fest. Entweder kommt eine Hilfslok (als Lokzug bis zum nächsten Bahnhof vor dem Zug, von dort mit Befehl als Sperrfahrt an den Zug) oder ein Techniker repariert ihn vor Ort (30 bis 50 min). Bis dahin ist das Gleis gesperrt, Folgezüge warten, wenden oder fahren über das Gegengleis." : "Der Zug steht, der Tf sucht den Fehler. Das Gleis ist so lange blockiert, Folgezüge müssen warten oder umgeleitet werden.",
          trains: t ? [t.no] : [] });
      }
    }
    for (const h of this.happenings) {
      if (h.until <= now) continue;
      const blocks = h.edges.some((e) => g.edges[e].closed);
      out.push({ id: `h${h.id}`, kind: "ereignis", icon: { feuer: "🔥", personen: "🚶", notarzt: "🚑", polizei: "🚓", baum: "🌳", pkw: "🚗", ol: "⚡" }[h.kind], title: h.text.split(":")[0],
        where: h.station ? g.stations[h.station].name : loc(h.edges), until: h.until,
        effect: h.kind === "ol" ? "Beide Gleise ohne Strom: keine Zugfahrten. Züge vor der Störung wenden lassen (Netzleitstelle schlägt Ersatzverkehr vor). Die SEV-Busse siehst du gelb unter dem Gleisbild. Du entscheidest, ob ein Zug am Wendebahnhof auf den Bus wartet." : h.station ? "Der Zug bleibt so lange am Bahnsteig stehen. Das Gleis ist blockiert, Folgezüge auf andere Gleise legen."
          : blocks ? "Abschnitt gesperrt: keine Fahrstraßen hinein. Züge davor warten oder werden über das andere Gleis (Gegengleis) geführt." : "Fahrt auf Sicht mit höchstens 30 km/h durch den Abschnitt.",
        trains: h.station ? w.trains.filter((t) => t.fault && t.dwelling && t.stops[t.stopIdx]?.st === h.station).map((t) => t.no) : affected(h.edges) });
    }
    for (const x of this.sites) {
      if (x.until <= now || (!x.active && x.from - now > 3 * 3600)) continue;
      out.push({ id: `s${x.id}`, kind: "baustelle", icon: "🚧", title: x.text.split(":")[0], where: loc(x.edges), from: x.from, until: x.until, planned: !x.active,
        effect: x.kind === "la" ? `Langsamfahrstelle ${x.v} km/h. Jeder Zug verliert je nach Länge etwa ${Math.max(1, Math.round(x.edges.reduce((a, e) => a + g.edges[e].len, 0) / 1000))} Minute(n).` : "Bahnsteiggleis gesperrt. Züge mit diesem Regelgleis brauchen eine Gleisänderung (im Zugfenster oder hier in der Dispo).",
        trains: x.active ? affected(x.edges) : [] });
    }
    // vom Fdl angeordnete La und Sperrungen
    const groups = new Map<string, number[]>();
    g.edges.forEach((E, i) => {
      if (covered.has(i) || (!E.slow && !E.closed)) return;
      if (this.happenings.some((h) => h.prev.has(i)) || this.sites.some((s) => s.active && s.prev.has(i))) return;
      const k = `${E.closed ? "x" : `v${E.slow}`}|${loc([i])}`;
      groups.set(k, [...(groups.get(k) ?? []), i]);
    });
    for (const [k, edges] of groups) {
      const closed = k.startsWith("x");
      const v = closed ? 0 : Number(k.split("|")[0].slice(1));
      out.push({ id: `p${k}`, kind: "fdl", icon: closed ? "⛔" : "🐢", title: closed ? "Gleissperrung (von dir angeordnet)" : `Langsamfahrstelle ${v} km/h (von dir angeordnet)`, where: loc(edges),
        effect: closed ? "Keine Fahrstraßen über das gesperrte Gleis. Hebst du die Sperrung im Rechtsklick-Menü auf, ist es sofort wieder frei." : `Züge fahren hier höchstens ${v} km/h, bis du die La im Rechtsklick-Menü aufhebst.`,
        trains: affected(edges) });
    }
    if (this.f.weather && !["klar", "wolkig"].includes(this.wx)) {
      const W = WX[this.wx];
      out.push({ id: "wx", kind: "wetter", icon: W.icon, title: W.label, where: "ganzer Bereich", until: isFinite(this.wxUntil) ? this.wxUntil : undefined,
        effect: W.text + (W.acc < 1 ? ` Anfahren etwa ${Math.round((1 - W.acc) * 100)} % schwächer.` : "") + (W.sw > 1.1 ? " Weichenstörungen häufiger." : "") + (W.sig > 1.1 ? " Signalstörungen häufiger." : ""),
        trains: [] });
    }
    return out;
  }
}
