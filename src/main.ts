import { buildCorridor } from "./data/corridor";
import { buildTrips, RawTimetable } from "./sim/timetable";
import { Train, World } from "./sim/world";
import { View, CAT_COLOR as VIEW_CAT } from "./render/view";
import { TrainWindow } from "./ui/trainWindow";
import { ContextMenu, MenuItem } from "./ui/contextMenu";
import { radio } from "./sim/radio";
import { CHANNEL, makeSnapshot } from "./sim/snapshot";
import { SAVE_KEY, loadGame, readSave, saveGame } from "./sim/save";
import { DEFAULT_FEATURES, FEATURE_LABELS, Features, WX } from "./sim/extras";

const AREAS: [string, string][] = [
  ["TR", "Troisdorf"], ["SB", "Siegburg/Bonn"], ["HN", "Hennef (Sieg)"], ["BL", "Blankenberg (Sieg)"],
  ["EI", "Eitorf"], ["AU", "Au (Sieg)"], ["WI", "Wissen (Sieg)"], ["BZ", "Betzdorf (Sieg)"],
];
const DEFAULT_MANUAL = new Set(AREAS.map(([c]) => c));
const $ = (id: string) => document.getElementById(id)!;
const fmt = (t: number) => {
  const s = Math.floor(((t % 86400) + 86400) % 86400);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const hm = (t: number) => fmt(t).slice(0, 5);
const CAT_COLOR = VIEW_CAT;

async function boot() {
  const raw: RawTimetable = await (await fetch(`${import.meta.env.BASE_URL}data/timetable.json`)).json();
  const g = buildCorridor();
  let trackPlan: Record<string, string> | undefined;
  try { trackPlan = await (await fetch(`${import.meta.env.BASE_URL}data/tracks.json`)).json(); } catch { /* ohne Regelgleise */ }

  $("areaPick").innerHTML = AREAS.map(([c, n]) => `<label><input type="checkbox" value="${c}" ${DEFAULT_MANUAL.has(c) ? "checked" : ""}> ${n}</label>`).join("");
  let savedF: Partial<Features> = {};
  try { savedF = JSON.parse(localStorage.getItem("stellwerk-features") ?? "{}"); } catch { /* egal */ }
  const F0: Features = { ...DEFAULT_FEATURES, ...savedF };
  $("featPick").innerHTML = FEATURE_LABELS.map(([k, n, d]) => `<label><input type="checkbox" data-f="${k}" ${F0[k] ? "checked" : ""}><span>${n}<small>${d}</small></span></label>`).join("");
  if (savedF.faults !== undefined) ($("faults") as HTMLSelectElement).value = String(savedF.faults);
  const save = readSave();
  if (save && save.meta?.date === Number(raw.date)) {
    $("resume").classList.remove("hidden");
    $("resume").innerHTML = `Gespeicherten Dienst fortsetzen<small>Spielzeit ${hm(save.time)} Uhr, gespeichert ${new Date(save.meta.savedAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}</small>`;
  }
  const resume = await new Promise<boolean>((res) => {
    $("go").onclick = () => res(false);
    $("resume").onclick = () => res(true);
  });
  const startHour = Number(($("startHour") as HTMLSelectElement).value);
  const faultRate = Number(($("faults") as HTMLSelectElement).value);
  let feats: Features = { ...F0, faults: faultRate };
  document.querySelectorAll<HTMLInputElement>("#featPick input").forEach((i) => ((feats as any)[i.dataset.f!] = i.checked));
  try { localStorage.setItem("stellwerk-features", JSON.stringify(feats)); } catch { /* egal */ }
  let manual = new Set([...document.querySelectorAll<HTMLInputElement>("#areaPick input:checked")].map((i) => i.value));
  if (resume && save) {
    feats = { ...DEFAULT_FEATURES, ...save.meta.feats };
    manual = new Set(save.meta.manual);
  }
  $("start").remove();

  let trips = buildTrips(g, raw, Number(raw.date));
  if (!feats.gueter) trips = trips.filter((t) => t.cat !== "G");
  if (!feats.vorbereich) for (const t of trips) t.initialDelay = 0;
  const w = new World(g, trips, resume && save ? save.time : startHour * 3600 - 120 * 60);
  w.faultRate = 0;
  w.trackPlan = trackPlan;
  w.zugmeldung = feats.zugmeldung;
  w.ext.start({ ...feats, ereignisse: false, faults: 0 }, startHour * 3600);
  const applyAreas = () => {
    for (const s of g.signals) s.auto = s.kind === "block" || !manual.has(s.name.slice(0, 2));
    w.manualAreas = new Set(manual);
  };
  applyAreas();
  let shiftStart: number;
  if (resume && save) {
    w.ext.f = feats;
    try {
      loadGame(w, save.json, trips);
    } catch (e) {
      alert(`Der Spielstand konnte nicht geladen werden (${(e as Error).message}). Bitte neu starten.`);
      localStorage.removeItem(SAVE_KEY);
      location.reload();
      return;
    }
    w.manualAreas = new Set(manual);
    shiftStart = save.meta.shiftStart;
    w.log("Spielstand geladen.", "good");
  } else {
  // Vorlauf: 2 Stunden automatisch, damit beim Dienstbeginn schon Züge unterwegs sind
  const saved = g.signals.map((s) => s.auto);
  for (const s of g.signals) s.auto = true;
  w.manualAreas = new Set();
  while (w.time < startHour * 3600) w.step(0.5);
  g.signals.forEach((s, i) => (s.auto = saved[i]));
  w.manualAreas = new Set(manual);
  w.events = [];
  w.score = { points: 0, trainsDone: 0, punctual: 0, waitMinutes: 0, missedStops: 0, incidents: 0, causes: {}, delayMin: 0, late: [] };
  w.faultRate = faultRate;
  w.faultCount = 0;
  w.ext.f = feats;
  w.connAlerts = [];
  shiftStart = w.time;
  if (feats.weather) w.log(`Wetter: ${WX[w.ext.wx].icon} ${WX[w.ext.wx].label}. ${WX[w.ext.wx].text}`, "info");
  w.log(`Dienstbeginn. Du stellst: ${[...manual].map((c) => g.stations[c].name).join(", ") || "nichts (Beobachtungsmodus)"}.`, "good");
  }
  const wxNow = () => {
    if (!feats.weather) return "";
    const W = WX[w.ext.wx];
    return `<b>${W.icon}</b>${W.label}`;
  };

  const doSave = (quiet = false) => {
    try {
      localStorage.setItem(SAVE_KEY, saveGame(w, { feats, manual: [...manual], shiftStart, date: Number(raw.date) }));
      if (!quiet) toast("Spielstand gespeichert");
    } catch (e) {
      if (!quiet) toast(`Speichern fehlgeschlagen: ${(e as Error).message}`);
    }
  };
  setInterval(() => doSave(true), 60000);
  window.addEventListener("beforeunload", () => doSave(true));

  const cv = $("cv") as HTMLCanvasElement;
  const view = new View(cv, g, w);
  // Zeileneinteilung (im Browser gemerkt)
  let rows = 4;
  try {
    const saved = JSON.parse(localStorage.getItem("stellwerk-layout-v3") ?? "null");
    if (saved?.breaks) { view.setBreaks(saved.breaks.filter((x: number) => view.candidates.includes(x))); rows = view.breaks.length + 1; }
    else view.autoRows(rows);
  } catch { view.autoRows(rows); }
  const saveLayout = () => { try { localStorage.setItem("stellwerk-layout-v3", JSON.stringify({ breaks: view.breaks })); } catch { /* egal */ } };
  const markRows = () => document.querySelectorAll<HTMLButtonElement>("#rows button[data-r]").forEach((b) => b.classList.toggle("on", Number(b.dataset.r) === view.breaks.length + 1));
  requestAnimationFrame(() => { view.fit(); markRows(); });
  document.querySelectorAll<HTMLButtonElement>("#rows button[data-r]").forEach((b) => (b.onclick = () => {
    view.autoRows(Number(b.dataset.r));
    view.fit();
    saveLayout();
    markRows();
  }));
  $("fitBtn").onclick = () => view.fit();
  $("editBtn").onclick = () => {
    view.editBreaks = !view.editBreaks;
    $("editBtn").classList.toggle("on", view.editBreaks);
    if (view.editBreaks) toast("Klicke auf ✂ für einen Zeilenumbruch, auf ↵ um ihn zu entfernen");
  };
  window.addEventListener("resize", () => view.fit());

  let speed = 1;
  const setSpeed = (s: number) => {
    speed = s;
    document.querySelectorAll("#speed button").forEach((b) => b.classList.toggle("on", Number((b as HTMLElement).dataset.s) === s));
  };
  document.querySelectorAll<HTMLButtonElement>("#speed button").forEach((b) => (b.onclick = () => setSpeed(Number(b.dataset.s))));
  let lastSpeed = 1;
  window.addEventListener("keydown", (e) => {
    if (e.key === " ") {
      e.preventDefault();
      if (speed) { lastSpeed = speed; setSpeed(0); } else setSpeed(lastSpeed);
    }
    if (e.key === "Escape") clearSel();
  });

  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => (b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x.id === `tab-${b.dataset.tab}`));
  }));

  // Stellbereich im Spiel ändern
  const area = $("tab-area");
  area.innerHTML = `<p>Bahnhöfe, die du selbst stellst. Alle anderen werden von der Zuglenkung automatisch bedient.</p>` +
    AREAS.map(([c, n]) => `<label><input type="checkbox" value="${c}" ${manual.has(c) ? "checked" : ""}> ${n}</label>`).join("") +
    `<div class="act"><button data-go="TR">Zu Troisdorf</button><button data-go="AU">Zu Au (Sieg)</button></div>`;
  area.querySelectorAll<HTMLInputElement>("input").forEach((i) => (i.onchange = () => {
    i.checked ? manual.add(i.value) : manual.delete(i.value);
    applyAreas();
  }));
  area.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) => (b.onclick = () => view.centerOn(g.stations[b.dataset.go!].x, 5)));

  // ---------- Bedienung im Gleisbild ----------
  const toastEl = $("toast");
  let toastT = 0;
  const toast = (msg: string) => {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    toastT = performance.now() + 2600;
  };
  const clearSel = () => {
    view.selected = 0;
    view.targets.clear();
  };
  const selectStart = (sid: number) => {
    view.selected = sid;
    view.targets.clear();
    for (const { path, why } of w.routeTargets(sid)) {
      const k = path.endSig ? `s${path.endSig}` : `p${path.endPortal}`;
      view.targets.set(k, (view.targets.get(k) ?? false) || !why);
    }
    if (!view.targets.size) {
      toast("Von diesem Signal führt keine Fahrstraße weg");
      clearSel();
    }
  };

  let drag: { x: number; y: number; px: number; py: number; moved: boolean } | null = null;
  cv.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    drag = { x: e.offsetX, y: e.offsetY, px: view.panX, py: view.panY, moved: false };
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const r = cv.getBoundingClientRect();
    const dx = e.clientX - r.left - drag.x, dy = e.clientY - r.top - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) {
      view.panX = drag.px + dx;
      view.panY = drag.py + dy;
    }
  });
  window.addEventListener("mouseup", (e) => {
    const d = drag;
    drag = null;
    if (!d || d.moved || e.target !== cv) return;
    click(e.offsetX, e.offsetY, e.shiftKey, e.ctrlKey || e.altKey || e.metaKey);
  });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    view.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });
  const ctxMenu = new ContextMenu();
  cv.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    clearSel();
    const h = view.hit(e.offsetX, e.offsetY);
    if (!h) return;
    const items: MenuItem[] = [];
    let title = "";
    if (h.kind === "signal") {
      const sg = h.sig;
      title = `Signal ${sg.name}`;
      const blocked = w.il.blockedSignals.has(sg.id);
      items.push({ label: "Fahrstraße stellen …", act: () => selectStart(sg.id) });
      items.push({ label: "Fahrstraße zurücknehmen", disabled: !sg.route, act: () => { if (w.il.cancel(sg.id)) w.log(`Fahrstraße ab ${sg.name} zurückgenommen`); else toast("Fahrstraße ist schon befahren und kann nicht mehr zurückgenommen werden"); } });
      items.push({ label: sg.auto ? "Zuglenkung ausschalten" : "Zuglenkung einschalten", act: () => { sg.auto = !sg.auto; w.log(`Zuglenkung für ${sg.name} ${sg.auto ? "eingeschaltet" : "ausgeschaltet"}`); } });
      items.push({ label: "Ersatzsignal (Zs 1) geben", act: () => { const why = w.giveZs1(sg.id); if (why) toast(why); } });
      items.push({ label: blocked ? "Signalsperre aufheben" : "Signal sperren", act: () => { blocked ? w.il.blockedSignals.delete(sg.id) : w.il.blockedSignals.add(sg.id); w.log(`${sg.name} ${blocked ? "entsperrt" : "gesperrt"}`); } });
    } else if (h.kind === "switch") {
      const n = g.nodes[h.node];
      title = `Weiche ${n.swName}`;
      const blocked = w.il.blockedSwitches.has(n.id);
      items.push({ label: "Umstellen", act: () => { const why = w.toggleSwitch(n.id); if (why) toast(why); } });
      items.push({ label: blocked ? "Weichensperre aufheben" : "Weiche sperren (gegen Umstellen)", act: () => { blocked ? w.il.blockedSwitches.delete(n.id) : w.il.blockedSwitches.add(n.id); w.log(`Weiche ${n.swName} ${blocked ? "entsperrt" : "gesperrt"}`); } });
    } else if (h.kind === "train") {
      const t = h.train;
      title = `Zug ${t.no}`;
      items.push({ label: "Zugfenster öffnen", act: () => showTrain(t) });
      items.push({ label: "Funk …", act: () => { tw.tab = "funk"; showTrain(t); } });
      items.push({ label: t.hold ? "Halt aufheben (Funk)" : "Halt anordnen (Funk)", act: () => radio(w, t, t.hold ? "Weiterfahrt erlaubt" : "Sofort anhalten", t.hold ? "weiter" : "halt") });
      items.push({ label: "Anschluss abwarten", sub: [2, 3, 5, 8, 10].map((m) => ({ label: `${m} Minuten`, act: () => radio(w, t, `Warten Sie ${m} min auf den Anschluss`, "anschluss") })) });
      items.push({ label: "Verspätungsursache …", act: () => { tw.tab = "versp"; showTrain(t); } });
    } else if (h.kind === "edge") {
      const E = g.edges[h.edge];
      const a = g.nodes[E.a];
      title = E.platform ? `${g.stations[E.platform.st].name} Gleis ${E.platform.track}` : `Gleisabschnitt bei ${w.nearStation(a.x)}`;
      const setSlow = (v: number) => {
        E.slow = v || undefined;
        w.log(v ? `Langsamfahrstelle ${v} km/h ${title} eingerichtet` : `Langsamfahrstelle ${title} aufgehoben`, v ? "warn" : "info");
      };
      items.push({ label: `Langsamfahrstelle${E.slow ? ` (jetzt ${E.slow})` : ""}`, sub: [
        ...[10, 20, 30, 40, 50, 60, 80, 100].map((v) => ({ label: `${v} km/h`, act: () => setSlow(v) })),
        { label: "aufheben", disabled: !E.slow, act: () => setSlow(0) },
      ] });
      items.push({ label: E.closed ? "Sperrung aufheben" : "Gleis sperren", act: () => {
        if (!E.closed && (E.lock || E.occ)) return toast("Abschnitt ist belegt oder in einer Fahrstraße, erst räumen");
        E.closed = !E.closed;
        w.log(`${title} ${E.closed ? "gesperrt" : "wieder frei"}`, E.closed ? "warn" : "info");
      } });
      items.push({ label: `Länge ${E.len} m · zulässig ${E.vmax} km/h`, disabled: true });
    } else return;
    ctxMenu.show(e.clientX, e.clientY, title, items);
  });

  const click = (x: number, y: number, shift: boolean, ctrl = false) => {
    const h = view.hit(x, y);
    if (h?.kind === "break") {
      view.toggleBreak(h.x);
      view.fit();
      saveLayout();
      markRows();
      return;
    }
    if (!h) {
      clearSel();
      return;
    }
    if (h.kind === "train") {
      showTrain(h.train);
      return;
    }
    if (h.kind === "switch") {
      const why = w.toggleSwitch(h.node);
      if (why) toast(why);
      return;
    }
    if (h.kind === "portal") {
      if (view.selected) {
        const why = w.setRoute(view.selected, h.code);
        if (why) toast(why);
        clearSel();
      }
      return;
    }
    if (h.kind !== "signal") return;
    const s = h.sig;
    if (ctrl) {
      const why = w.giveZs1(s.id);
      if (why) toast(why);
      clearSel();
      return;
    }
    if (shift) {
      s.auto = !s.auto;
      w.log(`Zuglenkung für ${s.name} ${s.auto ? "eingeschaltet" : "ausgeschaltet"}`);
      return;
    }
    if (!view.selected) return selectStart(s.id);
    if (view.selected === s.id) return clearSel();
    if (view.targets.has(`s${s.id}`)) {
      const why = w.setRoute(view.selected, s.id);
      if (why) toast(why);
      clearSel();
      return;
    }
    selectStart(s.id);
  };

  // ---------- Zugfenster ----------
  const tw = new TrainWindow(w, g, CAT_COLOR, () => (view.focusTrain = null), (m) => toast(m));
  tw.onCenter = (t) => {
    const e = g.edges[t.body[t.body.length - 1]];
    view.centerOn(g.nodes[e.a].x, g.nodes[e.a].y);
  };
  const showTrain = (t: Train) => {
    view.focusTrain = t;
    tw.show(t);
  };
  const renderCard = () => tw.render();

  // ---------- Seitenleiste ----------
  const isMine = (sid: number) => sid && !w.il.sig(sid).auto;
  const renderLists = () => {
    const trains = [...w.trains].sort((a, b) => Number(isMine(b.nextSig)) - Number(isMine(a.nextSig)) || b.waitRed - a.waitRed);
    $("tab-trains").innerHTML = trains.map((t) => {
      const ps = t.stops[t.stopIdx];
      const where = t.dwelling ? `hält in <b>${g.stations[ps?.st]?.name ?? ""}</b>` : ps ? `nächster Halt <b>${g.stations[ps.st].name}</b> ${hm(ps.arr)}` : t.trip.exitPortal ? `nach <b>${g.portals[t.trip.exitPortal].label}</b>` : "";
      const sig = t.nextSig ? w.il.sig(t.nextSig) : null;
      const sigTxt = sig && t.distNextSig < 3000 ? ` · vor <b>${sig.name}</b>${isMine(sig.id) ? " ●" : ""}` : "";
      const dm = Math.round(t.delay / 60);
      return `<div class="row ${t.waitRed > 45 ? "waiting" : ""}" data-id="${t.id}"><div class="cat" style="background:${CAT_COLOR[t.cat]}"></div>
        <div class="no">${t.no}</div><div class="info">${where}${sigTxt}<br>${t.trip.from} → ${t.trip.to}</div>
        <div class="dl ${dm >= 6 ? "bad" : dm >= 3 ? "warn" : "ok"}">${dm > 0 ? "+" + dm : "0"}</div></div>`;
    }).join("");
    $("tab-next").querySelectorAll<HTMLButtonElement>("[data-acc]").forEach((b) => (b.onclick = () => {
      const why = w.acceptReport(Number(b.dataset.acc));
      if (why) toast(why);
      renderLists();
    }));
    $("tab-trains").querySelectorAll<HTMLElement>(".row").forEach((r) => (r.onclick = () => {
      const t = w.trains.find((x) => x.id === Number(r.dataset.id));
      if (t) {
        showTrain(t);
        const e = g.edges[t.body[t.body.length - 1]];
        view.centerOn(g.nodes[e.a].x, g.nodes[e.a].y);
      }
    }));
    const open = w.reports.filter((r) => r.kind === "in" && r.state === "offered");
    const outs = w.reports.filter((r) => r.kind === "out" && r.state !== "accepted" && w.trains.some((t) => t.trip === r.trip));
    $("repCount").textContent = open.length ? String(open.length) : "";
    const repHtml = (open.length || outs.length ? `<h3>Zugmeldungen</h3>` : "") +
      open.map((r) => {
        const at = r.trip.entryTime + r.trip.initialDelay;
        return `<div class="rep"><div><b>${r.no}</b> von Fdl ${g.portals[r.portal].label}<br><small>${r.trip.from} → ${r.trip.to} · Einfahrt ca. ${hm(at)}${r.trip.initialDelay >= 180 ? ` (+${Math.round(r.trip.initialDelay / 60)})` : ""}</small></div><button data-acc="${r.id}">Annehmen</button></div>`;
      }).join("") +
      outs.map((r) => `<div class="rep out"><div><b>${r.no}</b> an Fdl ${g.portals[r.portal].label} angeboten<br><small>${r.state === "refused" ? `abgelehnt: ${r.note}` : "warte auf Antwort …"}</small></div></div>`).join("");
    $("tab-next").innerHTML = repHtml + `<h3>Vorschau</h3><p>Züge, die in den nächsten Minuten in den Bereich einfahren oder bereitgestellt werden.</p>` +
      w.upcoming(40).map((t) => {
        const at = t.entryTime + t.initialDelay;
        const dm = Math.round(t.initialDelay / 60);
        const from = t.entryPortal ? `von ${g.portals[t.entryPortal].label}` : `Bereitstellung ${g.stations[t.stops[0].st].name}`;
        return `<div class="row"><div class="cat" style="background:${CAT_COLOR[t.cat]}"></div><div class="no">${t.no}</div>
          <div class="info">${hm(at)} ${from}<br>${t.from} → ${t.to}</div><div class="dl ${dm >= 6 ? "bad" : dm >= 3 ? "warn" : "ok"}">${dm > 0 ? "+" + dm : "0"}</div></div>`;
      }).join("");
  };

  const renderFaults = () => {
    const el = $("tab-faults");
    const fs = w.faults;
    const conns = w.connAlerts;
    $("faultCount").textContent = fs.length + conns.length ? String(fs.length + conns.length) : "";
    let html = "";
    if (conns.length) {
      html += `<h3>Anschlüsse gefährdet</h3>` + conns.map((c) => {
        const a = w.trains.find((t) => t.id === c.feeder), b = w.trains.find((t) => t.id === c.conn);
        if (!a || !b) return "";
        const sb = b.stops.find((x) => x.st === c.st);
        return `<div class="conn"><div><b>${a.no}</b> (${a.trip.line}) → <b>${b.no}</b> (${b.trip.line} nach ${b.trip.to}) in ${g.stations[c.st].name}</div>
          <small>Abfahrt ${b.no} plan ${sb ? hm(sb.dep) : "?"}, Zubringer kommt ca. ${c.wait} min zu spät zum Umstieg</small><br>
          <button data-hold="${c.id}">${b.no} ${c.wait} min warten lassen</button><button class="no" data-drop="${c.id}">Anschluss aufgeben</button></div>`;
      }).join("");
    }
    if (fs.length) html += `<h3>Störungen und Ereignisse</h3>`;
    else html += `<p>Keine Störungen. ${w.faultRate ? "Es kann jederzeit etwas passieren." : "Störungen sind ausgeschaltet."}</p>`;
    html += fs.map((f) => {
      const left = Math.max(0, Math.round((f.until - w.time) / 60));
      const waiting = f.kind === "signal" ? w.trains.find((t) => t.nextSig === f.target && t.distNextSig < 400) : undefined;
      const btn = waiting ? `<button data-zs1="${f.target}">Ersatzsignal für ${waiting.no}</button>` : "";
      return `<div class="fault"><div>${f.text}</div><small>noch ca. ${left} min</small>${btn}</div>`;
    }).join("");
    const sites = w.ext.sites.filter((x) => x.until > w.time);
    if (sites.length) html += `<h3>Baustellen in dieser Schicht</h3>` + sites.map((x) => `<div class="site ${x.active ? "on" : ""}"><div>${x.text}</div><small>${x.active ? "aktiv" : "geplant"} ${hm(x.from)}–${hm(x.until)} Uhr</small></div>`).join("");
    if (feats.weather) html += `<h3>Wetter</h3><p>${WX[w.ext.wx].icon} <b>${WX[w.ext.wx].label}</b>. ${WX[w.ext.wx].text}</p>`;
    if (feats.bue) {
      const shut = w.ext.crossings.filter((c) => c.closed).length;
      html += `<h3>Bahnübergänge</h3><p>${w.ext.crossings.length} Bahnübergänge, davon ${shut} gerade geschlossen.${w.ext.crossings.some((c) => c.faultUntil) ? " Gestörte BÜ werden von den Zügen nur mit Schrittgeschwindigkeit befahren." : ""}</p>`;
    }
    if (el.dataset.h === html) return;
    el.dataset.h = html;
    el.innerHTML = html;
    el.querySelectorAll<HTMLButtonElement>("[data-hold]").forEach((b) => (b.onclick = () => {
      const why = w.holdConnection(Number(b.dataset.hold));
      toast(why ?? "Anschluss wird gehalten");
    }));
    el.querySelectorAll<HTMLButtonElement>("[data-drop]").forEach((b) => (b.onclick = () => w.dropConnection(Number(b.dataset.drop))));
    el.querySelectorAll<HTMLButtonElement>("[data-zs1]").forEach((b) => (b.onclick = () => {
      const why = w.giveZs1(Number(b.dataset.zs1));
      if (why) toast(why);
    }));
  };

  const logEl = $("log");
  let lastEvents = -1;
  const renderLog = () => {
    if (w.events.length === lastEvents) return;
    lastEvents = w.events.length;
    logEl.innerHTML = w.events.slice(-7).reverse().map((e) => `<div class="${e.kind}"><time>${hm(e.t)}</time>${e.text}</div>`).join("");
  };

  // Meldungen an meinen Signalen
  const announced = new Set<string>();
  const announce = () => {
    for (const t of w.trains) {
      if (!isMine(t.nextSig) || t.distNextSig > 4000) continue;
      const k = `${t.id}:${t.nextSig}`;
      if (announced.has(k)) continue;
      announced.add(k);
      if (!t.dwelling) w.log(`${t.no} nähert sich ${w.il.sig(t.nextSig).name}`, "info");
    }
  };

  // ---------- Schichtbericht ----------
  const showReport = () => {
    const sc = w.score;
    const hours = (w.time - shiftStart) / 3600;
    const pct = sc.trainsDone ? Math.round((100 * sc.punctual) / sc.trainsDone) : 0;
    const causes = Object.entries(sc.causes).filter(([, m]) => m >= 0.5).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const max = Math.max(1, ...causes.map(([, m]) => m));
    const grade = !sc.trainsDone ? "Noch keine Züge abgeschlossen." : sc.incidents > 0 ? "Gefährliche Ereignisse in der Schicht. Das gibt eine Untersuchung." :
      pct >= 95 ? "Hervorragende Schicht. Der Betrieb lief rund." : pct >= 85 ? "Gute Schicht mit kleinen Holprigkeiten." : pct >= 70 ? "Durchwachsene Schicht, einige Züge haben unnötig gewartet." : "Schwierige Schicht. Viele Züge kamen zu spät.";
    const own = (k: string) => k.startsWith("Halt vor Signal") || k.startsWith("Halt auf Anordnung");
    const ownMin = Object.entries(sc.causes).filter(([k]) => own(k)).reduce((a, [, m]) => a + m, 0);
    const extMin = Object.entries(sc.causes).filter(([k]) => !own(k)).reduce((a, [, m]) => a + m, 0);
    // Signal-Wartezeiten zusammenfassen
    const merged = new Map<string, number>();
    for (const [k, m] of causes) merged.set(k.startsWith("Halt vor Signal") ? `Halt vor Signal (${k.split(" ").pop()})` : k, m);
    $("report").innerHTML = `<div class="panel">
      <h2>Schichtbericht</h2>
      <div style="color:var(--dim)">${hm(shiftStart)} bis ${hm(w.time)} Uhr (${hours.toFixed(1).replace(".", ",")} h) · Stellbereich: ${[...manual].map((c) => g.stations[c].name).join(", ") || "keiner"}</div>
      <div class="grade">${grade}</div>
      <div class="kpis">
        <div><b>${sc.points}</b><small>Punkte</small></div>
        <div><b>${sc.trainsDone}</b><small>Fahrten abgeschlossen</small></div>
        <div><b>${sc.trainsDone ? pct + " %" : "–"}</b><small>pünktlich (unter 6 min)</small></div>
        <div><b>${Math.round(sc.waitMinutes)}</b><small>Minuten vor Halt zeigenden Signalen</small></div>
        <div><b>${w.faultCount}</b><small>Störungen und Ereignisse</small></div>
        <div><b>${sc.missedStops} / ${sc.trackChanges ?? 0}</b><small>verpasste Halte / Gleisänderungen</small></div>
        <div><b>${sc.incidents}</b><small>gefährliche Ereignisse</small></div>
        <div><b>${Math.round(ownMin)} / ${Math.round(extMin)}</b><small>Wartemin. selbst / fremd verursacht</small></div>
      </div>
      <h3>Verspätungsursachen (abgeschlossene Fahrten, Minuten)</h3>
      ${causes.length ? `<table>${[...merged].map(([k, m]) => `<tr><td>${k}</td><td style="width:45%"><div class="bar" style="width:${(100 * m) / max}%"></div></td><td style="text-align:right">${m.toFixed(1).replace(".", ",")}</td></tr>`).join("")}</table>` : "<p>Keine erfassten Verspätungen.</p>"}
      ${sc.late.length ? `<h3>Verspätete Züge (ab 6 min)</h3><table>${sc.late.slice(-15).reverse().map((l) => `<tr><td>${l.no}</td><td>+${l.min} min</td><td>${l.cause}</td></tr>`).join("")}</table>` : ""}
      <button id="repClose">Weiter stellen</button> <button id="repNew" style="background:#3a4656">Neue Schicht</button>
    </div>`;
    $("report").classList.remove("hidden");
    $("repClose").onclick = () => $("report").classList.add("hidden");
    $("repNew").onclick = () => location.reload();
  };
  $("saveBtn").onclick = () => doSave();
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); doSave(); }
  });
  $("endBtn").onclick = () => { setSpeed(0); showReport(); };

  // ---------- Zweiter Monitor ----------
  const ch = new BroadcastChannel(CHANNEL);
  const sendSnap = () => ch.postMessage({ type: "snap", snap: makeSnapshot(w, g) });
  ch.onmessage = (e) => {
    if (e.data?.type === "hello") sendSnap();
    if (e.data?.type === "accept") {
      const why = w.acceptReport(Number(e.data.id));
      if (why) toast(why);
      sendSnap();
    }
  };
  $("monBtn").onclick = () => {
    const win = window.open("monitor.html", "stellwerk-monitor", "popup,width=1600,height=900");
    if (!win) toast("Das Fenster wurde blockiert. Bitte Pop-ups für diese Seite erlauben.");
  };
  let snapT = 0;

  // ---------- Hauptschleife ----------
  let last = performance.now(), uiT = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    w.advance(dt, speed);
    view.draw(dt);
    uiT += dt;
    snapT += dt;
    if (snapT > 1) { snapT = 0; sendSnap(); }
    if (uiT > 0.4) {
      uiT = 0;
      announce();
      renderLists();
      renderLog();
      renderCard();
      renderFaults();
      $("clock").textContent = fmt(w.time);
      $("pts").textContent = String(w.score.points);
      $("punct").textContent = w.score.trainsDone ? `${Math.round((100 * w.score.punctual) / w.score.trainsDone)} %` : "–";
      $("wait").textContent = String(Math.round(w.score.waitMinutes));
      $("ntrains").textContent = String(w.trains.length);
      $("wx").innerHTML = wxNow();
    }
    if (toastT && now > toastT) {
      toastEl.classList.remove("show");
      toastT = 0;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  (window as any).game = { w, view, g };
}

boot();
