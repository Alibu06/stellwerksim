// Testlauf ohne Grafik: alle Signale in Zuglenkung, ein Spieltag im Zeitraffer
(globalThis as any).DBGCH = !!process.env.DBGCH;
import { readFileSync } from "fs";
import { buildCorridor } from "../src/data/corridor";
import { buildTrips } from "../src/sim/timetable";
import { World } from "../src/sim/world";
import { DEFAULT_FEATURES } from "../src/sim/extras";

const g = buildCorridor();
const raw = JSON.parse(readFileSync(new URL("../public/data/timetable.json", import.meta.url), "utf8"));
const trips = buildTrips(g, raw, 17);
const start = Number(process.argv[2] ?? 5) * 3600, hours = Number(process.argv[3] ?? 4);
const w = new World(g, trips, start); const ALL: string[] = []; const _log = w.log.bind(w); w.log = (t: string, k?: any) => { ALL.push(`${Math.floor(w.time / 3600)}:${String(Math.floor(w.time / 60) % 60).padStart(2, "0")} ${t}`); _log(t, k); }; w.faultRate = Number(process.env.F ?? 1);
w.trackPlan = JSON.parse(readFileSync(new URL("../public/data/tracks.json", import.meta.url), "utf8"));
w.ext.start({ ...DEFAULT_FEATURES, faults: w.faultRate }, start);
for (const s of g.signals) s.auto = true;
if (process.env.NOLUE || process.env.NOOPS) { w.ops.lueConflict = () => null; for (const t of trips) if (t.special === "Lü") t.special = undefined; }
if (process.env.NOOPS) w.ops.step = () => {};
if (process.env.MAN) { w.zugmeldung = false; w.manualAreas = new Set(["TR","SB","HN","BL","EI","AU","WI","BZ"]); }
console.log("Knoten", g.nodes.length, "Kanten", g.edges.length, "Signale", g.signals.length, "Fahrten", trips.length);
const noPath = g.signals.filter((s) => !(w.il.paths.get(s.id)?.length));
console.log("Signale ohne Fahrstraße:", noPath.map((s) => s.name).join(", "));
if (process.env.ROT) w.ops.nextRotte = Number(process.env.ROT) * 3600;
let ol = Number(process.env.OL ?? 0) * 3600;
let lastH = -1; let brk = Number(process.env.BRK ?? 0) * 3600;
while (w.time < start + hours * 3600) {
  w.step(0.5);
  if (ol && w.time >= ol) { const r = w.ext.startHappening("ol"); console.log("OL", r ?? "ok"); ol = r ? w.time + 300 : 0; }
  if (brk && w.time >= brk) { const r = w.breakdown(); console.log("BRK", r ?? "ok"); brk = r ? w.time + 300 : 0; }
  if (process.env.ANS) for (const c of w.ops.calls) if (!c.answered && w.time - c.t > 60) { const r = w.ops.answer(c.id, c.opts[0].k); console.log("ANS", c.kind, c.text.slice(0, 80), "->", r ?? "ok"); }
  const h = Math.floor(w.time / 3600);
  if (h !== lastH) {
    lastH = h;
    const stuck = w.trains.filter((t) => t.waitRed > 600).map((t) => `${t.no}@${w.il.sig(t.nextSig).name}`);
    console.log(`${h}:00 Züge ${w.trains.length} fertig ${w.score.trainsDone} pünktl ${w.score.punctual} Punkte ${w.score.points} verpasst ${w.score.missedStops} Vorfälle ${w.score.incidents} hängend: ${stuck.join(" ")}`);
  }
}
for (const e of w.events.filter((e) => e.kind !== "info").slice(-25)) console.log(Math.floor(e.t / 3600) + ":" + String(Math.floor(e.t / 60) % 60).padStart(2, "0"), e.text);
if (process.env.OPS) for (const t of ALL) if (/☎|Netzleitstelle|Lü|Ersatzverkehr|umgeleitet|Personal|Bauz|Mess |Lz |DbZ|Begegnung|Teilausfall|Bereitstellung|abgestellt|bereit|EK |Abstell|gekuppelt|Kuppeln|abgehängt|Notruf|Hilfslok|liegengeblieben|Sperrfahrt|geschleppt|liegt fest|notdürftig|Rotte|Sperrung|Schnellbremsung|Oberleitung|SEV|Ersatz/.test(t)) console.log("OPS", t);
if (process.env.ALL) for (const t of ALL) if (/Wetter|Baustelle|Ereignis|Feuer|Personen|Baum|Pkw|Notarzt|Polizei|gestört|Anschluss|Disposition|Gleisänderung/.test(t)) console.log(t);
if (process.env.OPS) for (const t of w.trains.filter((x) => x.towed || x.rescue || x.fault)) console.log("STATE", t.no, w.position(t).text, w.status(t).map((x) => x.text).join(" | "));
if (process.env.NEAR) { const [a, b] = process.env.NEAR.split(",").map(Number); for (const t of w.trains.filter((x) => { const s = w.headS(x); return s > a && s < b; })) console.log("NEAR", t.no, Math.round(w.headS(t)), t.dir, w.position(t).text, "|", w.status(t).map((x) => x.text).join(" | ")); }
if (process.env.DUMP) { const [a, b] = process.env.DUMP.split(","); for (const t of ALL) { const hm = t.split(" ")[0]; if (hm >= a && hm <= b && hm.length === a.length) console.log("DUMP", t); } }
if (process.env.WHY) for (const nm of process.env.WHY.split(",")) { const s = g.signals.find((x) => x.name === nm)!; for (const p of [...(w.il.paths.get(s.id) ?? [])].sort((a, b) => Number(!!process.env.PREF && b.endSig && w.il.sig(b.endSig as any)?.name === process.env.PREF) - Number(!!process.env.PREF && a.endSig && w.il.sig(a.endSig as any)?.name === process.env.PREF))) console.log("WHY", nm, "->", p.endSig ? w.il.sig(p.endSig).name : p.endSig, ":", w.setRoute(s.id, p.endSig as any) ?? "OK"); }
if (process.env.SW) for (const nm of process.env.SW.split(",")) { const n = g.nodes.find((x) => x.swName === nm)!; for (const e of [...n.east, ...n.west]) { const E = g.edges[e]; const tr = w.trains.find((t) => t.body.includes(e)); const r = E.lock ? w.il.routes.get(E.lock) : undefined; console.log("SW", nm, "edge", e, "occ", E.occ, "by", tr?.no, "lock", E.lock, r ? `route ${w.il.sig(r.path.sig).name}->${r.path.endSig ? w.il.sig(r.path.endSig).name : ""} train ${w.trains.find((t) => t.id === r.train)?.no}` : "", "ovl", E.overlap); } }
if (process.env.RT) for (const r of w.il.routes.values()) { const tr = w.trains.find((t) => t.id === r.train); if (tr && process.env.RT.split(",").includes(tr.no)) console.log("RT", tr.no, w.il.sig(r.path.sig).name, "->", r.path.endSig ? w.il.sig(r.path.endSig).name : r.path.endPortal, "used", r.used); }
if (process.env.LK) { const [a, b] = process.env.LK.split(",").map(Number); for (const E of g.edges) { const sa = g.nodes[E.a].s ?? -1e9, sb = g.nodes[E.b].s ?? -1e9; if (Math.min(sa, sb) < b && Math.max(sa, sb) > a && (E.lock || E.occ || E.overlap)) { const r = E.lock > 0 ? w.il.routes.get(E.lock) : undefined; console.log("LK", E.id, Math.round(sa), Math.round(sb), "y", g.nodes[E.a].y, g.nodes[E.b].y, "occ", E.occ, w.trains.find((t) => t.body.includes(E.id))?.no ?? "", "lock", E.lock, r ? `${w.il.sig(r.path.sig).name}->${r.path.endSig ? w.il.sig(r.path.endSig).name : ""} ${w.trains.find((t) => t.id === r.train)?.no ?? "-"}` : "", "ovl", E.overlap, E.platform ? "P" + E.platform.track : ""); } } }
if (process.env.COST) for (const no of process.env.COST.split(",")) { const t = w.trains.find((x) => x.no === no); if (!t) continue; const W: any = w; const goal = W.goalKey(t); for (const p of w.il.paths.get(t.nextSig) ?? []) console.log("COST", no, w.il.sig(t.nextSig).name, "->", p.endSig ? w.il.sig(p.endSig).name : p.endPortal, Math.round(W.pathCost(p, t, goal)), "single", W.singleTrackBlocked(t, p), "grab", W.grabsLastTrack(t, p), "chk", w.il.check(p), "wait", Math.round(t.waitRed)); }
