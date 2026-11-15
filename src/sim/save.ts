import { TripSpec } from "./timetable";
import { World } from "./world";

// Spielstand speichern und laden (localStorage). Fahrten werden über ihren Schlüssel referenziert,
// Fahrstraßen über Startsignal und Fahrweg, damit der gespeicherte Stand klein bleibt.

export const SAVE_KEY = "stellwerk-save-v1";

export interface SaveMeta { feats: any; manual: string[]; shiftStart: number; savedAt: number; date: number; }

export function saveGame(w: World, meta: Omit<SaveMeta, "savedAt">): string {
  const W = w as any;
  const g = w.g;
  const tk = (t?: TripSpec) => (t ? t.key : undefined);
  const data = {
    v: 1,
    meta: { ...meta, savedAt: Date.now() },
    time: w.time,
    pending: (W.pending as TripSpec[]).map((t) => [t.key, t.initialDelay]),
    nextTrainId: W.nextTrainId, faultId: W.faultId, reportId: W.reportId, faultRate: w.faultRate, zugmeldung: w.zugmeldung, faultCount: w.faultCount,
    trains: w.trains.map((t) => ({ ...t, trip: t.trip.key })),
    events: w.events, score: w.score, faults: w.faults,
    reports: w.reports.map((r) => ({ ...r, trip: r.trip.key })),
    connAlerts: w.connAlerts,
    dispTrack: [...w.dispTrack],
    queued: w.queued,
    book: w.book, azSections: w.azSections, azId: w.azId, azCount: w.azCount, orders: w.orders, orderNo: w.orderNo, pendingRadio: w.pendingRadio.map(({ then, ...x }) => x),
    lastOnEdge: [...w.lastOnEdge], zlMode: [...w.zlMode], orderSw: w.orderSw,
    ops: w.ops.save(),
    rescues: w.rescues,
    phone: { matters: w.phone.matters, later: w.phone.later, log: w.phone.log, id: w.phone.id },
    edges: g.edges.map((e) => [e.occ, e.lock, e.overlap, e.slow ?? 0, e.closed ? 1 : 0, e.work ? 1 : 0, e.az ?? 0]),
    sw: g.nodes.filter((n) => n.swSide !== undefined).map((n) => [n.id, n.swPos]),
    sigs: g.signals.map((s) => [s.route, s.auto ? 1 : 0]),
    il: {
      nextId: (w.il as any).nextId,
      routes: [...w.il.routes.values()].map((r) => ({ id: r.id, sig: r.path.sig, edges: r.path.edges, endSig: r.path.endSig, remaining: [...r.remaining], overlap: r.overlap, readyAt: r.readyAt, used: r.used, train: r.train })),
      faultySwitches: [...w.il.faultySwitches], faultySignals: [...w.il.faultySignals], zs1: [...w.il.zs1],
      blockedSignals: [...w.il.blockedSignals], blockedSwitches: [...w.il.blockedSwitches],
    },
    ext: {
      wx: w.ext.wx, wxUntil: w.ext.wxUntil,
      crossings: w.ext.crossings.map((c) => [c.closed ? 1 : 0, c.closedFor, c.faultUntil, c.blockedUntil]),
      sites: w.ext.sites.map((s) => ({ ...s, prev: [...s.prev] })),
      happenings: w.ext.happenings.map((h) => ({ ...h, prev: [...h.prev] })),
      connWarned: [...w.ext.connWarned],
      layers: [...w.ext.layers], base: [...w.ext.base],
      id: (w.ext as any).id,
    },
  };
  void tk;
  return JSON.stringify(data);
}

export function loadGame(w: World, json: string, allTrips: TripSpec[]) {
  const d = JSON.parse(json);
  if (d.edges.length !== w.g.edges.length) throw new Error("der Spielstand stammt aus einer älteren Version mit anderem Gleisbild");
  const W = w as any;
  const g = w.g;
  const byKey = new Map(allTrips.map((t) => [t.key, t]));
  if (d.ops) w.ops.load(d.ops, allTrips, byKey);
  const trip = (k: number) => {
    const t = byKey.get(k);
    if (!t) throw new Error(`Fahrt ${k} fehlt`);
    return t;
  };
  w.time = d.time;
  W.pending = d.pending.map(([k, delay]: [number, number]) => {
    const t = trip(k);
    t.initialDelay = delay;
    return t;
  });
  W.nextTrainId = d.nextTrainId; W.faultId = d.faultId; W.reportId = d.reportId;
  w.faultRate = d.faultRate; w.zugmeldung = d.zugmeldung; w.faultCount = d.faultCount ?? 0;
  w.trains = d.trains.map((t: any) => ({ ...t, trip: trip(t.trip) }));
  w.events = d.events; w.score = d.score; w.faults = d.faults;
  w.reports = d.reports.map((r: any) => ({ ...r, trip: trip(r.trip) }));
  w.connAlerts = d.connAlerts ?? [];
  w.dispTrack = new Map(d.dispTrack ?? []);
  w.queued = d.queued ?? [];
  w.book = d.book ?? []; w.azSections = d.azSections ?? []; w.azId = d.azId ?? 1; w.azCount = d.azCount ?? 0;
  w.orders = d.orders ?? []; w.orderNo = d.orderNo ?? 1; w.pendingRadio = d.pendingRadio ?? [];
  w.lastOnEdge = new Map(d.lastOnEdge ?? []);
  w.rescues = d.rescues ?? [];
  if (d.phone) Object.assign(w.phone, d.phone);
  w.zlMode = new Map(d.zlMode ?? []);
  w.orderSw = d.orderSw ?? [];
  d.edges.forEach((x: number[], i: number) => {
    const e = g.edges[i];
    [e.occ, e.lock, e.overlap] = x;
    e.slow = x[3] || undefined;
    e.closed = x[4] ? true : undefined;
    e.work = x[5] ? true : undefined;
    e.az = x[6] || undefined;
  });
  for (const [id, pos] of d.sw) g.nodes[id].swPos = pos;
  d.sigs.forEach((x: number[], i: number) => { g.signals[i].route = x[0]; g.signals[i].auto = !!x[1]; });
  const il = w.il as any;
  il.nextId = d.il.nextId;
  w.il.routes.clear();
  for (const r of d.il.routes) {
    const key = r.edges.join(",");
    const path = (w.il.paths.get(r.sig) ?? []).find((p) => p.endSig === r.endSig && p.edges.join(",") === key);
    if (!path) continue;
    w.il.routes.set(r.id, { id: r.id, path, remaining: new Set(r.remaining), overlap: r.overlap, readyAt: r.readyAt, used: r.used, train: r.train });
  }
  w.il.faultySwitches = new Set(d.il.faultySwitches);
  w.il.faultySignals = new Set(d.il.faultySignals);
  w.il.zs1 = new Map(d.il.zs1);
  w.il.blockedSignals = new Set(d.il.blockedSignals);
  w.il.blockedSwitches = new Set(d.il.blockedSwitches);
  const x = d.ext;
  w.ext.wx = x.wx; w.ext.wxUntil = x.wxUntil ?? Infinity;
  x.crossings.forEach((c: number[], i: number) => {
    const C = w.ext.crossings[i];
    if (!C) return;
    C.closed = !!c[0]; C.closedFor = c[1]; C.faultUntil = c[2]; C.blockedUntil = c[3];
  });
  w.ext.sites = x.sites.map((s: any) => ({ ...s, prev: new Map(s.prev) }));
  w.ext.happenings = x.happenings.map((h: any) => ({ ...h, prev: new Map(h.prev) }));
  w.ext.connWarned = new Set(x.connWarned);
  w.ext.layers = new Map(x.layers ?? []); w.ext.base = new Map(x.base ?? []);
  (w.ext as any).id = x.id;
  (w.ext as any).rebuildPoints();
  w.ext.applyPerfAll();
}

export function readSave(): { json: string; meta: SaveMeta; time: number } | null {
  try {
    const json = localStorage.getItem(SAVE_KEY);
    if (!json) return null;
    const d = JSON.parse(json);
    return { json, meta: d.meta, time: d.time };
  } catch {
    return null;
  }
}
