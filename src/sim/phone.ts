import type { World } from "./world";

// Telefon des Fdl: Bei Ereignissen und Störungen in seinem Bereich ruft der Fdl selbst Polizei, Rettungsdienst,
// Feuerwehr, Störungstrupp, Zentralschaltstelle oder Notfallmanager. Erst dann geht es weiter. Vergisst er es,
// springt nach 20 Minuten der Notfallmanager ein (Punktabzug).

export type Contact = "notfall" | "polizei" | "rettung" | "feuerwehr" | "stoerung" | "zes";
export const CONTACTS: { k: Contact; label: string; icon: string }[] = [
  { k: "notfall", label: "Notfallmanager", icon: "🦺" },
  { k: "polizei", label: "Bundespolizei", icon: "🚓" },
  { k: "rettung", label: "Rettungsdienst 112", icon: "🚑" },
  { k: "feuerwehr", label: "Feuerwehr 112", icon: "🚒" },
  { k: "stoerung", label: "Störungstrupp LST", icon: "🔧" },
  { k: "zes", label: "Zentralschaltstelle", icon: "⚡" },
];
const NAME: Record<Contact, string> = Object.fromEntries(CONTACTS.map((c) => [c.k, c.label])) as any;

export type MatterKind = "personen" | "baum" | "feuer" | "einschalten" | "pkw" | "ol" | "notarzt" | "polizei" | "bahnsteig" | "weiche" | "signal" | "bue" | "medizin" | "liegen" | "notruf";
export interface Matter {
  id: number; kind: MatterKind; title: string; where: string; t: number;
  need: Contact[]; called: Contact[];
  ref: number; // Ereignis-, Störungs-, Zug- oder BÜ-ID
  data?: any;
  choice?: { contact: Contact; opts: { k: string; label: string }[] };
  done?: boolean;
  auto?: boolean; // vom Nachbarn erledigt (nicht im Bereich des Spielers)
  at?: number; // Helfer vor Ort ab
}
export interface Spot { icon: string; title: string; state: "call" | "coming" | "site" | "info"; eta?: number; edges?: number[]; train?: number; node?: number; sig?: number; crossing?: number; sPos?: number }
export interface PhoneLine { t: number; who: string; text: string; me?: boolean }

const TIMEOUT = 1200;

export class Phone {
  matters: Matter[] = [];
  log: PhoneLine[] = [];
  id = 1;
  // spätere Rückmeldungen der Gesprächspartner
  later: { at: number; who: string; text: string; ev?: string; m?: number }[] = [];

  constructor(private w: World) {}
  private get r() { return (this.w as any).rand as () => number; }
  private mm(sec: number) { return Math.max(1, Math.round(sec / 60)); }
  private say(who: string, text: string, me = false) {
    this.log.push({ t: this.w.time, who, text, me });
    if (this.log.length > 80) this.log.shift();
    if (!me) this.w.log(`📞 ${who}: ${text}`, "info");
  }

  open() { return this.matters.filter((m) => !m.done); }

  // Was gerade im Gleisbild markiert werden soll: offene Anliegen und laufende Einsätze mit Ort
  spots(): Spot[] {
    const w = this.w, now = w.time, out: Spot[] = [];
    const used = new Set<number>();
    const icon = (c: Contact) => CONTACTS.find((x) => x.k === c)!.icon;
    for (const m of this.matters) {
      if (m.auto) continue;
      const D = m.data ?? {};
      const sp: Spot = { icon: icon(m.need[0]), title: m.title, state: m.done ? (now < (m.at ?? 0) ? "coming" : "site") : "call", eta: m.at };
      let active = !m.done;
      const h = m.ref ? w.ext.happenings.find((x) => x.id === m.ref) : undefined;
      switch (m.kind) {
        case "personen": case "baum": case "feuer": case "einschalten": case "pkw": case "ol": case "notarzt": case "polizei":
          if (h) { used.add(h.id); active = true; if (h.train !== undefined) sp.train = h.train; else sp.edges = h.edges; } else active = false;
          break;
        case "bahnsteig": {
          const hb = w.ext.happenings.find((x) => x.kind === "bahnsteig" && x.station === D.st);
          if (hb) { used.add(hb.id); active = true; }
          sp.edges = D.edges; if (!hb && m.done) active = false;
          break;
        }
        case "weiche": case "signal": case "bue": {
          const f = w.faults.find((x) => x.id === m.ref);
          if (!f) { active = false; break; }
          active = true;
          if (m.kind === "weiche") sp.node = f.target; else if (m.kind === "signal") sp.sig = f.target; else sp.crossing = f.target;
          break;
        }
        case "medizin": {
          const t = w.trains.find((x) => x.id === D.train);
          if (!t) { active = false; break; }
          sp.train = t.id;
          if (m.done) active = !!t.medStop || (t.fault === "Rettungsdienst im Zug" && now < t.dwellUntil);
          break;
        }
        case "liegen":
          sp.train = D.train ?? m.ref;
          if (m.done) active = w.rescues.some((R) => R.broken === sp.train);
          break;
        case "notruf": {
          const n = w.ops.notruf;
          if (!n) { active = false; break; }
          sp.train = n.trains[0]; if (m.done) active = n.clearAt > now; sp.sPos = n.s;
          break;
        }
      }
      if (active) out.push(sp);
    }
    // laufende Ereignisse ohne Anruf (Nachbarbereich oder schon geklärt)
    const IC: Record<string, string> = { feuer: "🚒", personen: "🚓", notarzt: "🚑", polizei: "🚓", baum: "🌳", pkw: "🚗", ol: "⚡", bahnsteig: "🚓", sturm: "🌬️" };
    for (const h of w.ext.happenings) {
      if (used.has(h.id) || h.until <= now || h.until - now > 86400 * 50) continue;
      out.push({ icon: IC[h.kind] ?? "⚠", title: h.text.split(":")[0], state: "info", edges: h.train === undefined ? h.edges : undefined, train: h.train });
    }
    return out;
  }

  // Neues Anliegen. Liegt es nicht im Bereich des Spielers, erledigt es der Nachbar sofort.
  add(kind: MatterKind, title: string, where: string, need: Contact[], ref: number, mine: boolean, data?: any, choice?: Matter["choice"]): Matter {
    const m: Matter = { id: this.id++, kind, title, where, t: this.w.time, need, called: [], ref, data, choice };
    this.matters.push(m);
    if (!mine) { m.auto = true; m.called = [...need]; this.resolve(m, true); }
    else this.w.log(`📞 Anliegen: ${title} (${where}). Wen rufst du an? (Reiter „Zugmeldungen“, Abschnitt Telefon)`, "warn");
    return m;
  }

  // Der Spieler ruft an
  dial(mid: number, c: Contact, choice?: string): string | null {
    const m = this.matters.find((x) => x.id === mid && !x.done);
    if (!m) return "Dieses Anliegen ist schon erledigt";
    const who = NAME[c];
    this.say("Du", `an ${who}: ${m.title}, ${m.where}.`, true);
    if (!m.need.includes(c)) {
      const right = m.need.filter((x) => !m.called.includes(x)).map((x) => NAME[x]).join(" und ");
      this.say(who, this.wrong(c, m, right));
      return null;
    }
    if (m.called.includes(c)) { this.say(who, "Ist schon bei uns aufgenommen, die Kollegen sind unterwegs."); return null; }
    if (m.choice && m.choice.contact === c && !choice) return "Bitte erst auswählen, was du anforderst";
    if (choice) m.data = { ...(m.data ?? {}), choice };
    m.called.push(c);
    this.w.score.points += 3;
    this.answerOf(m, c);
    if (m.need.every((x) => m.called.includes(x))) this.resolve(m, false);
    return null;
  }

  private wrong(c: Contact, m: Matter, right: string): string {
    const base: Record<Contact, string> = {
      notfall: "Notfallmanager hier. Das ist nicht meine Baustelle",
      polizei: "Bundespolizei, Leitstelle. Dafür sind wir nicht zuständig",
      rettung: "Rettungsleitstelle, 112. Gibt es Verletzte? Nein? Dann sind wir die Falschen",
      feuerwehr: "Feuerwehr, Leitstelle. Es brennt nicht? Dann können wir nichts machen",
      stoerung: "Störungsannahme LST. Das ist keine Störung an der Technik",
      zes: "Zentralschaltstelle. Mit der Oberleitung hat das nichts zu tun",
    };
    return `${base[c]}. ${right ? `Rufen Sie ${right} an.` : ""}`;
  }

  private answerOf(m: Matter, c: Contact) {
    const w = this.w, who = NAME[c], r = this.r;
    const eta = (a: number, b: number) => Math.round(a + r() * (b - a));
    const D = (m.data ??= {});
    switch (`${m.kind}:${c}`) {
      case "personen:polizei": D.arr = eta(600, 1200); this.say(who, `Verstanden, Personen im Gleis bei ${m.where}. Eine Streife ist unterwegs, ca. ${this.mm(D.arr)} Minuten. Bitte den Abschnitt bis zu unserer Meldung nur auf Sicht befahren lassen.`); break;
      case "baum:notfall": D.arr = eta(900, 1500); this.say(who, `Notfallmanager, verstanden. Ich fahre raus und bringe die Motorsäge mit, bin in ca. ${this.mm(D.arr)} Minuten da. Gleis bleibt gesperrt, bis ich es freigebe.`); break;
      case "feuer:feuerwehr": this.say(who, w.time && m.called.includes("zes") ? "Feuerwehr rückt aus. Oberleitung ist abgeschaltet? Gut, dann können wir sofort löschen." : "Feuerwehr rückt aus. Wir löschen aber erst, wenn die Oberleitung abgeschaltet und geerdet ist. Bitte bei der Zentralschaltstelle veranlassen."); break;
      case "feuer:zes": this.say(who, "Zentralschaltstelle. Ich schalte den Abschnitt ab, der Notfallmanager erdet vor Ort. Melden Sie sich zum Wiedereinschalten wieder bei mir."); break;
      case "einschalten:zes": this.say(who, "Erdung ist entfernt, ich schalte wieder ein. Strecke ist in ein paar Minuten wieder unter Spannung."); break;
      case "pkw:polizei": D.arr = eta(600, 1200); this.say(who, `Bundespolizei, wir informieren die Landespolizei und den Abschleppdienst. Ca. ${this.mm(D.arr)} Minuten bis vor Ort.`); break;
      case "ol:zes": this.say(who, "Zentralschaltstelle, Störung ist bei uns aufgelaufen. Der Störungstrupp Oberleitung ist alarmiert, ich melde mich, wenn er fertig ist."); break;
      case "notarzt:rettung": D.arr = eta(420, 900); this.say(who, `Rettungsleitstelle, Notarzt und RTW sind alarmiert für ${m.where}. Eintreffen ca. ${this.mm(D.arr)} Minuten.`); break;
      case "polizei:polizei": D.arr = eta(300, 900); this.say(who, `Bundespolizei, Streife kommt zum Bahnsteig, ca. ${this.mm(D.arr)} Minuten. Der Zug bleibt bitte so lange stehen.`); break;
      case "bahnsteig:polizei": this.say(who, `Bundespolizei. Wir kommen mit Sprengstoffspürhund. Bitte ${m.where} sofort sperren, kein Zug an den Bahnsteig. Wir melden uns, wenn er wieder frei ist.`); break;
      case "weiche:stoerung": case "signal:stoerung": case "bue:stoerung": D.arr = eta(600, 1200); this.say(who, `Störungsannahme LST, ist aufgenommen: ${m.title}. Der Techniker ist in ca. ${this.mm(D.arr)} Minuten vor Ort und meldet sich dann bei Ihnen.`); break;
      case "medizin:rettung": D.arr = eta(420, 900); this.say(who, `Rettungsleitstelle. RTW fährt zum Bahnhof ${m.where}, ca. ${this.mm(D.arr)} Minuten. Bitte den Zug dort halten lassen.`); break;
      case "liegen:notfall": this.say(who, D.choice === "techniker" ? "Notfallmanager, verstanden. Ich schicke einen Techniker zum Zug, er macht ihn notdürftig fahrbereit. Rechnen Sie mit 30 bis 50 Minuten." : "Notfallmanager, verstanden. Ich bestelle die Hilfslok, sie kommt als Lokzug von vorne. Sie fragt Sie dann nach dem Befehl für die Sperrfahrt."); break;
      case "notruf:polizei": D.arr = eta(480, 900); this.say(who, `Bundespolizei, wir schicken eine Streife zu ${m.where}, ca. ${this.mm(D.arr)} Minuten.`); break;
      case "notruf:notfall": D.arr = eta(480, 900); this.say(who, `Notfallmanager, ich fahre hin und schaue mir das an, ca. ${this.mm(D.arr)} Minuten.`); break;
      default: this.say(who, "Verstanden, wir kümmern uns.");
    }
  }

  // Alle nötigen Stellen sind informiert: Ablauf startet
  private resolve(m: Matter, auto: boolean) {
    const w = this.w, r = this.r, D = (m.data ??= {});
    const arr = D.arr ?? (auto ? 0 : 600 + r() * 600);
    m.done = true; m.at = w.time + arr;
    const H = () => w.ext.happenings.find((h) => h.id === m.ref);
    switch (m.kind) {
      case "personen": case "baum": case "pkw": case "ol": {
        const h = H(); if (!h) return;
        h.until = w.time + arr + (h.work ?? 900);
        this.fixFault("event", h.id, h.until);
        if (m.kind === "pkw") for (const c of w.ext.crossings) if (c.edges[0] === h.edges[0]) c.blockedUntil = h.until;
        if (!auto) this.later.push({ at: h.until - 30, who: NAME[m.need[0]], text: m.kind === "personen" ? "Die Personen sind aus dem Gleisbereich entfernt, Strecke ist frei." : m.kind === "baum" ? "Baum ist zersägt und aus dem Gleis, Oberleitung ist in Ordnung. Sie können das Gleis wieder freigeben." : m.kind === "pkw" ? "Pkw ist abgeschleppt, der Bahnübergang ist frei." : "Oberleitung ist repariert, Strecke wieder unter Spannung." });
        break;
      }
      case "feuer": {
        const h = H(); if (!h) return;
        h.until = w.time + arr + (h.work ?? 1500);
        h.keep = !auto; // nach dem Löschen muss die Zes wieder einschalten
        this.fixFault("event", h.id, h.until);
        if (!auto) this.later.push({ at: h.until - 30, who: "Feuerwehr", text: "Feuer ist aus, wir rücken ab. Der Notfallmanager hebt die Erdung auf, dann kann die Zentralschaltstelle wieder einschalten.", ev: "feueraus", m: h.id });
        break;
      }
      case "einschalten": {
        const h = H(); if (!h) return;
        h.keep = false; h.until = w.time + (auto ? 0 : 180);
        this.fixFault("event", h.id, h.until);
        break;
      }
      case "notarzt": case "polizei": {
        const h = H(); if (!h) return;
        const t = w.trains.find((x) => x.id === D.train);
        h.until = w.time + arr + (h.work ?? 600);
        if (t) { t.dwellUntil = t.dwellUntil > w.time + 1e6 ? h.until : Math.max(t.dwellUntil, h.until); t.faultUntil = h.until; }
        this.fixFault("event", h.id, h.until);
        if (!auto) this.later.push({ at: h.until - 30, who: NAME[m.need[0]], text: m.kind === "notarzt" ? "Patient ist versorgt und im RTW, der Zug kann weiterfahren." : "Einsatz beendet, der Zug kann weiterfahren." });
        break;
      }
      case "bahnsteig": {
        const dur = 1800 + r() * 900;
        w.ext.customHappening("bahnsteig", `Polizeieinsatz in ${w.g.stations[D.st].name} (${D.what}): Gleis ${D.tr} gesperrt`, D.edges, dur, true, undefined, D.st);
        w.note("Polizei", `${w.g.stations[D.st].name} Gleis ${D.tr} gesperrt (${D.what})`);
        if (!auto) this.later.push({ at: w.time + dur - 30, who: "Bundespolizei", text: `Entwarnung: ${D.what} war harmlos. Gleis ${D.tr} kann wieder freigegeben werden.` });
        break;
      }
      case "weiche": case "signal": case "bue": {
        const f = w.faults.find((x) => x.id === m.ref);
        if (!f) return;
        f.until = w.time + arr + (D.work ?? 600);
        f.text = f.text.replace(/, (Techniker|Störungstrupp) .*$/, "") + `, Techniker ca. ${this.mm(f.until - w.time)} min`;
        if (m.kind === "bue") { const c = w.ext.crossings.find((x) => x.id === f.target); if (c) c.faultUntil = f.until; }
        if (!auto) this.later.push({ at: w.time + arr, who: "Techniker LST", text: `Bin vor Ort an ${m.title.replace(/^(Weichenstörung|Signalstörung|BÜ-Störung) /, "")}, fange mit der Entstörung an.` });
        break;
      }
      case "medizin": {
        const t = w.trains.find((x) => x.id === D.train);
        if (!t || !t.medStop) return;
        const rtwAt = w.time + arr;
        t.medStop.rtwAt = rtwAt;
        // steht der Zug schon am Bahnsteig und wartet, verlängert sich der Halt bis zur Versorgung
        if (t.dwelling && t.stops[t.stopIdx]?.st === t.medStop.st && t.fault === "Wartet auf den Rettungsdienst") {
          t.dwellUntil = rtwAt + t.medStop.sec; t.faultUntil = t.dwellUntil; t.fault = "Rettungsdienst im Zug"; t.medStop = undefined;
        }
        break;
      }
      case "liegen": {
        w.rescueRequest(D.train, false, D.choice === "techniker");
        if (auto) w.log("Notfallmanager hat die Hilfslok selbst angefordert", "info");
        break;
      }
      case "notruf": {
        const n = w.ops.notruf;
        if (n && n.phase === 0) n.clearAt = w.time + arr + 120 + r() * 300;
        break;
      }
    }
  }

  // Störung bzw. Ereignis in der Störungsliste auf das neue Ende setzen
  private fixFault(kind: string, target: number, until: number) {
    for (const f of this.w.faults) if (f.kind === kind && f.target === target) f.until = until;
  }

  step() {
    const w = this.w;
    for (const m of this.open()) {
      if (w.time - m.t < TIMEOUT) continue;
      const miss = m.need.filter((x) => !m.called.includes(x));
      m.called = [...m.need];
      w.score.points -= 10;
      if (m.choice && !(m.data?.choice)) m.data = { ...(m.data ?? {}), choice: m.choice.opts[0].k };
      this.say("Notfallmanager", `${m.title} (${m.where}): Da hat sich seit 20 Minuten niemand gekümmert. Ich habe ${miss.map((x) => NAME[x]).join(" und ")} selbst verständigt. (−10 Punkte)`);
      this.resolve(m, false);
    }
    for (const L of this.later.filter((x) => x.at <= w.time)) {
      this.say(L.who, L.text);
      if (L.ev === "feueraus") {
        const h = w.ext.happenings.find((x) => x.id === L.m);
        if (h) { h.until = w.time + 1e7; this.fixFault("event", h.id, h.until); this.add("einschalten", `Oberleitung nach Brand wieder einschalten`, h.text.split(":")[0].replace(/^Feuerwehreinsatz an der Strecke /, ""), ["zes"], h.id, true); }
      }
    }
    this.later = this.later.filter((x) => x.at > w.time);
  }
}
