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
const PL = process.env.PLAYER && process.env.PLAYER !== "1" ? new Set(process.env.PLAYER.split(",")) : null;
for (const s of g.signals) s.auto = !process.env.PLAYER || s.kind === "block" || (!!PL && !PL.has(s.name.slice(0, 2)));
if (PL) w.manualAreas = new Set(PL); else if (process.env.PLAYER) { w.zugmeldung = false; w.manualAreas = new Set(["TR","SB","HN","BL","EI","AU","WI","BZ"]); }
if (process.env.NOLUE || process.env.NOOPS) { w.ops.lueConflict = () => null; for (const t of trips) if (t.special === "Lü") t.special = undefined; }
if (process.env.NOOPS) w.ops.step = () => {};
if (process.env.MAN) { w.zugmeldung = false; w.manualAreas = new Set(["TR","SB","HN","BL","EI","AU","WI","BZ"]); }
console.log("Knoten", g.nodes.length, "Kanten", g.edges.length, "Signale", g.signals.length, "Fahrten", trips.length);
const noPath = g.signals.filter((s) => !(w.il.paths.get(s.id)?.length));
console.log("Signale ohne Fahrstraße:", noPath.map((s) => s.name).join(", "));
if (process.env.ROT) w.ops.nextRotte = Number(process.env.ROT) * 3600;
let ol = Number(process.env.OL ?? 0) * 3600;
const ovlStill = new Map<string, number>(); const greenSince = new Map<number, number>(); const seenBad = new Set<string>();
function chk() {
  const W: any = w;
  if (!w.phone.open().length) {
    for (const t of w.trains) if ((t.dwelling && t.dwellUntil - w.time > 86400) || (t.fault && t.faultUntil - w.time > 86400)) { const k = "inf" + t.id; if (!seenBad.has(k)) { seenBad.add(k); console.log("INFSTUCK", hm(), t.no, t.fault, w.status(t).map((x) => x.text).join(" | ")); } }
    const nr = w.ops.notruf; if (nr && nr.clearAt === Infinity && !w.ops.calls.some((c) => !c.answered)) { const k = "nr" + nr.from + nr.phase; if (!seenBad.has(k)) { seenBad.add(k); console.log("NOTRUFSTUCK", hm(), nr.from, nr.phase, nr.reason); } }
    for (const f of w.faults) if (f.until - w.time > 86400) { const k = "inff" + f.kind + f.target; if (!seenBad.has(k)) { seenBad.add(k); console.log("INFFAULT", hm(), f.kind, f.text); } }
  }
  for (const t of w.trains) {
    const s = t.nextSig ? w.il.sig(t.nextSig) : undefined;
    if (s && t.v < 0.1 && !t.dwelling && t.distNextSig < 60 && w.il.proceeds(s, w.time) && !t.shunt) {
      const since = greenSince.get(t.id) ?? w.time; greenSince.set(t.id, since);
      if (w.time - since > 60 && !seenBad.has("g" + t.id)) { seenBad.add("g" + t.id); const la = W.lookahead ? W.lookahead(t) : null; console.log("GREENSTOP", hm(), t.no, "hold", t.hold, "fault", t.faultUntil > w.time ? t.fault : "", "sight", t.sight, s.name, Math.round(t.distNextSig), w.position(t).text, "|", w.status(t).map((x: any) => x.text).join(" | "), la ? JSON.stringify({ sd: la.stopDist, pf: la.platformStop }) : ""); }
    } else greenSince.delete(t.id);
  }
  for (const E of g.edges) {
    if (E.overlap) { const r = w.il.routes.get(E.overlap); const tr = r && w.trains.find((x) => x.id === r.train); const k = "o" + E.id + ":" + E.overlap;
      if (!r) { if (!seenBad.has(k)) { seenBad.add(k); console.log("OVL-NOROUTE", hm(), E.id); } }
      else if (r.used && !tr) { if (!seenBad.has(k)) { seenBad.add(k); console.log("OVL-NOTRAIN", hm(), E.id, w.il.sig(r.path.sig).name); } }
      else if (tr && tr.v < 0.05) { const st = (ovlStill.get(k) ?? w.time); ovlStill.set(k, st); if (w.time - st > 90 && !seenBad.has(k)) { seenBad.add(k); console.log("OVL-STILL", hm(), E.id, w.il.sig(r.path.sig).name, "->", r.path.endSig ? w.il.sig(r.path.endSig).name : "", tr.no, "dwell", tr.dwelling, "stillT", Math.round((tr as any).stillT ?? -1), "shunt", !!tr.shunt, "parked", !!tr.parked, w.position(tr).text, "|", w.status(tr).map((x: any) => x.text).join(" | ")); } }
      else ovlStill.delete(k); }
    if (E.occ && !w.trains.some((x) => x.body.includes(E.id))) { const k = "occ" + E.id; if (!seenBad.has(k)) { seenBad.add(k); console.log("GHOSTOCC", hm(), E.id, Math.round(g.nodes[E.a].s ?? 0), "y", g.nodes[E.a].y, "occ", E.occ); } }
    if (E.lock < 0) { const tr = w.trains.find((x) => x.id === -E.lock); if (!tr || !tr.shunt) { const k = "l" + E.id + ":" + E.lock; if (!seenBad.has(k)) { seenBad.add(k); console.log("GHOSTLOCK-", hm(), E.id, Math.round(g.nodes[E.a].s ?? 0), "train", tr?.no ?? "weg", tr ? "noshunt" : ""); } } }
    else if (E.lock > 0 && !w.il.routes.has(E.lock)) { const k = "r" + E.id + ":" + E.lock; if (!seenBad.has(k)) { seenBad.add(k); console.log("GHOSTLOCK+", hm(), E.id, Math.round(g.nodes[E.a].s ?? 0)); } }
  }
}
function hm() { return `${Math.floor(w.time / 3600)}:${String(Math.floor(w.time / 60) % 60).padStart(2, "0")}`; }
const holdS = new Map<number, boolean>(); const qWhy = new Map<number, string>(); const qSeen = new Set<string>();
function player() {
  const W: any = w;
  for (const t of w.trains) {
    if (!t.nextSig || t.distNextSig > 1500 || t.shunt || (t.distNextSig < 30 && t.v > 0.5)) continue;
    const s = w.il.sig(t.nextSig);
    if (s.auto || s.route || w.queued.some((q) => q.start === s.id)) continue;
    if (t.dwelling && t.dwellUntil - w.time > 60) continue;
    if (t.dwelling && t.stopIdx === t.stops.length - 1 && !t.trip.exitPortal) continue;
    const paths = w.il.paths.get(s.id) ?? [];
    if (!paths.length) continue;
    const goal = W.goalKey(t);
    const best = W.bestPath(t, paths) ?? [...paths].sort((a: any, b: any) => W.pathCost(a, t, goal) - W.pathCost(b, t, goal))[0];
    const end = best.endSig || best.endPortal;
    const why = w.setRoute(s.id, end);
    if (process.env.PDBG) console.log("PSET", hm(), t.no, s.name, "->", typeof end === "string" ? end : w.il.sig(end).name, why ?? "OK", "dwell", t.dwelling, "parked", !!t.parked, "bereit", !!t.bereit, "stop", t.stopIdx, t.stops.length, "dist", Math.round(t.distNextSig), w.position(t).text);
    if (why && w.canQueue(why)) { w.queueRoute(s.id, end); qWhy.set(s.id, why); }
  }
  for (const q of w.queued) if (w.time - q.t > 240) { const k = q.start + ":" + q.t; if (qSeen.has(k)) continue; qSeen.add(k); const why = w.setRoute(q.start, q.end) ?? "OK jetzt"; console.log("QSTUCK", hm(), w.il.sig(q.start).name, "->", typeof q.end === "string" ? q.end : w.il.sig(q.end).name, "|", qWhy.get(q.start), "|", why, "|", w.trains.find((t) => t.nextSig === q.start)?.no ?? ""); }
}
let lastH = -1; let brk = Number(process.env.BRK ?? 0) * 3600;
while (w.time < start + hours * 3600) {
  w.step(0.5);
  if (ol && w.time >= ol) { const r = w.ext.startHappening("ol"); console.log("OL", r ?? "ok"); ol = r ? w.time + 300 : 0; }
  if (brk && w.time >= brk) { const r = w.breakdown(); console.log("BRK", r ?? "ok"); brk = r ? w.time + 300 : 0; }
  if (process.env.ANS && !process.env.NOPHONE) for (const m of w.phone.open()) if (w.time - m.t > 90) for (const c of m.need) if (!m.called.includes(c)) { const r = w.phone.dial(m.id, c, m.choice?.contact === c ? m.choice.opts[0].k : undefined); console.log("DIAL", m.kind, c, r ?? "ok"); }
  if (process.env.ANS) for (const c of w.ops.calls) if (!c.answered && w.time - c.t > 60) { const r = w.ops.answer(c.id, c.kind === "verklemmt" ? "raus" : c.opts[0].k); console.log("ANS", c.kind, c.text.slice(0, 80), "->", r ?? "ok"); }
  if (process.env.CHK && Math.round(w.time) % 30 === 0) chk();
  if (process.env.HOLD) for (const t of w.trains) { if (holdS.get(t.id) !== t.hold) { holdS.set(t.id, t.hold); console.log("HOLD", hm(), t.id, t.no, t.hold, "notruf", JSON.stringify(w.ops.notruf?.trains ?? null)); } }
  if (process.env.PLAYER && Math.round(w.time) % 5 === 0) player();
  const h = Math.floor(w.time / 3600);
  if (h !== lastH) {
    lastH = h;
    const stuck = w.trains.filter((t) => t.waitRed > 600).map((t) => `${t.no}@${w.il.sig(t.nextSig).name}`);
    console.log(`${h}:00 Züge ${w.trains.length} fertig ${w.score.trainsDone} pünktl ${w.score.punctual} Punkte ${w.score.points} verpasst ${w.score.missedStops} Vorfälle ${w.score.incidents} hängend: ${stuck.join(" ")}`);
  }
}
for (const e of w.events.filter((e) => e.kind !== "info").slice(-25)) console.log(Math.floor(e.t / 3600) + ":" + String(Math.floor(e.t / 60) % 60).padStart(2, "0"), e.text);
if (process.env.OPS) for (const t of ALL) if (/☎|Netzleitstelle|Lü|Ersatzverkehr|umgeleitet|Personal|Bauz|Mess |Lz |DbZ|Begegnung|Teilausfall|Bereitstellung|abgestellt|bereit|EK |Abstell|gekuppelt|Kuppeln|abgehängt|Notruf|Hilfslok|liegengeblieben|Sperrfahrt|geschleppt|liegt fest|notdürftig|Rotte|Sperrung|Schnellbremsung|Oberleitung|SEV|Ersatz|Reisende|Rettungsdienst|Notbremse|Bundespolizei|Sturm|Polizei|Tf |Zusatzhalt|wenden|beschwert|📞/.test(t)) console.log("OPS", t);
if (process.env.ALL) for (const t of ALL) if (/Wetter|Baustelle|Ereignis|Feuer|Personen|Baum|Pkw|Notarzt|Polizei|gestört|Anschluss|Disposition|Gleisänderung/.test(t)) console.log(t);
if (process.env.OPS) for (const t of w.trains.filter((x) => x.towed || x.rescue || x.fault)) console.log("STATE", t.no, w.position(t).text, w.status(t).map((x) => x.text).join(" | "));
if (process.env.NEAR) { const [a, b] = process.env.NEAR.split(",").map(Number); for (const t of w.trains.filter((x) => { const s = w.headS(x); return s > a && s < b; })) console.log("NEAR", t.no, Math.round(w.headS(t)), t.dir, w.position(t).text, "|", w.status(t).map((x) => x.text).join(" | ")); }
if (process.env.DUMP) { const [a, b] = process.env.DUMP.split(","); for (const t of ALL) { const hm = t.split(" ")[0]; if (hm >= a && hm <= b && hm.length === a.length) console.log("DUMP", t); } }
if (process.env.WHY) for (const nm of process.env.WHY.split(",")) { const s = g.signals.find((x) => x.name === nm)!; for (const p of [...(w.il.paths.get(s.id) ?? [])].sort((a, b) => Number(!!process.env.PREF && b.endSig && w.il.sig(b.endSig as any)?.name === process.env.PREF) - Number(!!process.env.PREF && a.endSig && w.il.sig(a.endSig as any)?.name === process.env.PREF))) console.log("WHY", nm, "->", p.endSig ? w.il.sig(p.endSig).name : p.endSig, ":", w.setRoute(s.id, p.endSig as any) ?? "OK"); }
if (process.env.SW) for (const nm of process.env.SW.split(",")) { const n = g.nodes.find((x) => x.swName === nm)!; for (const e of [...n.east, ...n.west]) { const E = g.edges[e]; const tr = w.trains.find((t) => t.body.includes(e)); const r = E.lock ? w.il.routes.get(E.lock) : undefined; console.log("SW", nm, "edge", e, "occ", E.occ, "by", tr?.no, "lock", E.lock, r ? `route ${w.il.sig(r.path.sig).name}->${r.path.endSig ? w.il.sig(r.path.endSig).name : ""} train ${w.trains.find((t) => t.id === r.train)?.no}` : "", "ovl", E.overlap); } }
if (process.env.RT) for (const r of w.il.routes.values()) { const tr = w.trains.find((t) => t.id === r.train); if (process.env.RT === "all" || (tr && process.env.RT.split(",").includes(tr.no))) console.log("RT", tr?.no ?? "-", w.il.sig(r.path.sig).name, "->", r.path.endSig ? w.il.sig(r.path.endSig).name : r.path.endPortal, "used", r.used); }
if (process.env.LK) { const [a, b] = process.env.LK.split(",").map(Number); for (const E of g.edges) { const sa = g.nodes[E.a].s ?? -1e9, sb = g.nodes[E.b].s ?? -1e9; if (Math.min(sa, sb) < b && Math.max(sa, sb) > a && (E.lock || E.occ || E.overlap)) { const r = E.lock > 0 ? w.il.routes.get(E.lock) : undefined; console.log("LK", E.id, Math.round(sa), Math.round(sb), "y", g.nodes[E.a].y, g.nodes[E.b].y, "occ", E.occ, w.trains.find((t) => t.body.includes(E.id))?.no ?? "", "lock", E.lock, r ? `${w.il.sig(r.path.sig).name}->${r.path.endSig ? w.il.sig(r.path.endSig).name : ""} ${w.trains.find((t) => t.id === r.train)?.no ?? "-"}` : "", "ovl", E.overlap, E.platform ? "P" + E.platform.track : ""); } } }
if (process.env.COST) for (const no of process.env.COST.split(",")) { const t = w.trains.find((x) => x.no === no); if (!t) continue; const W: any = w; const goal = W.goalKey(t); for (const p of w.il.paths.get(t.nextSig) ?? []) console.log("COST", no, w.il.sig(t.nextSig).name, "->", p.endSig ? w.il.sig(p.endSig).name : p.endPortal, Math.round(W.pathCost(p, t, goal)), "single", W.singleTrackBlocked(t, p), "grab", W.grabsLastTrack(t, p), "chk", w.il.check(p), "wait", Math.round(t.waitRed)); }
if (process.env.TR) for (const t of w.trains.filter((x) => process.env.TR!.split(",").includes(x.no))) console.log("TR", t.id, t.no, Math.round(w.headS(t)), t.dir, w.position(t).text, "|", w.status(t).map((x) => x.text).join(" | "), "key", t.trip.key, "turnedFrom", !!t.trip.turnedFrom);
if (process.env.SIG) for (const nm of process.env.SIG.split(",")) { const s = g.signals.find((x) => x.name === nm)!; const r = w.il.routes.get(s.route); console.log("SIG", nm, "route", s.route, r ? `${w.il.sig(r.path.sig).name}->${r.path.endSig ? w.il.sig(r.path.endSig).name : r.path.endPortal} used ${r.used} ready ${r.readyAt} now ${w.time}` : "none", "faulty", w.il.faultySignals.has(s.id), "auto", s.auto); }
if (process.env.PC) { w.planFor((w as any).allTrips[0], "TR"); console.log(w.planConflicts.length, "Gleiskonflikte"); for (const x of w.planConflicts) console.log("PC", x); }
if (process.env.ST) for (const t of w.trains) { const x = w.status(t).map((y) => y.text).join(" | "); if (/Endstation|Abgestellt/.test(x)) console.log("ST", t.no, x); }
