import { readFileSync } from "fs";
import { buildCorridor } from "../src/data/corridor";
import { buildTrips } from "../src/sim/timetable";
import { World } from "../src/sim/world";
const g = buildCorridor();
const raw = JSON.parse(readFileSync(new URL("../public/data/timetable.json", import.meta.url), "utf8"));
const w = new World(g, buildTrips(g, raw, 17), 4 * 3600);
for (const s of g.signals) s.auto = true;
while (w.time < Number(process.env.H ?? 13) * 3600) w.step(0.5);
for (const t of w.trains) {
  const s = t.nextSig ? w.il.sig(t.nextSig) : null;
  console.log(t.no, "v", t.v.toFixed(1), "sig", s?.name, "dist", t.distNextSig.toFixed(0), "dwelling", t.dwelling, "stopIdx", t.stopIdx, t.stops.map(s=>s.st).join(","));
  if (s) for (const p of w.il.paths.get(s.id)!) console.log("   ->", p.endSig ? w.il.sig(p.endSig).name : p.endPortal, w.il.check(p), "route", s.route);
}
const tr = w.trains.find(t=>t.no===(process.env.T??"RB 13926"))!;
const s = w.il.sig(tr.nextSig);
for (const p of w.il.paths.get(s.id)!) { const bad = p.edges.filter(e=>g.edges[e].lock||g.edges[e].occ).map(e=>{const E=g.edges[e]; const r=w.il.routes.get(E.lock); return `${g.nodes[E.a].x},${g.nodes[E.a].y}-${g.nodes[E.b].x},${g.nodes[E.b].y} occ${E.occ} lock:${r? w.il.sig(r.path.sig).name+(r.used?' used by '+w.trains.find(t=>t.id===r.train)?.no:''):''}`}); console.log(p.endSig? w.il.sig(p.endSig).name:p.endPortal, bad.join(' | ')); }
for (const r of w.il.routes.values()) console.log("ROUTE", w.il.sig(r.path.sig).name, "->", r.path.endSig? w.il.sig(r.path.endSig).name : r.path.endPortal, "used", r.used, "train", w.trains.find(t=>t.id===r.train)?.no, "ready", r.readyAt);
{
const sg = w.il.sig(tr.nextSig);
console.log("DBG", tr.no, "auto", sg.auto, "route", sg.route, "goal", (w as any).goalKey(tr), "turn", tr.trip.turnInto?.no, tr.trip.turnInto?.exitPortal, "stopAheadPlat", tr.stopAheadIsPlatform, "waitRed", tr.waitRed);
for (const p of w.il.paths.get(sg.id)!) console.log("  cost", (w as any).pathCost(p, tr, (w as any).goalKey(tr)), (w as any).singleTrackBlocked(tr,p));
console.log("best", w.bestPath(tr, w.il.paths.get(sg.id)!)?.edges.length);
}
