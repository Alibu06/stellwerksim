import { CHANNEL, Snapshot, SnapTrain } from "./sim/snapshot";

// Zweiter Monitor: Abfahrts-/Ankunftstafel, Bildfahrplan, Zugmeldungen, Meldungen

const CAT: Record<string, string> = { S: "#2fd27a", RE: "#ff4d57", RB: "#4d8dff", ICE: "#f2f6fa", G: "#d38a2e" };
const $ = (id: string) => document.getElementById(id)!;
const hm = (t: number) => {
  const s = Math.floor(((t % 86400) + 86400) % 86400);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}`;
};
const hms = (t: number) => `${hm(t)}:${String(Math.floor(((t % 60) + 60) % 60)).padStart(2, "0")}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const cls = (d: number) => (d >= 300 ? "bad" : d >= 60 ? "warn" : "ok");

const ch = new BroadcastChannel(CHANNEL);
let snap: Snapshot | null = null;
let lastMsg = 0;
let mode: "dep" | "arr" = "dep";
let range = 120;
const trails = new Map<number, { t: number; s: number }[]>(); // Ist-Verlauf je Zug

ch.onmessage = (e) => {
  if (e.data?.type !== "snap") return;
  snap = e.data.snap as Snapshot;
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
setInterval(() => {
  const on = performance.now() - lastMsg < 3000;
  $("conn").className = on ? "" : "off";
  $("conn").textContent = on ? "verbunden" : "keine Verbindung zum Stellwerk – Spiel im anderen Fenster starten";
}, 1000);

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

function render() {
  if (!snap) return;
  $("clock").textContent = hms(snap.time);
  const sc = snap.score;
  $("stats").innerHTML = `<span><b>${sc.points}</b>Punkte</span><span><b>${sc.trainsDone ? Math.round((100 * sc.punctual) / sc.trainsDone) : "–"}</b>% pünktlich</span><span><b>${Math.round(sc.waitMinutes)}</b>Min. vor Halt</span>`;
  if (!sel.options.length) {
    sel.innerHTML = snap.stations.filter((s) => s.code !== "NH").sort((a, b) => a.s - b.s).map((s) => `<option value="${s.code}">${esc(s.name)}</option>`).join("");
    sel.value = localStorage.getItem("monitor-station") ?? "TR";
  }
  renderBoard();
  renderSide();
  drawGraph();
}

function renderBoard() {
  const code = sel.value;
  const rows: { t: SnapTrain; plan: number; prog: number; ist?: number; via: string; track?: string; done: boolean }[] = [];
  for (const t of snap!.trains) {
    const i = t.stops.findIndex((s) => s.st === code);
    if (i < 0) continue;
    const s = t.stops[i];
    const isFirst = i === 0, isLast = i === t.stops.length - 1;
    const plan = mode === "dep" ? s.dep : s.arr;
    const ist = mode === "dep" ? s.actDep : s.actArr;
    const prog = mode === "dep" ? Math.max(s.dep, s.eta + (s.dep - s.arr)) : s.eta;
    const via = (mode === "dep" ? t.stops.slice(i + 1, i + 4) : t.stops.slice(Math.max(0, i - 3), i)).map((x) => snap!.stations.find((y) => y.code === x.st)?.name ?? x.st).join(" – ");
    if (mode === "dep" && isLast && !t.to) continue;
    if (mode === "arr" && isFirst && !t.from) continue;
    rows.push({ t, plan, prog, ist, via, track: s.track, done: s.done });
  }
  rows.sort((a, b) => a.plan - b.plan);
  const now = snap!.time;
  const list = rows.filter((r) => (r.ist ?? r.prog) >= now - 120).slice(0, 18);
  $("boardTab").innerHTML = `<tr><th>Zeit</th><th>Prognose</th><th>Zug</th><th>${mode === "dep" ? "Nach" : "Von"}</th><th>Gl.</th></tr>` +
    (list.length ? list.map((r) => {
      const d = (r.ist ?? r.prog) - r.plan;
      const shown = r.ist !== undefined ? `<span class="${cls(d)}">${hm(r.ist)}</span><small>${mode === "dep" ? "abgefahren" : "angekommen"}</small>`
        : `<span class="${cls(d)}">${d >= 60 ? hm(r.prog) : "pünktlich"}</span>${d >= 60 ? `<small class="${cls(d)}">+${Math.round(d / 60)} min${r.t.reason ? ` · ${esc(r.t.reason)}` : ""}</small>` : ""}`;
      return `<tr class="${r.done ? "gone" : ""}"><td class="t">${hm(r.plan)}</td><td class="p">${shown}</td>
        <td><span class="cat" style="background:${CAT[r.t.cat]}">${esc(r.t.line)}</span><span class="no">${esc(r.t.no.replace(/^\S+ /, ""))}</span></td>
        <td><span class="dest">${esc(mode === "dep" ? r.t.to : r.t.from)}</span><small>${esc(r.via)}</small><small>${esc(r.t.status)}</small></td><td class="t">${r.track ?? ""}</td></tr>`;
    }).join("") : `<tr><td colspan="5" class="empty">Keine Züge in der nächsten Zeit.</td></tr>`);
}

function renderSide() {
  const s = snap!;
  const open = s.reports.filter((r) => r.kind === "in" && r.state === "offered");
  const other = s.reports.filter((r) => !(r.kind === "in" && r.state === "offered")).slice(-8).reverse();
  $("reports").innerHTML = (open.map((r) => `<div class="rep"><div><b>${esc(r.no)}</b> von Fdl ${esc(r.where)}<br><small>${esc(r.from)} → ${esc(r.to)} · ca. ${hm(r.at)}</small></div><button data-acc="${r.id}">Annehmen</button></div>`).join("") +
    other.map((r) => `<div class="rep ${r.kind === "out" ? "out" : "acc"}"><div><b>${esc(r.no)}</b> ${r.kind === "in" ? `von ${esc(r.where)}` : `an ${esc(r.where)}`}<br><small>${r.state === "accepted" ? "angenommen" : r.state === "refused" ? `abgelehnt: ${esc(r.note ?? "")}` : "angeboten, warte auf Antwort"}</small></div></div>`).join("")) || `<p class="empty">Keine Zugmeldungen.</p>`;
  $("reports").querySelectorAll<HTMLButtonElement>("[data-acc]").forEach((b) => (b.onclick = () => ch.postMessage({ type: "accept", id: Number(b.dataset.acc) })));
  $("faults").innerHTML = s.faults.length ? s.faults.map((f) => `<div class="fault">${esc(f.text)}<br><small>noch ca. ${f.left} min</small></div>`).join("") : `<p class="empty">Keine Störungen.</p>`;
  $("events").innerHTML = s.events.slice().reverse().map((e) => `<div class="ev ${e.kind}"><time>${hm(e.t)}</time>${esc(e.text)}</div>`).join("");
}

// ---------------- Bildfahrplan ----------------
const cv = $("cv") as HTMLCanvasElement;
function drawGraph() {
  const s = snap!;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const ctx = cv.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0b1016";
  ctx.fillRect(0, 0, W, H);
  const st = s.stations.filter((x) => x.main).sort((a, b) => a.s - b.s);
  const s0 = st[0].s - 500, s1 = st[st.length - 1].s + 500;
  const L = 150, R = 16, T = 26, B = 16;
  const t0 = s.time - range * 60 * 0.35, t1 = s.time + range * 60 * 0.65;
  const X = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const Y = (m: number) => T + ((m - s0) / (s1 - s0)) * (H - T - B);
  // Raster
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.textAlign = "right";
  for (const x of st) {
    const y = Y(x.s);
    ctx.strokeStyle = "#18212c";
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
    ctx.fillStyle = "#9fb0c3";
    ctx.fillText(x.name.replace(" (Sieg)", ""), L - 8, y + 4);
  }
  ctx.textAlign = "center";
  const step = range <= 60 ? 600 : range <= 120 ? 900 : 1800;
  for (let t = Math.ceil(t0 / step) * step; t < t1; t += step) {
    const x = X(t);
    ctx.strokeStyle = "#151d27";
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, H - B); ctx.stroke();
    ctx.fillStyle = "#7b8ca0";
    ctx.fillText(hm(t), x, T - 8);
  }
  const sOf = (code: string) => s.stations.find((x) => x.code === code)?.s ?? NaN;
  const onMain = (code: string) => s.stations.find((x) => x.code === code)?.main;
  // Plan (gestrichelt)
  ctx.lineWidth = 1;
  for (const t of s.trains) {
    const pts: [number, number][] = [];
    for (const p of t.stops) {
      if (!onMain(p.st)) continue;
      pts.push([p.arr, sOf(p.st)], [p.dep, sOf(p.st)]);
    }
    if (pts.length < 2) continue;
    ctx.strokeStyle = CAT[t.cat] + "77";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    pts.forEach(([tt, m], i) => (i ? ctx.lineTo(X(tt), Y(m)) : ctx.moveTo(X(tt), Y(m))));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // Ist (durchgezogen) und Prognose (dünn)
  for (const t of s.trains) {
    const tr = trails.get(t.id);
    if (tr && tr.length > 1) {
      ctx.strokeStyle = CAT[t.cat];
      ctx.lineWidth = 2;
      ctx.beginPath();
      tr.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.s)) : ctx.moveTo(X(p.t), Y(p.s))));
      ctx.stroke();
      const last = tr[tr.length - 1];
      ctx.fillStyle = CAT[t.cat];
      ctx.font = "600 10px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";
      ctx.fillText(t.no.replace(/^\S+ /, ""), X(last.t) + 4, Y(last.s) - 3);
    }
    if (t.live && isFinite(t.s)) {
      const nx = t.stops.filter((p) => !p.done && onMain(p.st));
      if (nx.length) {
        ctx.strokeStyle = CAT[t.cat] + "aa";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(X(s.time), Y(t.s));
        for (const p of nx) { ctx.lineTo(X(p.eta), Y(sOf(p.st))); ctx.lineTo(X(Math.max(p.dep, p.eta + 30)), Y(sOf(p.st))); }
        ctx.stroke();
      }
    }
  }
  // Jetzt-Linie
  ctx.strokeStyle = "#36c5f0";
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(X(s.time), T - 2); ctx.lineTo(X(s.time), H - B); ctx.stroke();
}
window.addEventListener("resize", () => snap && drawGraph());
