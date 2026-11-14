import { Train, World } from "./world";

// Zugfunk zwischen Fahrdienstleiter (Spieler) und Triebfahrzeugführer.
// Antworten werden aus der aktuellen Lage des Zuges zusammengesetzt, nicht aus festen Texten.

export interface RadioCmd { id: string; label: string; }

export const RADIO_CMDS: RadioCmd[] = [
  { id: "lage", label: "Wo stehen Sie?" },
  { id: "grund", label: "Was ist los?" },
  { id: "halt", label: "Sofort anhalten" },
  { id: "weiter", label: "Weiterfahrt erlaubt" },
  { id: "anschluss", label: "Anschluss abwarten (3 min)" },
  { id: "zs1", label: "Vorbeifahrt am Halt zeigenden Signal" },
  { id: "sicht", label: "Auf Sicht fahren" },
  { id: "verstanden", label: "Danke, Ende" },
];

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const mmss = (s: number) => (s < 60 ? "eben erst" : `${Math.floor(s / 60)} Minute${Math.floor(s / 60) === 1 ? "" : "n"}`);

function intro(t: Train): string {
  return pick([`Hier ${t.no}, ${t.driver}.`, `${t.no} hört.`, `Ja, ${t.no} hier.`, `${t.driver}, Zug ${t.no}.`]);
}

function situation(w: World, t: Train): string {
  const pos = w.position(t);
  const parts: string[] = [];
  if (t.fault && t.faultUntil > w.time) {
    const left = Math.max(1, Math.round((t.faultUntil - w.time) / 60));
    if (t.fault === "Türstörung") parts.push(pick([`Ich habe eine Türstörung, eine Tür schließt nicht. Ich schätze noch ${left} Minuten.`, `Türstörung im zweiten Wagen, ich bin dran. Etwa ${left} Minuten.`]));
    else parts.push(pick([`${t.fault}. Ich bin am Prüfen, voraussichtlich noch ${left} Minuten.`, `Wir haben eine ${t.fault.toLowerCase()}, die Fehlersuche läuft, rechnen Sie mit ${left} Minuten.`]));
  }
  if (t.hold) parts.push("Ich stehe wie angewiesen und warte auf Ihre Freigabe.");
  if (!t.fault && !t.hold) {
    if (t.dwelling) {
      if (w.time < t.dwellUntil) parts.push(pick(["Fahrgastwechsel läuft.", "Wir sind am Bahnsteig, die Leute steigen noch ein.", "Fahrgastwechsel, gleich abfahrbereit."]));
      else if (t.nextSig && !w.il.proceeds(w.il.sig(t.nextSig), w.time)) parts.push(pick([`Ich bin abfahrbereit, mein Ausfahrsignal ${w.il.sig(t.nextSig).name} zeigt aber Halt.`, `Türen sind zu, ich warte auf Fahrt am ${w.il.sig(t.nextSig).name}.`]));
      else parts.push("Abfahrbereit.");
    } else if (t.v < 0.1 && t.nextSig && t.distNextSig < 80) {
      parts.push(pick([`Ich stehe vor dem ${w.il.sig(t.nextSig).name}, das zeigt Halt. Ich warte ${t.waitRed < 60 ? "erst kurz" : `seit ${mmss(t.waitRed)}`}.`, `Ich stehe am Halt zeigenden ${w.il.sig(t.nextSig).name}${t.waitRed < 60 ? "" : `, schon ${mmss(t.waitRed)}`}.`]));
    } else if (t.v < 0.1) parts.push("Ich stehe gerade.");
    else parts.push(pick([`Ich fahre mit ${Math.round(t.v * 3.6)} km/h.`, `Bin mit ${Math.round(t.v * 3.6)} unterwegs.`]));
  }
  if (t.sight) parts.push("Ich fahre auf Sicht.");
  void pos;
  return parts.join(" ");
}

function where(w: World, t: Train): string {
  const p = w.position(t);
  return pick([`Ich bin ${p.text}, Kilometer ${p.km.toFixed(1).replace(".", ",")}, ${p.track}.`, `${p.text[0].toUpperCase()}${p.text.slice(1)}, etwa bei Kilometer ${p.km.toFixed(1).replace(".", ",")} (${p.track}).`]);
}

function delayText(w: World, t: Train): string {
  const d = Math.round(w.liveDelay(t) / 60);
  if (d <= 1) return pick(["Wir sind pünktlich.", "Ich liege im Plan."]);
  const causes = Object.entries(t.causes).sort((a, b) => b[1] - a[1]).filter(([, s]) => s >= 30);
  const c = causes[0];
  if (!c) return `Ich habe etwa ${d} Minuten Verspätung, warum genau, kann ich nicht sagen.`;
  return `Ich habe ${d} Minuten Verspätung, vor allem durch: ${c[0]} (${Math.round(c[1] / 60)} min).`;
}

function load(w: World, t: Train): string {
  const h = Math.floor(((w.time % 86400) + 86400) % 86400 / 3600);
  if (t.cat === "G") return `Ich habe ${t.trip.mass ?? 1500} Tonnen am Haken, ${Math.round(t.len)} Meter lang.`;
  const rush = (h >= 6 && h <= 8) || (h >= 16 && h <= 18);
  return rush ? pick(["Der Zug ist ziemlich voll, Berufsverkehr.", "Sehr voll heute, die Leute stehen in den Gängen."]) : pick(["Mäßig besetzt.", "Gut die Hälfte der Plätze ist belegt.", "Ziemlich leer gerade."]);
}

export function radio(w: World, t: Train, input: string, cmd?: string): string {
  const say = (txt: string) => {
    t.radio.push({ t: w.time, from: "tf", text: txt });
    if (t.radio.length > 30) t.radio.shift();
    return txt;
  };
  t.radio.push({ t: w.time, from: "fdl", text: input });
  const q = input.toLowerCase();
  const has = (...k: string[]) => k.some((x) => q.includes(x));
  const c = cmd ?? (
    has("ersatzsignal", "zs1", "zs 1", "vorbeifahr", "am halt zeigenden", "befehl") ? "zs1"
      : has("auf sicht") ? "sicht"
      : has("sofort anhalten", "nothalt", "stopp", "anhalten", "bleiben sie stehen", "halten sie") ? "halt"
      : has("anschluss", "warten sie") ? "anschluss"
      : has("weiterfahrt", "fahren sie weiter", "fahren sie los", "freigabe", "weiter fahren") ? "weiter"
      : has("wo ", "wo?", "position", "standort", "wo sind", "wo stehen") ? "lage"
      : has("verspät", "minuten") ? "versp"
      : has("tür") ? "tuer"
      : has("voll", "fahrgäste", "besetzt", "last", "tonnen", "gewicht") ? "last"
      : has("ziel", "wohin", "nach wo") ? "ziel"
      : has("geschwindigkeit", "schnell", "km/h") ? "tempo"
      : has("warum", "wieso", "was ist", "grund", "problem", "los?", "status", "lage") ? "grund"
      : has("danke", "ende", "verstanden") ? "verstanden"
      : has("hallo", "guten", "moin", "servus", "kommen") ? "hallo"
      : "?");
  switch (c) {
    case "lage": return say(`${intro(t)} ${where(w, t)} ${situation(w, t)}`);
    case "grund": return say(`${intro(t)} ${situation(w, t)} ${where(w, t)}`);
    case "versp": return say(`${intro(t)} ${delayText(w, t)}`);
    case "tuer": return say(t.fault === "Türstörung" ? `${intro(t)} ${situation(w, t)}` : `${intro(t)} Türen sind in Ordnung.`);
    case "last": return say(`${intro(t)} ${load(w, t)}`);
    case "ziel": return say(`${intro(t)} Ich fahre nach ${t.trip.to}${t.trip.turnInto ? `, wende dann als ${t.trip.turnInto.no}` : ""}.`);
    case "tempo": return say(`${intro(t)} Aktuell ${Math.round(t.v * 3.6)} km/h, mein Zug darf ${Math.round(t.vmax * 3.6)}.`);
    case "halt":
      t.hold = true;
      w.log(`Funk: ${t.no} angewiesen anzuhalten`, "warn");
      return say(t.v > 1 ? `${t.no}, verstanden, ich halte an. Bremse.` : `${t.no}, verstanden, ich bleibe stehen.`);
    case "weiter":
      if (!t.hold) return say(`${intro(t)} Ich hatte keinen Haltauftrag. ${situation(w, t)}`);
      t.hold = false;
      w.log(`Funk: ${t.no} darf weiterfahren`, "info");
      return say(`${t.no}, Weiterfahrt verstanden. ${t.nextSig && !w.il.proceeds(w.il.sig(t.nextSig), w.time) ? `Mein ${w.il.sig(t.nextSig).name} zeigt aber noch Halt.` : ""}`);
    case "anschluss": {
      const m = q.match(/(\d+)\s*min/);
      const min = m ? Math.min(20, Number(m[1])) : 3;
      t.extraDwell = min * 60;
      w.log(`Funk: ${t.no} wartet beim nächsten Halt ${min} min auf Anschluss`, "info");
      return say(`${t.no}, verstanden, ich warte beim nächsten Halt ${min} Minuten auf den Anschluss.`);
    }
    case "zs1": {
      if (!t.nextSig || t.distNextSig > 400) return say(`${intro(t)} Ich stehe vor keinem Halt zeigenden Signal, das brauche ich nicht.`);
      const why = w.giveZs1(t.nextSig);
      if (why) return say(`${intro(t)} Das geht so nicht: ${why}.`);
      return say(`${t.no}, Vorbeifahrt am Halt zeigenden ${w.il.sig(t.nextSig).name} verstanden, ich fahre auf Sicht bis zum nächsten Hauptsignal, höchstens 40.`);
    }
    case "sicht":
      t.sight = true;
      return say(`${t.no}, verstanden, Fahrt auf Sicht.`);
    case "verstanden": return say(pick([`${t.no}, Ende.`, "Verstanden, Ende.", "Alles klar, Ende."]));
    case "hallo": return say(`${intro(t)} Kommen.`);
    default: return say(pick([`${t.no}, ich habe Sie schlecht verstanden, bitte wiederholen.`, `Hier ${t.no}, das kam nur abgehackt an. Was soll ich tun?`]));
  }
}
