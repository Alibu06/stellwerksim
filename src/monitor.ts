import { CHANNEL, Snapshot, SnapStop, SnapTrain } from "./sim/snapshot";
import { applyThemeClass, tc } from "./ui/theme";

// Zweiter Monitor: Abfahrts-/Ankunftstafel, klickbarer Bildfahrplan und ein Arbeitsbereich mit
// Lage (Störungen, Baustellen, Ereignisse), Dispo (Zugmeldungen, Anschlüsse, Gleisänderung, Wenden, Überholung, Ausfall),
// Funk und Meldungen. Befehle gehen über den BroadcastChannel an das Stellwerk.

const CAT_D: Record<string, string> = { S: "#2fd27a", RE: "#ff4d57", RB: "#4d8dff", ICE: "#f2f6fa", G: "#d38a2e" };
const CAT = new Proxy(CAT_D, { get: (o, k) => (typeof k === "string" && o[k] ? tc(o[k]) : (o as any)[k]) }) as Record<string, string>;
applyThemeClass();
window.addEventListener("storage", (e) => { if (e.key === "theme") { applyThemeClass(); if (snap) render(); } });
const RADIO_CMDS = [
  { id: "lage", label: "Wo stehen Sie?" },
  { id: "grund", label: "Was ist los?" },
  { id: "halt", label: "Sofort anhalten" },
  { id: "weiter", label: "Weiterfahrt erlaubt" },
  { id: "anschluss", label: "Anschluss abwarten (3 min)" },
  { id: "zs1", label: "Vorbeifahrt am Halt zeigenden Signal" },
  { id: "sicht", label: "Auf Sicht fahren" },
  { id: "verstanden", label: "Danke, Ende" },
];
const REFUSE = ["Gleise im Bahnhof belegt", "Strecke gesperrt", "Störung im Stellwerksbereich", "Zugfolge: anderer Zug hat Vorrang", "betriebliche Gründe"];

const $ = (id: string) => document.getElementById(id)!;
const hm = (t: number) => {
  const s = Math.floor(((t % 86400) + 86400) % 86400);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}`;
};
const hms = (t: number) => `${hm(t)}:${String(Math.floor(((t % 60) + 60) % 60)).padStart(2, "0")}`;
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const cls = (d: number) => (d >= 300 ? "bad" : d >= 60 ? "warn" : "ok");
const short = (no: string) => no.replace(/^\S+ /, "");
const trackHtml = (s: { plan?: string; disp?: string; track?: string }) => {
  const soll = s.disp ?? s.plan;
  if (s.track && soll && s.track !== soll) return `<s>${s.plan ?? soll}</s> <b class="chg">${s.track}</b>`;
  if (s.disp && s.plan && s.disp !== s.plan) return `<s>${s.plan}</s> <b class="chg">${s.disp}</b>`;
  return s.track ?? soll ?? "–";
};

const ch = new BroadcastChannel(CHANNEL);
let snap: Snapshot | null = null;
let lastMsg = 0;
let mode: "dep" | "arr" = "dep";
let range = 120;
let tab = localStorage.getItem("monitor-tab") ?? "lage";
let selId: number | null = null;
let bigId: number | null = null;
let big: { id: number; s?: Record<string, string>; gone?: boolean } | null = null;
const ui: Record<string, string> = {}; // Auswahl in Listenfeldern über Neuaufbau hinweg
const trails = new Map<number, { t: number; s: number }[]>(); // Ist-Verlauf je Zug

// ---------- Kommunikation ----------
let cmdNo = 0;
const pending = new Map<number, string>();
function cmd(c: string, args: Record<string, unknown>, okText?: string) {
  const n = ++cmdNo;
  if (okText) pending.set(n, okText);
  ch.postMessage({ type: "cmd", c, n, ...args });
}
ch.onmessage = (e) => {
  const d = e.data;
  if (d?.type === "ack") {
    const ok = pending.get(d.n);
    pending.delete(d.n);
    if (!d.ok) toast(d.text, true);
    else if (ok) toast(ok);
    return;
  }
  if (d?.type === "open") { openBig(Number(d.id)); return; }
  if (d?.type !== "snap") return;
  snap = d.snap as Snapshot;
  big = d.big ?? null;
  lastMsg = performance.now();
  for (const t of snap.trains) {
    if (!t.live || !isFinite(t.s)) continue;
    const a = trails.get(t.id) ?? [];
    const last = a[a.length - 1];
    if (!last || snap.time - last.t >= 15 || Math.abs(t.s - last.s) > 200) a.push({ t: snap.time, s: t.s });
    if (a.length > 2000) a.shift();
    trails.set(t.id, a);
  }
  render();
};
ch.postMessage({ type: "hello" });
setInterval(() => ch.postMessage({ type: "ping" }), 2000);
setInterval(() => {
  const on = performance.now() - lastMsg < 3000;
  $("conn").className = on ? "" : "off";
  $("conn").textContent = on ? "verbunden" : "keine Verbindung zum Stellwerk – Spiel im anderen Fenster starten";
}, 1000);

let toastT = 0;
function toast(text: string, bad = false) {
  const el = $("mtoast");
  el.textContent = text;
  el.className = `show${bad ? " bad" : ""}`;
  clearTimeout(toastT);
  toastT = window.setTimeout(() => (el.className = ""), 3500);
}

// ---------- Neuaufbau ohne Bedienung zu stören ----------
let pointerDown = false;
document.addEventListener("pointerdown", () => (pointerDown = true), true);
document.addEventListener("pointerup", () => setTimeout(() => (pointerDown = false), 0), true);
const cache = new WeakMap<Element, string>();
function setHtml(el: HTMLElement, html: string) {
  if (cache.get(el) === html) return;
  const a = document.activeElement;
  if (a && el.contains(a) && /^(SELECT|INPUT|TEXTAREA)$/.test(a.tagName)) return; // Benutzer wählt gerade aus
  if (pointerDown && el.matches(":hover")) return; // Klick läuft gerade
  cache.set(el, html);
  el.innerHTML = html;
}
const opt = (k: string, list: [string, string][], def?: string) => {
  const v = ui[k] ?? def ?? list[0]?.[0];
  return list.map(([val, label]) => `<option value="${esc(val)}"${val === v ? " selected" : ""}>${esc(label)}</option>`).join("");
};

// ---------- Bedienelemente ----------
document.querySelectorAll<HTMLButtonElement>("[data-m]").forEach((b) => (b.onclick = () => {
  mode = b.dataset.m as "dep" | "arr";
  document.querySelectorAll("[data-m]").forEach((x) => x.classList.toggle("on", x === b));
  render();
}));
document.querySelectorAll<HTMLButtonElement>("[data-r]").forEach((b) => (b.onclick = () => {
  range = Number(b.dataset.r);
  document.querySelectorAll("[data-r]").forEach((x) => x.classList.toggle("on", x === b));
  render();
}));
const sel = $("station") as HTMLSelectElement;
sel.onchange = () => { localStorage.setItem("monitor-station", sel.value); render(); };

function setTab(t: string) {
  tab = t;
  localStorage.setItem("monitor-tab", t);
  document.querySelectorAll<HTMLButtonElement>(".mtabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  document.querySelectorAll<HTMLElement>(".pane").forEach((p) => p.classList.toggle("hidden", p.id !== `p-${t}`));
  render();
}
document.querySelectorAll<HTMLButtonElement>(".mtabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab!)));
setTab(tab);

function select(id: number | null, show?: string) {
  selId = id;
  if (show) setTab(show);
  else render();
}
const byNo = (no: string) => snap?.trains.find((t) => t.no === no);
const selTrain = () => (selId === null ? undefined : snap?.trains.find((t) => t.id === selId));
const stName = (code: string) => snap?.stations.find((s) => s.code === code)?.name ?? code;

// Klicks im Seitenbereich und auf der Tafel (Delegation, überlebt den Neuaufbau)
document.addEventListener("change", (e) => {
  const el = e.target as HTMLSelectElement;
  if (el.dataset.k) ui[el.dataset.k] = el.value;
  if (el.dataset.k === "sel") select(el.value ? Number(el.value) : null);
  if (el.dataset.trk) {
    const t = selTrain();
    if (t) cmd("track", { key: t.key, st: el.dataset.trk, track: el.value }, el.value ? `${t.no}: Gleisänderung in ${stName(el.dataset.trk)} auf Gleis ${el.value}` : `${t.no}: wieder Regelgleis in ${stName(el.dataset.trk)}`);
    el.blur();
  }
});
document.addEventListener("click", (e) => {
  pointerDown = false;
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a],[data-sel],[data-selno],tr[data-id]");
  if (!b || !snap) return;
  if (b.dataset.sel) return select(Number(b.dataset.sel), b.dataset.go);
  if (b.dataset.selno) { const t = byNo(b.dataset.selno); if (t) select(t.id, "dispo"); return; }
  if (b.tagName === "TR" && b.dataset.id) return select(Number(b.dataset.id), tab === "lage" || tab === "log" ? "dispo" : undefined);
  const a = b.dataset.a!, id = Number(b.dataset.id);
  const t = selTrain();
  switch (a) {
    case "accept": cmd("accept", { id }, "Zugmeldung angenommen"); break;
    case "refuse": cmd("refuse", { id, why: ui[`rf${id}`] ?? REFUSE[0] }, "Zugmeldung abgelehnt, Nachbar bietet in 3 min erneut an"); break;
    case "hold": cmd("hold", { id }, "Anschluss wird gehalten"); break;
    case "drop": cmd("drop", { id }, "Anschluss aufgegeben"); break;
    case "focus": if (t) cmd("focus", { id: t.id }); break;
    case "funk": setTab("funk"); break;
    case "turn": if (t) { const st = ui[`turn${t.id}`] ?? t.turnOpts?.[0]; if (st) cmd("shortTurn", { id: t.id, st }, t.turnInto ? `${t.no} wendet in ${stName(st)}` : `${t.no} endet in ${stName(st)}`); } break;
    case "ov": if (t) {
      const st = ui[`ovst${t.id}`] ?? t.ovSt?.[0], other = Number(ui[`ovby${t.id}`] ?? t.ovBy?.[0]?.id);
      if (st && other) cmd("overtake", { id: t.id, st, other }, `${t.no} wird in ${stName(st)} überholt`);
    } break;
    case "cancel": if (t) {
      if (ui.cancelArm !== String(t.key)) { ui.cancelArm = String(t.key); render(); break; }
      delete ui.cancelArm;
      cmd("cancel", { key: t.key }, `${t.no} fällt aus`);
      selId = null;
    } break;
    case "radio": if (t) cmd("radio", { id: t.id, text: b.dataset.text, cmd: b.dataset.cmd }); break;
    case "big": if (t && t.live) openBig(t.id); else toast("Großansicht gibt es für Züge im Bereich", true); break;
    case "reason": if (t) {
      const r = (document.getElementById("bigReason") as HTMLSelectElement | null)?.value ?? "";
      const n = (document.getElementById("bigNote") as HTMLInputElement | null)?.value ?? "";
      cmd("reason", { id: t.id, reason: r, note: n }, r ? `Ursache für ${t.no} gespeichert` : "Ursache entfernt");
    } break;
  }
});

// ---------- Darstellung ----------
function render() {
  if (!snap) return;
  $("clock").textContent = hms(snap.time);
  const sc = snap.score;
  setHtml($("stats"), `<span><b>${sc.points}</b>Punkte</span><span><b>${sc.trainsDone ? Math.round((100 * sc.punctual) / sc.trainsDone) : "–"}</b>% pünktlich</span><span><b>${Math.round(sc.waitMinutes)}</b>Min. vor Halt</span>`);
  if (!sel.options.length) {
    sel.innerHTML = snap.stations.filter((s) => s.code !== "NH").sort((a, b) => a.s - b.s).map((s) => `<option value="${s.code}">${esc(s.name)}</option>`).join("");
    sel.value = localStorage.getItem("monitor-station") ?? "TR";
  }
  if (selId !== null && !selTrain()) {
    // Zug ist inzwischen eingefahren: vom erwarteten auf den echten Zug umschalten
    const key = selId < 0 ? -selId : undefined;
    const live = key !== undefined ? snap.trains.find((t) => t.live && t.key === key) : undefined;
    selId = live ? live.id : null;
  }
  const nOpen = snap.reports.filter((r) => r.kind === "in" && r.state === "offered").length + snap.conns.length;
  $("nDispo").textContent = nOpen ? String(nOpen) : "";
  $("nLage").textContent = snap.situation.length ? String(snap.situation.filter((x) => !x.planned).length || "") : "";
  renderBoard();
  if (bigId !== null) renderBig();
  if (tab === "lage") renderLage();
  if (tab === "dispo") renderDispo();
  if (tab === "funk") renderFunk();
  if (tab === "log") setHtml($("p-log"), snap.events.slice().reverse().map((e) => `<div class="ev ${e.kind}"><time>${hm(e.t)}</time>${esc(e.text)}</div>`).join(""));
  drawGraph();
}

function renderBoard() {
  const code = sel.value;
  const rows: { t: SnapTrain; plan: number; prog: number; ist?: number; via: string; track: string; done: boolean }[] = [];
  for (const t of snap!.trains) {
    const i = t.stops.findIndex((s) => s.st === code);
    if (i < 0) continue;
    const s = t.stops[i];
    if (s.betr) continue;
    const isFirst = i === 0, isLast = i === t.stops.length - 1;
    const plan = mode === "dep" ? s.dep : s.arr;
    const ist = mode === "dep" ? s.actDep : s.actArr;
    const prog = mode === "dep" ? Math.max(s.dep, s.eta + (s.dep - s.arr)) : s.eta;
    const via = (mode === "dep" ? t.stops.slice(i + 1, i + 4) : t.stops.slice(Math.max(0, i - 3), i)).filter((x) => !x.betr).map((x) => stName(x.st)).join(" – ");
    if (mode === "dep" && isLast && !t.to) continue;
    if (mode === "arr" && isFirst && !t.from) continue;
    rows.push({ t, plan, prog, ist, via, track: trackHtml(s), done: s.done });
  }
  rows.sort((a, b) => a.plan - b.plan);
  const now = snap!.time;
  const list = rows.filter((r) => (r.ist ?? r.prog) >= now - 120).slice(0, 22);
  setHtml($("boardTab"), `<tr><th>Zeit</th><th>Prognose</th><th>Zug</th><th>${mode === "dep" ? "Nach" : "Von"}</th><th>Gl.</th></tr>` +
    (list.length ? list.map((r) => {
      const d = (r.ist ?? r.prog) - r.plan;
      const shown = r.ist !== undefined ? `<span class="${cls(d)}">${hm(r.ist)}</span><small>${mode === "dep" ? "abgefahren" : "angekommen"}</small>`
        : `<span class="${cls(d)}">${d >= 60 ? hm(r.prog) : "pünktlich"}</span>${d >= 60 ? `<small class="${cls(d)}">+${Math.round(d / 60)} min${r.t.reason ? ` · ${esc(r.t.reason)}` : ""}</small>` : ""}`;
      return `<tr data-id="${r.t.id}" class="${r.done ? "gone" : ""}${r.t.id === selId ? " sel" : ""}"><td class="t">${hm(r.plan)}</td><td class="p">${shown}</td>
        <td><span class="cat" style="background:${CAT[r.t.cat]}">${esc(r.t.line)}</span><span class="no">${esc(short(r.t.no))}</span></td>
        <td><span class="dest">${esc(mode === "dep" ? r.t.to : r.t.from)}</span><small>${esc(r.via)}</small><small>${esc(r.t.status)}</small></td><td class="t">${r.track}</td></tr>`;
    }).join("") : `<tr><td colspan="5" class="empty">Keine Züge in der nächsten Zeit.</td></tr>`));
}

const KIND_ORDER: Record<string, number> = { ereignis: 0, stoerung: 1, zug: 2, bue: 3, fdl: 4, baustelle: 5, wetter: 6 };
const KIND_LABEL: Record<string, string> = { ereignis: "Ereignis", stoerung: "Störung", zug: "Zugstörung", bue: "Bahnübergang", fdl: "Anordnung", baustelle: "Baustelle", wetter: "Wetter" };
function renderLage() {
  const s = snap!, now = s.time;
  const items = s.situation.slice().sort((a, b) => Number(!!a.planned) - Number(!!b.planned) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.until ?? 1e12) - (b.until ?? 1e12));
  const active = items.filter((x) => !x.planned);
  let html = `<div class="sum">${active.length ? `<b>${active.length}</b> ${active.length === 1 ? "Einschränkung" : "Einschränkungen"} im Bereich` : "<b>Alles ruhig.</b> Keine Einschränkungen im Bereich."}</div>`;
  html += items.map((x) => {
    const left = x.until !== undefined ? Math.max(0, Math.round((x.until - now) / 60)) : undefined;
    const time = x.planned ? `geplant ${hm(x.from!)}–${hm(x.until!)} Uhr (in ${Math.round((x.from! - now) / 60)} min)`
      : [x.from !== undefined ? `seit ${hm(x.from)}` : "", x.until !== undefined ? `voraussichtlich bis ${hm(x.until)} (noch ${left} min)` : "Dauer offen"].filter(Boolean).join(" · ");
    const pct = x.from !== undefined && x.until !== undefined && !x.planned ? Math.min(100, Math.max(0, (100 * (now - x.from)) / Math.max(1, x.until - x.from))) : undefined;
    return `<div class="lage ${x.kind}${x.planned ? " planned" : ""}">
      <div class="lh"><span class="ic">${x.icon}</span><div><small>${KIND_LABEL[x.kind]}${x.where ? ` · ${esc(x.where)}` : ""}</small><b>${esc(x.title)}</b></div></div>
      <p>${esc(x.effect)}</p>
      <div class="lt">${time}</div>${pct !== undefined ? `<div class="bar"><i style="width:${pct.toFixed(0)}%"></i></div>` : ""}
      ${x.trains.length ? `<div class="chips"><small>Betroffen:</small>${x.trains.slice(0, 12).map((no) => `<button data-selno="${esc(no)}">${esc(short(no))}</button>`).join("")}${x.trains.length > 12 ? `<small>+${x.trains.length - 12}</small>` : ""}</div>` : ""}
    </div>`;
  }).join("");
  setHtml($("p-lage"), html);
}

function stopRow(t: SnapTrain, p: SnapStop) {
  const tracks = snap!.tracks[p.st] ?? [];
  const prog = Math.max(p.dep, p.eta + (p.dep - p.arr));
  const d = p.eta - p.arr;
  const arrived = p.actArr !== undefined;
  const canChange = tracks.length >= 2 && !arrived;
  const trk = canChange
    ? `<select data-trk="${p.st}" class="${p.disp && p.disp !== p.plan ? "chg" : ""}"><option value="">${p.plan ? `Regel ${p.plan}` : "Regel"}</option>${tracks.map((x) => `<option value="${x}"${p.disp === x && p.disp !== p.plan ? " selected" : ""}>Gl. ${x}</option>`).join("")}</select>`
    : trackHtml(p);
  return `<tr class="${p.betr ? "betr" : ""}"><td>${esc(stName(p.st))}${p.betr ? " <small>Betriebshalt</small>" : ""}</td><td class="t">${hm(p.arr)}</td>
    <td class="t ${cls(d)}">${arrived ? hm(p.actArr!) : d >= 60 ? hm(p.eta) : "–"}</td><td class="t">${p.dep !== p.arr ? hm(p.dep) : ""}${prog - p.dep >= 60 ? `<small class="warn">${hm(prog)}</small>` : ""}</td><td>${trk}</td></tr>`;
}

function dispoActs(t: SnapTrain): string {
  let html = "";
    if (t.live && t.turnOpts?.length) {
      html += `<div class="act"><b>Vorzeitig wenden</b><small>${t.turnInto ? `Der Zug endet früher und fährt als ${esc(t.turnInto)} ab dort zurück. Die Halte dahinter entfallen in beide Richtungen.` : "Der Zug endet früher (Teilausfall). Die Halte dahinter entfallen."}</small>
        <div class="ra"><select data-k="turn${t.id}">${opt(`turn${t.id}`, t.turnOpts.map((c) => [c, stName(c)]))}</select><button class="no" data-a="turn">${t.turnInto ? "Dort wenden" : "Dort enden lassen"}</button></div></div>`;
    }
    if (t.live && t.ovSt?.length && t.ovBy?.length) {
      html += `<div class="act"><b>Überholen lassen</b><small>Der Zug wartet im gewählten Bahnhof, bis der schnellere Zug vorbei ist (höchstens 20 min). Fehlt dort ein Halt, wird ein Betriebshalt eingelegt.</small>
        <div class="ra"><select data-k="ovst${t.id}">${opt(`ovst${t.id}`, t.ovSt.map((c) => [c, stName(c)]))}</select>
        <select data-k="ovby${t.id}">${opt(`ovby${t.id}`, t.ovBy.map((o) => [String(o.id), `durch ${short(o.no)}`]))}</select><button data-a="ov">Anordnen</button></div></div>`;
    }
    if (!t.live) {
      const armed = ui.cancelArm === String(t.key);
      html += `<div class="act"><b>Zugausfall</b><small>Der Zug fährt nicht in deinen Bereich ein. Das lässt sich nicht rückgängig machen.</small>
        <div class="ra"><button class="no${armed ? " armed" : ""}" data-a="cancel">${armed ? "Wirklich ausfallen lassen? Nochmal klicken" : "Zug ausfallen lassen"}</button></div></div>`;
    }
  return html;
}

function renderDispo() {
  const s = snap!;
  let html = "";
  const open = s.reports.filter((r) => r.kind === "in" && r.state === "offered");
  html += `<h3>Zugmeldungen</h3>`;
  html += open.length ? open.map((r) => `<div class="rep"><div><b>${esc(r.no)}</b> von Fdl ${esc(r.where)}<br><small>${esc(r.from)} → ${esc(r.to)} · ca. ${hm(r.at)}</small></div>
      <div class="ra"><button class="go" data-a="accept" data-id="${r.id}">Annehmen</button>
      <span class="rf"><select data-k="rf${r.id}">${opt(`rf${r.id}`, REFUSE.map((x) => [x, x]))}</select><button class="no" data-a="refuse" data-id="${r.id}">Ablehnen</button></span></div></div>`).join("")
    : `<p class="empty">Keine offenen Zugmeldungen.</p>`;
  const done = s.reports.filter((r) => !(r.kind === "in" && r.state === "offered")).slice(-4).reverse();
  html += done.map((r) => `<div class="rep small ${r.kind === "out" ? "out" : r.state === "refused" ? "ref" : "acc"}"><b>${esc(r.no)}</b> ${r.kind === "in" ? `von ${esc(r.where)}` : `an ${esc(r.where)}`}: <small>${r.state === "accepted" ? "angenommen" : r.state === "refused" ? `abgelehnt (${esc(r.note ?? "")})` : "angeboten, warte auf Antwort"}</small></div>`).join("");
  if (s.conns.length) {
    html += `<h3>Anschlüsse gefährdet</h3>` + s.conns.map((c) => `<div class="conn"><div><b>${esc(c.feeder)}</b> → <b>${esc(c.conn)}</b> in ${esc(c.st)}</div>
      <small>Abfahrt plan ${hm(c.dep)}. ${esc(c.text)}</small><div class="ra"><button class="go" data-a="hold" data-id="${c.id}">${c.wait} min warten lassen</button><button class="no" data-a="drop" data-id="${c.id}">Anschluss aufgeben</button></div></div>`).join("");
  }
  // Zugauswahl
  const live = s.trains.filter((t) => t.live).sort((a, b) => short(a.no).localeCompare(short(b.no), "de", { numeric: true }));
  const up = s.trains.filter((t) => !t.live).sort((a, b) => (a.entry ?? 0) - (b.entry ?? 0));
  html += `<h3>Zug disponieren</h3><select data-k="sel" class="wide"><option value="">– Zug wählen (oder im Bildfahrplan / auf der Tafel anklicken) –</option>
    <optgroup label="Im Bereich">${live.map((t) => `<option value="${t.id}"${t.id === selId ? " selected" : ""}>${esc(t.no)} · ${esc(t.from)} → ${esc(t.to)}</option>`).join("")}</optgroup>
    <optgroup label="Erwartet">${up.map((t) => `<option value="${t.id}"${t.id === selId ? " selected" : ""}>${esc(t.no)} · ${hm(t.entry ?? 0)} · ${esc(t.to)}</option>`).join("")}</optgroup></select>`;
  const t = selTrain();
  if (t) {
    const d = Math.round(t.delay / 60);
    html += `<div class="tcard"><div class="th"><span class="cat" style="background:${CAT[t.cat]}">${esc(t.line)}</span><b>${esc(t.no)}</b> <span>${esc(t.from)} → ${esc(t.to)}</span>
      <span class="${cls(t.delay)} dl">${d >= 1 ? `+${d} min` : "pünktlich"}</span></div>
      <small>${t.live ? esc(t.where ?? "") : esc(t.status)}${t.live && t.status ? ` · ${esc(t.status)}` : ""}</small>
      ${t.fault ? `<div class="flag bad">${esc(t.fault)}</div>` : ""}${t.hold ? `<div class="flag warn">Halt auf deine Anordnung</div>` : ""}${t.waitFor ? `<div class="flag info">Wartet auf Überholung durch ${esc(t.waitFor)}</div>` : ""}
      ${t.live ? `<div class="ra"><button data-a="big">Großansicht</button><button data-a="focus">Im Stellwerk zeigen</button><button data-a="funk">Funk</button></div>` : ""}
      <table class="stops"><tr><th>Halt</th><th>an</th><th>Prog.</th><th>ab</th><th>Gleis</th></tr>${t.stops.filter((p) => !p.done || p.actDep === undefined).map((p) => stopRow(t, p)).join("")}</table>`;
    html += dispoActs(t);
    html += `</div>`;
  }
  setHtml($("p-dispo"), html);
}

// Funk: Kopf und Verlauf werden neu aufgebaut, das Eingabefeld bleibt bestehen
$("p-funk").innerHTML = `<div id="funkHead"></div><div id="funkLog" class="radio"></div><div id="funkCmds"></div>
  <form id="funkForm" class="rform"><input id="funkIn" placeholder="Freier Funkspruch, z. B. „Warum stehen Sie?“" autocomplete="off"><button>Senden</button></form>`;
$("funkForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const i = $("funkIn") as HTMLInputElement;
  const t = selTrain();
  if (!t || !t.live) return toast("Erst einen Zug im Bereich wählen", true);
  if (!i.value.trim()) return;
  cmd("radio", { id: t.id, text: i.value.trim() });
  i.value = "";
});
function renderFunk() {
  const s = snap!;
  const live = s.trains.filter((t) => t.live).sort((a, b) => short(a.no).localeCompare(short(b.no), "de", { numeric: true }));
  const t = selTrain();
  setHtml($("funkHead"), `<select data-k="sel" class="wide"><option value="">– Zug zum Anfunken wählen –</option>${live.map((x) => `<option value="${x.id}"${x.id === selId ? " selected" : ""}>${esc(x.no)} · ${esc(x.where ?? "")}</option>`).join("")}</select>
    ${t && t.live ? `<small class="fw">${esc(t.no)}: ${esc(t.where ?? "")} · ${Math.round(t.v * 3.6)} km/h</small>` : ""}`);
  const log = $("funkLog");
  const html = !t ? `<p class="empty">Wähle einen Zug, um ihn anzufunken.</p>` : !t.live ? `<p class="empty">${esc(t.no)} ist noch nicht im Bereich.</p>`
    : t.radio?.length ? t.radio.map((m) => `<div class="${m.from}"><time>${hm(m.t)}</time><b>${m.from === "fdl" ? "Fdl" : "Tf"}</b> ${esc(m.text)}</div>`).join("") : `<p class="empty">Noch kein Funkverkehr mit ${esc(t.no)}.</p>`;
  if (cache.get(log) !== html) { setHtml(log, html); log.scrollTop = log.scrollHeight; }
  setHtml($("funkCmds"), t && t.live ? RADIO_CMDS.map((c) => `<button data-a="radio" data-cmd="${c.id}" data-text="${esc(c.label)}">${esc(c.label)}</button>`).join("") : "");
}

// ---------------- Bildfahrplan ----------------
const cv = $("cv") as HTMLCanvasElement;
const lines = new Map<number, [number, number][][]>(); // Bildschirmlinien je Zug für die Trefferprüfung
let hoverId: number | null = null;
function drawGraph() {
  const s = snap!;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const ctx = cv.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = tc("#0b1016");
  ctx.fillRect(0, 0, W, H);
  lines.clear();
  const add = (id: number, pl: [number, number][]) => { const a = lines.get(id) ?? []; a.push(pl); lines.set(id, a); };
  const st = s.stations.filter((x) => x.main).sort((a, b) => a.s - b.s);
  const s0 = st[0].s - 500, s1 = st[st.length - 1].s + 500;
  const L = 150, R = 16, T = 26, B = 16;
  const t0 = s.time - range * 60 * 0.35, t1 = s.time + range * 60 * 0.65;
  const X = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const Y = (m: number) => T + ((m - s0) / (s1 - s0)) * (H - T - B);
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.textAlign = "right";
  for (const x of st) {
    const y = Y(x.s);
    ctx.strokeStyle = tc("#18212c");
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
    ctx.fillStyle = tc("#9fb0c3");
    ctx.fillText(x.name.replace(" (Sieg)", ""), L - 8, y + 4);
  }
  ctx.textAlign = "center";
  const step = range <= 60 ? 600 : range <= 120 ? 900 : 1800;
  for (let t = Math.ceil(t0 / step) * step; t < t1; t += step) {
    const x = X(t);
    ctx.strokeStyle = tc("#151d27");
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, H - B); ctx.stroke();
    ctx.fillStyle = tc("#7b8ca0");
    ctx.fillText(hm(t), x, T - 8);
  }
  // Baustellen und Sperrungen als Bänder hinterlegen
  const sOf = (code: string) => s.stations.find((x) => x.code === code)?.s ?? NaN;
  const onMain = (code: string) => s.stations.find((x) => x.code === code)?.main;
  const focus = selId ?? hoverId;
  const stroke = (pl: [number, number][]) => { ctx.beginPath(); pl.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); };
  // Plan (gestrichelt)
  for (const t of s.trains) {
    const pts: [number, number][] = [];
    for (const p of t.stops) {
      if (!onMain(p.st) || p.betr) continue;
      pts.push([X(p.arr), Y(sOf(p.st))], [X(p.dep), Y(sOf(p.st))]);
    }
    if (pts.length < 2) continue;
    add(t.id, pts);
    ctx.lineWidth = t.id === focus ? 2 : 1;
    ctx.strokeStyle = CAT[t.cat] + (focus !== null && t.id !== focus ? "40" : "77");
    ctx.setLineDash([4, 4]);
    stroke(pts);
  }
  ctx.setLineDash([]);
  // Ist (durchgezogen) und Prognose (dünn)
  for (const t of s.trains) {
    const dim = focus !== null && t.id !== focus;
    const tr = trails.get(t.id);
    if (tr && tr.length > 1) {
      const pl = tr.map((p) => [X(p.t), Y(p.s)] as [number, number]);
      add(t.id, pl);
      ctx.strokeStyle = CAT[t.cat] + (dim ? "66" : "");
      ctx.lineWidth = t.id === focus ? 4 : 2;
      stroke(pl);
      const last = pl[pl.length - 1];
      ctx.fillStyle = CAT[t.cat];
      ctx.font = `600 ${t.id === focus ? 12 : 10}px 'JetBrains Mono', monospace`;
      ctx.textAlign = "left";
      ctx.fillText(short(t.no), last[0] + 4, last[1] - 3);
    }
    if (t.live && isFinite(t.s)) {
      const nx = t.stops.filter((p) => !p.done && onMain(p.st));
      if (nx.length) {
        const pl: [number, number][] = [[X(s.time), Y(t.s)]];
        for (const p of nx) { pl.push([X(p.eta), Y(sOf(p.st))], [X(Math.max(p.dep, p.eta + 30)), Y(sOf(p.st))]); }
        add(t.id, pl);
        ctx.strokeStyle = CAT[t.cat] + (dim ? "44" : "aa");
        ctx.lineWidth = t.id === focus ? 2 : 1;
        stroke(pl);
      }
    }
  }
  // Jetzt-Linie
  ctx.strokeStyle = tc("#36c5f0");
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(X(s.time), T - 2); ctx.lineTo(X(s.time), H - B); ctx.stroke();
}

function hit(mx: number, my: number): number | null {
  let best: number | null = null, bd = 8;
  for (const [id, pls] of lines) {
    for (const pl of pls) {
      for (let i = 1; i < pl.length; i++) {
        const [ax, ay] = pl[i - 1], [bx, by] = pl[i];
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const u = l2 ? Math.max(0, Math.min(1, ((mx - ax) * dx + (my - ay) * dy) / l2)) : 0;
        const d = Math.hypot(mx - ax - u * dx, my - ay - u * dy);
        if (d < bd) { bd = d; best = id; }
      }
    }
  }
  return best;
}
cv.addEventListener("mousemove", (e) => {
  const r = cv.getBoundingClientRect();
  const id = hit(e.clientX - r.left, e.clientY - r.top);
  const tip = $("gtip");
  cv.style.cursor = id !== null ? "pointer" : "";
  if (id !== hoverId) { hoverId = id; if (snap) drawGraph(); }
  const t = id !== null ? snap?.trains.find((x) => x.id === id) : undefined;
  if (!t) return tip.classList.add("hidden");
  const d = Math.round(t.delay / 60);
  tip.innerHTML = `<b>${esc(t.no)}</b> ${esc(t.from)} → ${esc(t.to)}<br><span class="${cls(t.delay)}">${d >= 1 ? `+${d} min` : "pünktlich"}</span> · ${esc(t.live ? t.where ?? "" : t.status)}`;
  tip.style.left = `${e.clientX - r.left + 14}px`;
  tip.style.top = `${e.clientY - r.top + 40}px`;
  tip.classList.remove("hidden");
});
cv.addEventListener("mouseleave", () => { hoverId = null; $("gtip").classList.add("hidden"); if (snap) drawGraph(); });
cv.addEventListener("click", (e) => {
  const r = cv.getBoundingClientRect();
  const id = hit(e.clientX - r.left, e.clientY - r.top);
  if (id === null) return select(null);
  select(id, tab === "funk" ? undefined : "dispo");
});
cv.addEventListener("dblclick", (e) => {
  const r = cv.getBoundingClientRect();
  const id = hit(e.clientX - r.left, e.clientY - r.top);
  if (id !== null && id > 0) cmd("focus", { id });
});
window.addEventListener("resize", () => snap && drawGraph());

// ---------------- Große Zugansicht (alle Bereiche des Zugfensters auf einer Seite) ----------------
const bigEl = document.createElement("div");
bigEl.id = "big";
bigEl.className = "hidden";
bigEl.innerHTML = `<div class="bighead"><div id="bHead"></div><button data-a="focus">Im Stellwerk zeigen</button><button id="bClose">✕ Zurück zur Übersicht (Esc)</button></div>
  <div class="bgrid">
    <div class="bcol"><h4>Übersicht</h4><div id="bInfo"></div><h4>Verspätungsursachen</h4><div id="bVersp"></div></div>
    <div class="bcol"><h4>Fahrplan</h4><div id="bPlan"></div><h4>Disposition</h4><div id="bDispo"></div></div>
    <div class="bcol"><h4>Fahrgastinformation</h4><div id="bFis"></div><h4>Funk</h4><div id="bRadio" class="radio"></div><div id="bCmds"></div>
      <form id="bForm" class="rform"><input id="bIn" placeholder="Freier Funkspruch, z. B. „Warum stehen Sie?“" autocomplete="off"><button>Senden</button></form></div>
  </div>`;
document.body.append(bigEl);
function openBig(id: number) {
  bigId = id;
  selId = id;
  bigEl.classList.remove("hidden");
  cmd("watch", { id });
  render();
}
function closeBig() {
  bigId = null;
  bigEl.classList.add("hidden");
  cmd("watch", { id: null });
}
$("bClose").onclick = closeBig;
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && bigId !== null) closeBig(); });
$("bForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const i = $("bIn") as HTMLInputElement;
  if (!i.value.trim() || bigId === null) return;
  cmd("radio", { id: bigId, text: i.value.trim() });
  i.value = "";
});
function renderBig() {
  if (!big || big.id !== bigId) return;
  if (big.gone || !big.s) {
    setHtml($("bHead"), `<h2>Zug nicht mehr im Bereich</h2>`);
    setHtml($("bInfo"), `<p class="gone">Der Zug hat den Bereich verlassen oder seine Fahrt beendet.</p>`);
    for (const id of ["bPlan", "bVersp", "bFis", "bRadio", "bDispo", "bCmds"]) setHtml($(id), "");
    return;
  }
  const S = big.s;
  setHtml($("bHead"), S.head);
  setHtml($("bInfo"), S.info);
  setHtml($("bPlan"), S.plan);
  setHtml($("bVersp"), S.versp);
  // Fahrgastinfo nur teilweise tauschen, damit das Laufband nicht neu startet
  const fis = $("bFis");
  const box = fis.querySelector(".fisbox");
  if (!box) setHtml(fis, S.fis);
  else {
    const tmp = document.createElement("div");
    tmp.innerHTML = S.fis;
    for (const q of [".fistop", ".fisnext", ".fislist", ".fisticker"]) {
      const a = box.querySelector(q), b = tmp.querySelector(q);
      if (a && b && a.innerHTML !== b.innerHTML) a.replaceWith(b);
    }
  }
  const log = $("bRadio");
  if (cache.get(log) !== S.radio) { setHtml(log, S.radio); log.scrollTop = log.scrollHeight; }
  setHtml($("bCmds"), RADIO_CMDS.map((c) => `<button data-a="radio" data-cmd="${c.id}" data-text="${esc(c.label)}">${esc(c.label)}</button>`).join(""));
  const t = snap?.trains.find((x) => x.id === bigId);
  setHtml($("bDispo"), t ? dispoActs(t) || `<p class="empty">Keine dispositiven Maßnahmen möglich (kein Wendebahnhof oder Überholbahnhof vor dem Zug).</p>` : "");
}
document.addEventListener("dblclick", (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>("#boardTab tr[data-id]");
  if (r && Number(r.dataset.id) > 0) openBig(Number(r.dataset.id));
});
