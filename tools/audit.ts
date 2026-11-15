// Prüft das Gleisbild: Fahrstraßen je Signal, Weichen in beiden Lagen befahrbar, jede Fahrstraße im leeren Stellwerk einstellbar
import { buildCorridor } from "../src/data/corridor";
import { Interlocking } from "../src/sim/interlocking";
const g = buildCorridor(); const il = new Interlocking(g);
const used = new Map<number, Set<number>>();
const problems: string[] = [];
for (const s of g.signals) {
  const ps = il.paths.get(s.id) ?? [];
  if (!ps.length && s.kind === "main") problems.push(`Signal ${s.name}: keine Fahrstraße`);
  for (const p of ps) {
    for (const { node, pos } of p.sw) { const u = used.get(node) ?? new Set(); u.add(pos); used.set(node, u); }
    // im leeren Zustand einstellen und gleich wieder auflösen
    const why = il.check(p);
    if (why) problems.push(`${s.name} → ${p.endSig ? il.sig(p.endSig).name : p.endPortal}: ${why}`);
    else { const r = il.set(p, 0); if (typeof r === "string") problems.push(`${s.name}: ${r}`); else il.cancel(s.id); }
  }
}
for (const n of g.nodes) if (n.swSide !== undefined) {
  const u = used.get(n.id);
  if (!u || u.size < 2) problems.push(`Weiche ${n.swName}: in Fahrstraßen nur Lage ${u ? [...u].join("/") : "keine"} genutzt`);
}
console.log(problems.length ? problems.join("\n") : "keine Probleme");
