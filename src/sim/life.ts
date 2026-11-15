import { Train, World } from "./world";
import type { Call } from "./ops";
import { SECTIONS } from "./extras";

// Mehr Leben im Betrieb: Triebfahrzeugführer melden sich von selbst, Reisende auf den Bahnsteigen und die
// Reisendeninformation, Sonderlagen mit Entscheidung (Polizei sperrt Bahnsteig, Sturmwarnung) und
// Dispositionswünsche der Netzleitstelle (vorzeitig wenden, Zusatzhalt).

const HUBS = ["TR", "SB", "HN", "AU", "BZ"];

export class Life {
  private timer = 0;
  nextTf = 0;
  nextLage = 0;
  nextDispo = 0;
  private lastWaitCall = -1e9;
  asked = new Set<string>();
  // vom Spieler entschiedene Anschlüsse: Ergebnis wird gemeldet, wenn der Anschlusszug abfährt
  conns: { feeder: number; conn: number; st: string; pax: number; held: boolean; fNo: string; cNo: string }[] = [];
  storm?: { a: string; b: string; at: number; la: boolean; laId?: number };

  constructor(private w: World) {}
  private get r() { return (this.w as any).rand as () => number; }

  start() {
    const t = this.w.time, r = this.r;
    this.nextTf = t + 1200 + r() * 1800;
    this.nextLage = t + 3600 + r() * 5400;
    this.nextDispo = t + 1800 + r() * 2400;
  }

  private mineSt(st: string) { return this.w.manualSt(st); }
  private nearSt(s: number) {
    let best = "TR", bd = Infinity;
    for (const c of Object.keys(this.w.g.stations)) { const d = Math.abs(this.w.stS(c) - s); if (d < bd) { bd = d; best = c; } }
    return best;
  }
  private name(st: string) { return this.w.g.stations[st].name; }
  private nextStop(t: Train) { return t.stops.find((x, i) => i >= t.stopIdx && !x.done && (!t.dwelling || i > t.stopIdx)); }
  private call(from: string, kind: string, text: string, opts: { k: string; label: string }[], ttl: number, data?: any) {
    return this.w.ops.call(from, kind, text, opts, ttl, data);
  }

  step(dt: number) {
    this.timer += dt;
    if (this.timer < 5) return;
    this.timer = 0;
    const w = this.w;
    this.tickLater();
    if (!w.manualAreas.size) return;
    this.waitCalls();
    this.connCalls();
    this.connResults();
    this.stormTick();
    const k = Math.max(0.3, w.faultRate);
    if (w.time >= this.nextTf) { this.tfEvent(); this.nextTf = w.time + (2400 + this.r() * 3600) / k; }
    if (w.time >= this.nextLage) { if (w.ext.f.ereignisse) this.lageEvent(); this.nextLage = w.time + (5400 + this.r() * 7200) / k; }
    if (w.time >= this.nextDispo) { this.dispoEvent(); this.nextDispo = w.time + 2400 + this.r() * 3000; }
  }

  // ---------- Tf meldet sich, wenn er lange vor Rot steht ----------
  private waitCalls() {
    const w = this.w;
    if (w.time - this.lastWaitCall < 300) return;
    for (const t of w.trains) {
      if (t.waitRed < 240 || !t.nextSig || t.shunt || t.hold || t.fault) continue;
      const s = w.il.sig(t.nextSig);
      if (s.auto) continue;
      const key = `w${t.id}-${s.id}`;
      if (this.asked.has(key)) continue;
      this.asked.add(key);
      this.lastWaitCall = w.time;
      const m = Math.floor(t.waitRed / 60);
      const txt = [`Ich stehe jetzt seit ${m} Minuten vor ${s.name}. Wie lange dauert das noch?`, `Hier ${t.no}, ich warte seit ${m} Minuten an ${s.name}. Gibt es einen Grund? Die Fahrgäste fragen schon.`, `${t.no} an Fdl: Stehe vor ${s.name}, seit ${m} Minuten Halt. Geht es bald weiter?`][Math.floor(this.r() * 3)];
      this.call(`Tf ${t.no} (${t.driver})`, "tfwarten", txt, [{ k: "gleich", label: "Geht gleich weiter" }, { k: "dauert", label: "Dauert noch, Fahrweg ist belegt" }], 150, { train: t.id, sig: s.id, no: t.no });
      return;
    }
    // versprochenes "gleich" nicht eingehalten
    for (const t of w.trains) {
      const p = (t as any).promised as number | undefined;
      if (!p || w.time < p) continue;
      (t as any).promised = undefined;
      if (t.waitRed > 300) {
        t.radio.push({ t: w.time, from: "tf", text: `${t.no}: Sie sagten, es geht gleich weiter. Ich stehe immer noch. Ich sage den Fahrgästen jetzt eine längere Verspätung an.` });
        w.score.points -= 2;
        w.log(`${t.no}: Tf beschwert sich, es ging doch nicht gleich weiter (−2 Punkte)`, "warn");
      }
    }
  }

  // ---------- zufällige Meldungen der Tf ----------
  private tfEvent() {
    const w = this.w, r = this.r;
    const cand = w.trains.filter((t) => t.cat !== "G" && t.v > 8 && !t.fault && !t.shunt && !t.trip.special && this.mineSt(this.nearSt(w.headS(t))));
    const t = cand[Math.floor(r() * cand.length)];
    if (!t) return;
    const roll = r();
    if (roll < 0.45) {
      // Notbremse durch Reisende
      const dur = 180 + r() * 300;
      t.fault = "Notbremse gezogen, Tf prüft den Zug"; t.faultUntil = w.time + dur;
      w.cause(t, "Notbremse durch Reisende", dur);
      const why = ["Ein Fahrgast hat die Notbremse gezogen, angeblich aus Versehen", "Jugendliche haben die Notbremse gezogen und sind weg", "Notbremse gezogen, ein Fahrgast hat seine Haltestelle verpasst"][Math.floor(r() * 3)];
      t.radio.push({ t: w.time, from: "tf", text: `${t.no}: ${why}. Ich muss den Zug kurz prüfen und die Notbremse zurückstellen.` });
      this.call(`Tf ${t.no} (${t.driver})`, "tfinfo", `${why}. Ich stehe auf der Strecke und muss die Notbremse zurückstellen, dauert ca. ${Math.round(dur / 60)} Minuten.`, [{ k: "ok", label: "Verstanden" }], 120, { train: t.id });
      w.note("Tf", `${t.no}: Notbremse durch Reisende, ca. ${Math.round(dur / 60)} min`);
    } else if (roll < 0.8) {
      // medizinischer Notfall: Rettungsdienst an den nächsten Halt oder an einen größeren Bahnhof
      const ns = this.nextStop(t);
      if (!ns) return;
      const hub = t.stops.find((x, i) => i >= t.stopIdx && !x.done && HUBS.includes(x.st) && x !== ns);
      const what = ["Fahrgast mit Kreislaufproblemen", "Fahrgast ist gestürzt und hat sich verletzt", "Fahrgast hat Atemnot", "ältere Dame ist zusammengebrochen"][Math.floor(r() * 4)];
      const opts = [{ k: "next", label: `Halt in ${this.name(ns.st)}` }];
      if (hub && !HUBS.includes(ns.st)) opts.push({ k: "hub", label: `Weiter bis ${this.name(hub.st)}` });
      this.call(`Tf ${t.no} (${t.driver})`, "medizin", `Ich habe hier einen Notfall: ${what}. Wo soll ich halten? Nächster Halt ist ${this.name(ns.st)}.${opts.length > 1 ? ` In ${this.name(hub!.st)} ist die Rettungswache näher, dort geht es schneller, ist aber weiter weg.` : ""} Bitte rufen Sie den Rettungsdienst dorthin.`,
        opts, 120, { train: t.id, next: ns.st, hub: hub?.st, no: t.no, what });
    } else {
      // Tf meldet etwas an der Strecke
      const s = w.headS(t);
      const what = ["Ich habe an der Strecke Personen gesehen, die Fotos machen, ziemlich nah am Gleis", "Hier liegt ein Ast neben dem Gleis, noch nicht im Lichtraum, aber bitte mal jemanden schicken", "Schafe stehen am Zaun, Zaun sieht kaputt aus", "Signal hat kurz geflackert, war dann aber wieder normal"][Math.floor(r() * 4)];
      this.call(`Tf ${t.no} (${t.driver})`, "tfmeldung", `Meldung bei km ${(s / 1000).toFixed(1).replace(".", ",")}: ${what}.`, [{ k: "ok", label: "Danke, gebe ich weiter" }, { k: "la", label: "Folgezüge dort auf Sicht (10 min)" }], 150, { s, dir: t.dir });
    }
  }

  // ---------- Reisendeninformation: Anschlüsse ----------
  paxFor(t: Train, st: string): number {
    const h = (((this.w.time % 86400) + 86400) % 86400) / 3600;
    const peak = (h >= 6.5 && h < 9) || (h >= 15.5 && h < 18.5) ? 1.6 : h >= 22 || h < 5.5 ? 0.4 : 1;
    const base = t.cat === "RE" || t.cat === "ICE" ? 45 : t.cat === "RB" ? 25 : 30;
    return Math.round(base * peak * (0.6 + ((t.id * 37 + st.charCodeAt(0)) % 10) / 12));
  }
  private connCalls() {
    const w = this.w;
    for (const c of w.connAlerts) {
      const key = `c${c.id}`;
      if (this.asked.has(key) || !this.mineSt(c.st)) continue;
      this.asked.add(key);
      const a = w.trains.find((t) => t.id === c.feeder), b = w.trains.find((t) => t.id === c.conn);
      if (!a || !b) continue;
      const pax = this.paxFor(a, c.st);
      this.call("Reisendeninformation", "anschluss", `${a.no} kommt mit +${Math.round(w.liveDelay(a) / 60)} min nach ${this.name(c.st)}. Etwa ${pax} Reisende wollen dort in ${b.no} nach ${b.trip.to} umsteigen. Soll ${b.no} etwa ${c.wait} min warten?`,
        [{ k: "halten", label: `${b.no} wartet` }, { k: "nein", label: "Nicht warten" }], 180, { id: c.id, feeder: a.id, conn: b.id, st: c.st, pax, fNo: a.no, cNo: b.no });
    }
  }
  private connResults() {
    const w = this.w;
    for (const c of [...this.conns]) {
      const b = w.trains.find((t) => t.id === c.conn);
      const sb = b?.stops.find((s) => s.st === c.st);
      if (b && sb && !sb.done) continue;
      this.conns = this.conns.filter((x) => x !== c);
      const a = w.trains.find((t) => t.id === c.feeder);
      const sa = a?.stops.find((s) => s.st === c.st);
      const dep = sb?.actDep ?? w.time;
      const ok = !!sa?.actArr && sa.actArr + 60 <= dep;
      if (ok) {
        w.score.points += Math.round(c.pax / 10);
        w.log(`Reisendeninformation: ${c.pax} Reisende aus ${c.fNo} haben in ${this.name(c.st)} ${c.cNo} erreicht (+${Math.round(c.pax / 10)} Punkte)`, "good");
      } else {
        w.score.points -= Math.round(c.pax / 10);
        w.log(`Reisendeninformation: ${c.pax} Reisende aus ${c.fNo} haben in ${this.name(c.st)} den Anschluss an ${c.cNo} verpasst (−${Math.round(c.pax / 10)} Punkte)`, "warn");
      }
    }
  }

  // Reisende, die gerade auf einem Bahnsteiggleis warten (für die Anzeige im Gleisbild)
  waiting(st: string, track: string): number {
    const w = this.w;
    let n = 0;
    for (const t of w.trains) {
      if (t.cat === "G") continue;
      const s = t.stops.find((x, i) => i >= t.stopIdx && !x.done && x.st === st);
      if (!s || (s.disp ?? s.plan) !== track || s === t.stops[t.stops.length - 1] && !t.trip.exitPortal) continue;
      const dep = Math.max(s.dep, w.eta(t, s));
      const until = dep - w.time;
      if (until > 1800 || (t.dwelling && t.stops[t.stopIdx] === s)) continue;
      const late = Math.max(0, dep - s.dep);
      n += this.paxFor(t, st) * Math.min(1.5, (1800 - Math.max(0, until)) / 1800 + late / 1800);
    }
    // Züge, die noch nicht im Bereich sind
    for (const q of (w as any).pending as any[]) {
      if (q.cat === "G") continue;
      const s = q.stops.find((x: any) => x.st === st);
      if (!s || (s === q.stops[q.stops.length - 1] && !q.exitPortal)) continue;
      const dep = s.dep + (q.initialDelay ?? 0);
      const until = dep - w.time;
      if (until > 1800 || until < -600) continue;
      const tr = w.dispTrack.get(`${q.key}|${st}`) ?? w.planFor(q, st);
      if (tr !== track) continue;
      const base = q.cat === "RE" || q.cat === "ICE" ? 45 : q.cat === "RB" ? 25 : 30;
      n += base * Math.min(1.5, (1800 - Math.max(0, until)) / 1800 + (q.initialDelay ?? 0) / 1800);
    }
    return Math.round(n * (HUBS.includes(st) ? 1.5 : 0.8));
  }

  // ---------- Sonderlagen mit Entscheidung ----------
  private lageEvent() {
    const w = this.w, r = this.r;
    if (r() < 0.5) {
      // Bundespolizei sperrt einen Bahnsteig
      const sts = [...w.manualAreas].filter((st) => w.g.stations[st] && w.platformTracks(st).length >= 3);
      const st = sts[Math.floor(r() * sts.length)];
      if (!st) return;
      const tracks = w.platformTracks(st);
      const tr = tracks[Math.floor(r() * tracks.length)].track;
      const what = ["Herrenloser Koffer", "Verdächtiger Rucksack", "Herrenlose Tasche"][Math.floor(r() * 3)];
      const edges = w.g.edges.map((E, i) => ({ E, i })).filter(({ E }) => E.platform?.st === st && E.platform?.track === tr).map(({ i }) => i);
      this.call(`Örtliche Aufsicht ${this.name(st)}`, "tfinfo", `${what} auf dem Bahnsteig an Gleis ${tr}. Niemand weiß, wem es gehört. Bitte die Bundespolizei verständigen.`, [{ k: "ok", label: "Verstanden" }], 120);
      w.phone.add("bahnsteig", `${what} am Bahnsteig Gleis ${tr}`, `${this.name(st)} Gleis ${tr}`, ["polizei"], 0, true, { st, tr, what, edges });
    } else {
      // Sturmwarnung: vorsorgliche La oder Risiko
      const secs = SECTIONS.filter(([a, b]) => this.mineSt(a) || this.mineSt(b));
      const sec = (secs.length ? secs : SECTIONS)[Math.floor(r() * (secs.length || SECTIONS.length))];
      if (this.storm) return;
      this.call("Notfallmanager", "sturm", `Unwetterwarnung vom Wetterdienst: Sturmböen bis 100 km/h in der nächsten Stunde, besonders zwischen ${this.name(sec[0])} und ${this.name(sec[1])}. Dort steht viel Wald an der Strecke. Willst du vorsorglich eine La 80 einrichten?`,
        [{ k: "la", label: "La 80 einrichten" }, { k: "nein", label: "Keine La, normal weiterfahren" }], 180, { a: sec[0], b: sec[1] });
    }
  }
  private stormTick() {
    const S = this.storm, w = this.w;
    if (!S || w.time < S.at) return;
    this.storm = undefined;
    const hit = this.r() < (S.la ? 0.3 : 0.55);
    if (!hit) { w.log(`Sturm zwischen ${this.name(S.a)} und ${this.name(S.b)} ist durchgezogen, keine Schäden gemeldet`, "good"); if (S.laId) w.ext.endHappening(S.laId); return; }
    const before = w.ext.happenings.length;
    w.ext.startHappening("baum", [S.a, S.b]);
    const h = w.ext.happenings[before];
    if (!h) return;
    if (!S.la) {
      // ohne La: ein Zug fährt in den Baum
      const t = w.trains.find((x) => x.body.some((e) => h.edges.includes(e)) && !x.dwelling);
      if (t) {
        t.fault = "Zug ist in einen umgestürzten Baum gefahren, Front beschädigt"; t.faultUntil = w.time + 1500 + this.r() * 900;
        w.cause(t, "Baum im Gleis (Anprall)", 1500);
        w.score.points -= 30;
        w.log(`${t.no} ist bei Sturm in einen umgestürzten Baum gefahren (ohne vorsorgliche La, −30 Punkte)`, "bad");
        w.note("Sturm", `${t.no} Anprall an Baum zwischen ${this.name(S.a)} und ${this.name(S.b)}`);
      }
    } else w.log("Dank der La konnten die Züge vor dem umgestürzten Baum rechtzeitig anhalten", "good");
  }

  // ---------- Dispositionswünsche der Netzleitstelle ----------
  private dispoEvent() {
    const w = this.w, r = this.r;
    if (r() < 0.55) {
      // verspäteten Zug vorzeitig wenden, damit die Gegenleistung pünktlich ist
      for (const t of w.trains) {
        if (t.cat === "G" || !t.trip.turnInto || w.liveDelay(t) < 900 || this.asked.has(`st${t.id}`)) continue;
        const opts = w.shortTurnOptions(t).filter((st) => this.mineSt(st));
        if (!opts.length) continue;
        const st = opts[opts.length - 1];
        this.asked.add(`st${t.id}`);
        this.call("Netzleitstelle", "wende", `${t.no} hat +${Math.round(w.liveDelay(t) / 60)} min. Bitte lass ihn schon in ${this.name(st)} wenden, damit ${t.trip.turnInto.no} pünktlich zurückfährt. Die Reisenden nach ${t.trip.to} nehmen den nächsten Zug.`,
          [{ k: "ok", label: `In ${this.name(st)} wenden` }, { k: "nein", label: "Nein, er fährt durch" }], 240, { train: t.id, st, no: t.no });
        return;
      }
    }
    // Zusatzhalt: viele Reisende gestrandet
    const sts = [...w.manualAreas].filter((st) => w.g.stations[st] && !HUBS.includes(st) && w.platformTracks(st).length);
    for (const t of w.trains) {
      if (t.cat !== "RE" && t.cat !== "RB") continue;
      const st = sts.find((x) => !t.stops.some((s) => s.st === x) && (w.stS(x) - w.headS(t)) * t.dir > 3000 && (w.stS(x) - w.headS(t)) * t.dir < 15000);
      if (!st || this.asked.has(`zh${t.id}`)) continue;
      this.asked.add(`zh${t.id}`);
      const why = ["Der letzte Zug ist dort ausgefallen, am Bahnsteig warten viele Reisende", "Dort endet gerade eine Veranstaltung, der Bahnsteig ist voll", "Ein Zug ist dort wegen einer Störung ausgefallen"][Math.floor(r() * 3)];
      this.call("Netzleitstelle", "zusatzhalt", `${why}. Kann ${t.no} außerplanmäßig in ${this.name(st)} halten?`, [{ k: "ok", label: "Zusatzhalt anordnen" }, { k: "nein", label: "Geht nicht" }], 180, { train: t.id, st, no: t.no });
      return;
    }
  }

  // ---------- Antworten ----------
  resolve(c: Call, k: string, timeout: boolean): string | null {
    const w = this.w, D = c.data ?? {};
    const tr = (id: number) => w.trains.find((t) => t.id === id);
    switch (c.kind) {
      case "tfwarten": {
        const t = tr(D.train);
        if (timeout) { w.score.points -= 3; w.log(`Tf ${D.no} hat auf seine Frage keine Antwort bekommen (−3 Punkte)`, "warn"); return null; }
        if (!t) return null;
        if (k === "gleich") { (t as any).promised = w.time + 360; t.radio.push({ t: w.time, from: "tf", text: `${t.no}: Alles klar, danke. Ich sage es den Fahrgästen.` }); }
        else t.radio.push({ t: w.time, from: "tf", text: `${t.no}: Verstanden, Fahrweg belegt. Ich mache eine Durchsage, dass es etwas dauert.` });
        return null;
      }
      case "tfinfo": return null;
      case "tfmeldung": {
        if (k === "la" && !timeout) {
          const edges = w.g.edges.map((E, i) => ({ E, i })).filter(({ E }) => { const a = w.g.nodes[E.a].s ?? -1e9; return Math.abs(a - D.s) < 600; }).map(({ i }) => i);
          w.ext.customHappening("personen", `Meldung eines Tf bei km ${(D.s / 1000).toFixed(1).replace(".", ",")}: Fahrt auf Sicht, höchstens 40 km/h`, edges, 600, false, 40);
          w.log("Folgezüge fahren dort 10 Minuten auf Sicht", "info");
        } else w.note("Tf", c.text);
        return null;
      }
      case "medizin": {
        const t = tr(D.train);
        if (!t) return "Zug ist nicht mehr im Bereich";
        const st = k === "hub" && D.hub && !timeout ? D.hub : D.next;
        const sec = (HUBS.includes(st) ? 240 : 420) + this.r() * 240;
        t.medStop = { st, sec };
        if (!t.stops.some((x, i) => i >= t.stopIdx && x.st === st && !x.done)) w.addStop(t, st);
        t.radio.push({ t: w.time, from: "fdl", text: `${t.no}, halten Sie in ${this.name(st)}, ich rufe den Rettungsdienst dorthin.` });
        w.note("Notfall", `${t.no}: Fahrgast braucht Rettungsdienst in ${this.name(st)}`);
        w.phone.add("medizin", `Notfall in ${t.no}: ${D.what ?? "Fahrgast braucht Hilfe"}`, this.name(st), ["rettung"], t.id, this.mineSt(st), { train: t.id });
        return null;
      }
      case "anschluss": {
        if (k === "halten" && !timeout) {
          const why = w.holdConnection(D.id);
          if (why) return why;
          this.conns.push({ feeder: D.feeder, conn: D.conn, st: D.st, pax: D.pax, held: true, fNo: D.fNo, cNo: D.cNo });
        } else {
          w.dropConnection(D.id);
          this.conns.push({ feeder: D.feeder, conn: D.conn, st: D.st, pax: D.pax, held: false, fNo: D.fNo, cNo: D.cNo });
        }
        return null;
      }
      case "bahnsteig": {
        const edges = w.g.edges.map((E, i) => ({ E, i })).filter(({ E }) => E.platform?.st === D.st && E.platform?.track === D.tr).map(({ i }) => i);
        const dur = 1800 + this.r() * 900;
        const go = () => {
          w.ext.customHappening("bahnsteig", `Polizeieinsatz in ${this.name(D.st)} (${D.what}): Gleis ${D.tr} gesperrt`, edges, dur, true, undefined, D.st);
          w.note("Polizei", `${this.name(D.st)} Gleis ${D.tr} gesperrt (${D.what})`);
        };
        if (timeout) { w.score.points -= 10; w.log("Bundespolizei hat das Gleis selbst sperren lassen, du hast nicht reagiert (−10 Punkte)", "warn"); go(); return null; }
        if (k === "spaeter") { w.log(`Du an Bundespolizei: Gleis ${D.tr} wird in 5 Minuten gesperrt, ein Zug fährt noch aus`, "info"); this.later(300, go); return null; }
        go();
        return null;
      }
      case "sturm": {
        const la = k === "la" && !timeout;
        this.storm = { a: D.a, b: D.b, at: w.time + 1200 + this.r() * 1800, la };
        if (la) {
          const S = (w.ext as any).sectionEdges(D.a, D.b) as number[];
          this.storm.laId = w.ext.customHappening("sturm", `Sturmwarnung ${this.name(D.a)} – ${this.name(D.b)}: vorsorglich La 80`, S, 3600 + 1800, false, 80);
          w.log(`La 80 zwischen ${this.name(D.a)} und ${this.name(D.b)} wegen Sturmwarnung eingerichtet`, "info");
        } else if (!timeout) w.log("Keine vorsorgliche La, Züge fahren normal weiter", "info");
        return null;
      }
      case "wende": {
        if (timeout) { w.log("Netzleitstelle: Bitte um vorzeitige Wende blieb unbeantwortet", "warn"); w.score.points -= 5; return null; }
        if (k !== "ok") { w.log(`Du an Netzleitstelle: ${D.no} fährt durch`, "info"); return null; }
        const why = w.shortTurn(D.train, D.st);
        if (!why) w.score.points += 5;
        return why;
      }
      case "zusatzhalt": {
        if (timeout || k !== "ok") { if (!timeout) w.log(`Du an Netzleitstelle: Zusatzhalt für ${D.no} geht nicht`, "info"); return null; }
        const t = tr(D.train);
        if (!t) return "Zug ist nicht mehr im Bereich";
        const why = w.addStop(t, D.st);
        if (!why) { w.score.points += 5; t.radio.push({ t: w.time, from: "fdl", text: `${t.no}, Sie halten bitte außerplanmäßig in ${this.name(D.st)}.` }); }
        return why;
      }
    }
    return null;
  }

  private delayed: { at: number; fn: () => void }[] = [];
  later(sec: number, fn: () => void) { this.delayed.push({ at: this.w.time + sec, fn }); }
  tickLater() {
    const now = this.w.time;
    for (const d of this.delayed.filter((x) => x.at <= now)) d.fn();
    this.delayed = this.delayed.filter((x) => x.at > now);
  }
}

