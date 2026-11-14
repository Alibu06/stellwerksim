// Testlauf ohne Grafik: alle Signale in Zuglenkung, ein Spieltag im Zeitraffer
import { readFileSync } from "fs";
import { buildCorridor } from "../src/data/corridor";
import { buildTrips } from "../src/sim/timetable";
import { World } from "../src/sim/world";
import { DEFAULT_FEATURES } from "../src/sim/extras";

const g = buildCorridor();
const raw = JSON.parse(readFileSync(new URL("../public/data/timetable.json", import.meta.url), "utf8"));
const trips = buildTrips(g, raw, 17);
const start = Number(process.argv[2] ?? 5) * 3600, hours = Number(process.argv[3] ?? 4);
const w = new World(g, trips, start); const ALL: string[] = []; const _log = w.log.bind(w); w.log = (t: string, k?: any) => { ALL.push(t); _log(t, k); }; w.faultRate = Number(process.env.F ?? 1);
w.trackPlan = JSON.parse(readFileSync(new URL("../public/data/tracks.json", import.meta.url), "utf8"));
w.ext.start({ ...DEFAULT_FEATURES, faults: w.faultRate }, start);
for (const s of g.signals) s.auto = true;
if (process.env.MAN) { w.zugmeldung = false; w.manualAreas = new Set(["TR","SB","HN","BL","EI","AU","WI","BZ"]); }
console.log("Knoten", g.nodes.length, "Kanten", g.edges.length, "Signale", g.signals.length, "Fahrten", trips.length);
const noPath = g.signals.filter((s) => !(w.il.paths.get(s.id)?.length));
console.log("Signale ohne Fahrstraße:", noPath.map((s) => s.name).join(", "));
let lastH = -1;
while (w.time < start + hours * 3600) {
  w.step(0.5);
  const h = Math.floor(w.time / 3600);
  if (h !== lastH) {
    lastH = h;
    const stuck = w.trains.filter((t) => t.waitRed > 600).map((t) => `${t.no}@${w.il.sig(t.nextSig).name}`);
    console.log(`${h}:00 Züge ${w.trains.length} fertig ${w.score.trainsDone} pünktl ${w.score.punctual} Punkte ${w.score.points} verpasst ${w.score.missedStops} Vorfälle ${w.score.incidents} hängend: ${stuck.join(" ")}`);
  }
}
for (const e of w.events.filter((e) => e.kind !== "info").slice(-25)) console.log(Math.floor(e.t / 3600) + ":" + String(Math.floor(e.t / 60) % 60).padStart(2, "0"), e.text);
if (process.env.ALL) for (const t of ALL) if (/Wetter|Baustelle|Ereignis|Feuer|Personen|Baum|Pkw|Notarzt|Polizei|gestört|Anschluss|Disposition|Gleisänderung/.test(t)) console.log(t);
