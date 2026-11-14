// Regelgleise je Linie, Richtung und Bahnhof aus einem störungsfreien Automatiktag ableiten
import { readFileSync, writeFileSync } from "fs";
import { buildCorridor } from "../src/data/corridor";
import { buildTrips } from "../src/sim/timetable";
import { World } from "../src/sim/world";
import { DEFAULT_FEATURES } from "../src/sim/extras";

const g = buildCorridor();
const raw = JSON.parse(readFileSync(new URL("../public/data/timetable.json", import.meta.url), "utf8"));
const trips = buildTrips(g, raw, 17);
for (const t of trips) t.initialDelay = 0;
const w = new World(g, trips, 3 * 3600);
w.faultRate = 0;
w.ext.start({ ...DEFAULT_FEATURES, faults: 0, weather: false, bue: false, baustellen: false, ereignisse: false, anschluss: false }, 3 * 3600);
for (const s of g.signals) s.auto = true;
const count = new Map<string, Map<string, number>>();
let k = 0;
while (w.time < 24.5 * 3600) {
  w.step(0.5);
  if (++k % 10) continue;
  for (const t of w.trains) {
    if (!t.dwelling || t.cat === "G") continue;
    const s = t.stops[t.stopIdx];
    const tr = g.edges[t.body[t.body.length - 1]].platform?.track;
    if (!s || !tr || s.st !== g.edges[t.body[t.body.length - 1]].platform?.st) continue;
    const key = `${t.trip.line}|${t.dir}|${s.st}|${t.trip.to}`;
    const m = count.get(key) ?? new Map();
    m.set(tr, (m.get(tr) ?? 0) + 1);
    count.set(key, m);
  }
}
const out: Record<string, string> = {};
for (const [key, m] of [...count].sort()) out[key] = [...m].sort((a, b) => b[1] - a[1])[0][0];
writeFileSync(new URL("../public/data/tracks.json", import.meta.url), JSON.stringify(out, null, 0));
console.log(Object.keys(out).length, "Regelgleise");
