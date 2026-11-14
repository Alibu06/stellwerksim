import { buildCorridor } from "./data/corridor";
import { buildTrips, RawTimetable } from "./sim/timetable";
import { Train, World } from "./sim/world";
import { View, CAT_COLOR as VIEW_CAT } from "./render/view";

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

  $("areaPick").innerHTML = AREAS.map(([c, n]) => `<label><input type="checkbox" value="${c}" ${DEFAULT_MANUAL.has(c) ? "checked" : ""}> ${n}</label>`).join("");
  await new Promise<void>((res) => ($("go").onclick = () => res()));
  const startHour = Number(($("startHour") as HTMLSelectElement).value);
  const faultRate = Number(($("faults") as HTMLSelectElement).value);
  const manual = new Set([...document.querySelectorAll<HTMLInputElement>("#areaPick input:checked")].map((i) => i.value));
  $("start").remove();

  const trips = buildTrips(g, raw, Number(raw.date));
  const w = new World(g, trips, startHour * 3600 - 120 * 60);
  w.faultRate = 0;
  const applyAreas = () => {
    for (const s of g.signals) s.auto = s.kind === "block" || !manual.has(s.name.slice(0, 2));
  };
  applyAreas();
  // Vorlauf: 2 Stunden automatisch, damit beim Dienstbeginn schon Züge unterwegs sind
  const saved = g.signals.map((s) => s.auto);
  for (const s of g.signals) s.auto = true;
  while (w.time < startHour * 3600) w.step(0.5);
  g.signals.forEach((s, i) => (s.auto = saved[i]));
  w.events = [];
  w.score = { points: 0, trainsDone: 0, punctual: 0, waitMinutes: 0, missedStops: 0, incidents: 0 };
  w.faultRate = faultRate;
  w.log(`Dienstbeginn. Du stellst: ${[...manual].map((c) => g.stations[c].name).join(", ") || "nichts (Beobachtungsmodus)"}.`, "good");

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
  cv.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const h = view.hit(e.offsetX, e.offsetY);
    if (h?.kind === "signal") {
      if (w.il.cancel(h.sig.id)) w.log(`Fahrstraße ab ${h.sig.name} zurückgenommen`);
      else toast("Keine zurücknehmbare Fahrstraße an diesem Signal");
    }
    clearSel();
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

  // ---------- Zugkarte ----------
  const card = $("card");
  let cardTrain: Train | null = null;
  const showTrain = (t: Train) => {
    cardTrain = t;
    view.focusTrain = t;
    renderCard();
    card.classList.remove("hidden");
  };
  const renderCard = () => {
    const t = cardTrain;
    if (!t) return;
    if (t.gone) {
      card.classList.add("hidden");
      cardTrain = null;
      view.focusTrain = null;
      return;
    }
    const tr = t.trip;
    const rows = t.stops.map((s, i) => `<tr class="${s.done ? "done" : i === t.stopIdx ? "cur" : ""}"><td>${g.stations[s.st].name}${s.missed ? " ✕" : ""}</td><td>${hm(s.arr)}</td><td>${hm(s.dep)}</td></tr>`).join("");
    const dm = Math.round(t.delay / 60);
    card.innerHTML = `<button class="x">×</button><h2 style="color:${CAT_COLOR[t.cat]}">${t.no}</h2>
      <div class="meta">${tr.from} → ${tr.to}<br>${t.len} m · ${Math.round(t.vmax * 3.6)} km/h${tr.mass ? ` · ${tr.mass} t` : ""} · jetzt ${Math.round(t.v * 3.6)} km/h ·
      <span class="${dm >= 6 ? "bad" : dm >= 3 ? "warn" : "ok"}">${dm > 0 ? `+${dm} min` : "pünktlich"}</span></div>
      ${rows ? `<table><tr><td></td><td>an</td><td>ab</td></tr>${rows}</table>` : ""}
      <div class="meta" style="margin-top:8px">${tr.exitPortal ? `Ausfahrt Richtung ${g.portals[tr.exitPortal].label}` : tr.turnInto ? `Wendet als ${tr.turnInto.no}` : "Endet hier"}${t.nextSig ? ` · nächstes Signal ${w.il.sig(t.nextSig).name}` : ""}</div>`;
    card.querySelector<HTMLButtonElement>(".x")!.onclick = () => {
      card.classList.add("hidden");
      cardTrain = null;
      view.focusTrain = null;
    };
  };

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
    $("tab-trains").querySelectorAll<HTMLElement>(".row").forEach((r) => (r.onclick = () => {
      const t = w.trains.find((x) => x.id === Number(r.dataset.id));
      if (t) {
        showTrain(t);
        const e = g.edges[t.body[t.body.length - 1]];
        view.centerOn(g.nodes[e.a].x, g.nodes[e.a].y);
      }
    }));
    $("tab-next").innerHTML = `<p>Züge, die in den nächsten Minuten in den Bereich einfahren oder bereitgestellt werden.</p>` +
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
    $("faultCount").textContent = fs.length ? String(fs.length) : "";
    if (!fs.length) {
      el.innerHTML = `<p>Keine Störungen. ${w.faultRate ? "Es kann jederzeit etwas passieren." : "Störungen sind ausgeschaltet."}</p>`;
      return;
    }
    el.innerHTML = fs.map((f) => {
      const left = Math.max(0, Math.round((f.until - w.time) / 60));
      const waiting = f.kind === "signal" ? w.trains.find((t) => t.nextSig === f.target && t.distNextSig < 400) : undefined;
      const btn = waiting ? `<button data-zs1="${f.target}">Ersatzsignal für ${waiting.no}</button>` : "";
      return `<div class="fault"><div>${f.text}</div><small>noch ca. ${left} min</small>${btn}</div>`;
    }).join("");
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

  // ---------- Hauptschleife ----------
  let last = performance.now(), uiT = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    w.advance(dt, speed);
    view.draw(dt);
    uiT += dt;
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
