import { Graph } from "./graph";
import { World } from "./world";

// Zustand für den zweiten Monitor (über BroadcastChannel übertragen)

export interface SnapStop { st: string; arr: number; dep: number; actArr?: number; actDep?: number; eta: number; track?: string; plan?: string; done: boolean; }
export interface SnapTrain {
  id: number; no: string; cat: string; line: string; from: string; to: string; dir: number;
  s: number; v: number; delay: number; live: boolean; stops: SnapStop[]; status: string; reason?: string; entry?: number;
}
export interface Snapshot {
  time: number;
  stations: { code: string; name: string; s: number; main: boolean }[];
  trains: SnapTrain[];
  reports: { id: number; no: string; where: string; kind: string; state: string; from: string; to: string; at: number; note?: string }[];
  events: { t: number; text: string; kind: string }[];
  faults: { text: string; left: number }[];
  score: { points: number; trainsDone: number; punctual: number; waitMinutes: number };
}

export const CHANNEL = "stellwerk-sieg";

export function makeSnapshot(w: World, g: Graph): Snapshot {
  const stations = Object.entries(g.stations).map(([code, s]) => ({ code, name: s.name, s: s.s ?? 0, main: !["FH", "SM"].includes(code) }));
  const trains: SnapTrain[] = w.trains.map((t) => {
    const st = w.status(t);
    return {
      id: t.id, no: t.no, cat: t.cat, line: t.trip.line, from: t.trip.from, to: t.trip.to, dir: t.dir,
      s: w.headS(t), v: t.v, delay: w.liveDelay(t), live: true, status: st[0]?.text ?? "", reason: t.reason,
      stops: t.stops.map((s) => ({ st: s.st, arr: s.arr, dep: s.dep, actArr: s.actArr, actDep: s.actDep, eta: w.eta(t, s), done: s.done,
        plan: s.plan, track: s.track ?? (t.dwelling && s === t.stops[t.stopIdx] ? g.edges[t.body[t.body.length - 1]]?.platform?.track : undefined) })),
    };
  });
  // Züge, die bald in den Bereich kommen (für die Abfahrtstafel)
  for (const trip of w.upcoming(60)) {
    trains.push({
      id: -trip.key, no: trip.no, cat: trip.cat, line: trip.line, from: trip.from, to: trip.to, dir: trip.dir, s: NaN, v: 0,
      delay: trip.initialDelay, live: false, status: trip.entryPortal ? `erwartet von ${g.portals[trip.entryPortal].label}` : "wird bereitgestellt",
      entry: trip.entryTime + trip.initialDelay,
      stops: trip.stops.map((s) => ({ st: s.st, arr: s.arr, dep: s.dep, eta: s.arr + trip.initialDelay, done: false, plan: w.planTrack(s.st, trip.dir, trip.line, trip.to) })),
    });
  }
  return {
    time: w.time, stations, trains,
    reports: w.reports.filter((r) => w.time - r.t < 900 || r.state !== "accepted").map((r) => ({
      id: r.id, no: r.no, where: g.portals[r.portal].label, kind: r.kind, state: r.state, from: r.trip.from, to: r.trip.to,
      at: r.trip.entryTime + r.trip.initialDelay, note: r.note,
    })),
    events: w.events.slice(-40),
    faults: w.faults.map((f) => ({ text: f.text, left: Math.max(0, Math.round((f.until - w.time) / 60)) })),
    score: { points: w.score.points, trainsDone: w.score.trainsDone, punctual: w.score.punctual, waitMinutes: w.score.waitMinutes },
  };
}
