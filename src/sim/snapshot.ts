import { Graph } from "./graph";
import { SituationItem } from "./extras";
import { World } from "./world";

// Zustand für den zweiten Monitor (über BroadcastChannel übertragen)

export interface SnapStop { st: string; arr: number; dep: number; actArr?: number; actDep?: number; eta: number; track?: string; plan?: string; disp?: string; done: boolean; betr?: boolean; }
export interface SnapTrain {
  id: number; no: string; cat: string; line: string; from: string; to: string; dir: number;
  s: number; v: number; delay: number; live: boolean; stops: SnapStop[]; status: string; reason?: string; entry?: number;
  key: number; where?: string; hold?: boolean; fault?: string; waitFor?: string; radio?: { t: number; from: string; text: string }[];
  turnOpts?: string[]; umlauf?: string; ovSt?: string[]; ovBy?: { id: number; no: string }[]; turnInto?: string;
}
export interface Snapshot {
  time: number;
  stations: { code: string; name: string; s: number; main: boolean }[];
  trains: SnapTrain[];
  reports: { id: number; no: string; where: string; kind: string; state: string; from: string; to: string; at: number; note?: string }[];
  events: { t: number; text: string; kind: string }[];
  faults: { text: string; left: number }[];
  score: { points: number; trainsDone: number; punctual: number; waitMinutes: number };
  situation: SituationItem[];
  conns: { id: number; feeder: string; conn: string; st: string; dep: number; wait: number; text: string }[];
  tracks: Record<string, string[]>;
  book: { t: number; kind: string; text: string }[];
}

export const CHANNEL = "stellwerk-sieg";

export function makeSnapshot(w: World, g: Graph): Snapshot {
  const stations = Object.entries(g.stations).map(([code, s]) => ({ code, name: s.name, s: s.s ?? 0, main: !["FH", "SM"].includes(code) }));
  const trains: SnapTrain[] = w.trains.map((t) => {
    const st = w.status(t);
    const wf = t.waitFor && w.trains.find((o) => o.id === t.waitFor!.train);
    return {
      key: t.trip.key, where: w.position(t).text, hold: t.hold, fault: t.fault && t.faultUntil > w.time ? t.fault : undefined,
      waitFor: wf ? `${wf.no} in ${g.stations[t.waitFor!.st].name}` : undefined, radio: t.radio.slice(-14), turnInto: t.trip.turnInto?.no, umlauf: w.umlaufNo(t.trip),
      turnOpts: w.shortTurnOptions(t), ovSt: w.overtakeStations(t), ovBy: w.overtakers(t).map((o) => ({ id: o.id, no: o.no })),
      id: t.id, no: t.no, cat: t.cat, line: t.trip.line, from: t.trip.from, to: t.trip.to, dir: t.dir,
      s: w.headS(t), v: t.v, delay: w.liveDelay(t), live: true, status: st[0]?.text ?? "", reason: t.reason,
      stops: t.stops.map((s) => ({ st: s.st, arr: s.arr, dep: s.dep, actArr: s.actArr, actDep: s.actDep, eta: w.eta(t, s), done: s.done, betr: s.betr,
        plan: s.plan, disp: s.disp, track: s.track ?? (t.dwelling && s === t.stops[t.stopIdx] ? g.edges[t.body[t.body.length - 1]]?.platform?.track : undefined) })),
    };
  });
  // Züge, die bald in den Bereich kommen (für die Abfahrtstafel)
  for (const trip of w.upcoming(60)) {
    trains.push({
      key: trip.key, id: -trip.key, no: trip.no, cat: trip.cat, line: trip.line, from: trip.from, to: trip.to, dir: trip.dir, s: NaN, v: 0,
      delay: trip.initialDelay, live: false, status: trip.entryPortal ? `erwartet von ${g.portals[trip.entryPortal].label}` : "wird bereitgestellt",
      entry: trip.entryTime + trip.initialDelay,
      stops: trip.stops.map((s) => ({ st: s.st, arr: s.arr, dep: s.dep, eta: s.arr + trip.initialDelay, done: false, plan: w.planTrack(s.st, trip.dir, trip.line, trip.to), disp: w.dispTrack.get(`${trip.key}|${s.st}`) })),
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
    situation: w.ext.situation(),
    conns: w.connAlerts.map((c) => {
      const a = w.trains.find((t) => t.id === c.feeder), b = w.trains.find((t) => t.id === c.conn);
      const sb = b?.stops.find((x) => x.st === c.st);
      return { id: c.id, feeder: a ? `${a.no} (${a.trip.line})` : "?", conn: b ? `${b.no} (${b.trip.line} nach ${b.trip.to})` : "?", st: g.stations[c.st].name, dep: sb?.dep ?? 0, wait: c.wait,
        text: `Zubringer kommt ca. ${c.wait} min zu spät zum Umstieg` };
    }),
    book: w.book.slice(-60),
    tracks: Object.fromEntries(Object.keys(g.stations).map((c) => [c, w.platformTracks(c).map((x) => x.track)])),
  };
}
