import { Graph } from "../sim/graph";
import { radio, RADIO_CMDS } from "../sim/radio";
import { Train, World } from "../sim/world";

// Zugfenster: Übersicht, Fahrplan (Soll/Prognose/Ist), Fahrgastinformation, Funk, Verspätungsursachen

export const DELAY_REASONS = [
  "Verspätung aus dem Vorbereich",
  "Zugfolge / Vorrang anderer Züge",
  "Kreuzung auf eingleisiger Strecke",
  "Weichenstörung",
  "Signalstörung",
  "Störung am Fahrzeug",
  "Türstörung",
  "Erhöhtes Fahrgastaufkommen",
  "Anschluss abgewartet",
  "Langsamfahrstelle / Bauarbeiten",
  "Polizei- oder Feuerwehreinsatz",
  "Personen im Gleis",
  "Witterung",
  "Disposition des Fahrdienstleiters",
  "Personal (Tf verspätet)",
];

const hm = (t: number) => {
  const s = Math.floor(((t % 86400) + 86400) % 86400);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}`;
};
// Gleisanzeige: Regelgleis durchgestrichen, wenn ein anderes Gleis angeordnet oder benutzt wird
export function trackHtml(s: { plan?: string; disp?: string; track?: string }): string {
  const soll = s.disp ?? s.plan;
  if (s.track && soll && s.track !== soll) return `<s>${s.plan ?? soll}</s> <b class="chg">${s.track}</b>`;
  if (s.disp && s.plan && s.disp !== s.plan) return `<s>${s.plan}</s> <b class="chg">${s.disp}</b>`;
  return s.track ?? soll ?? "–";
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export class TrainWindow {
  el: HTMLElement;
  train: Train | null = null;
  tab = "info";
  private lastRadio = -1;
  private lastHtml = "";
  private lastTab = "";

  constructor(private w: World, private g: Graph, private catColor: Record<string, string>, private onClose: () => void, private toast: (s: string) => void) {
    this.el = document.getElementById("card")!;
  }

  show(t: Train) {
    if (this.train !== t) this.lastRadio = -1;
    this.train = t;
    this.el.classList.remove("hidden");
    this.render(true);
  }

  hide() {
    this.train = null;
    this.el.classList.add("hidden");
    this.onClose();
  }

  render(full = false) {
    const t = this.train;
    if (!t) return;
    if (t.gone) return this.hide();
    const w = this.w, g = this.g;
    // Eingabefeld beim Funk nicht neu aufbauen, solange der Spieler tippt
    const typing = document.activeElement && this.el.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName !== "BUTTON";
    if (typing && !full) {
      if (this.tab === "funk" && t.radio.length !== this.lastRadio) this.renderRadioLog();
      return;
    }
    const dm = Math.round(w.liveDelay(t) / 60);
    const pos = w.position(t);
    const head = `<button class="x" title="Schließen">×</button>
      <h2 style="color:${this.catColor[t.cat]}">${t.no}</h2>
      <div class="meta">${esc(t.trip.from)} → ${esc(t.trip.to)} · <span class="${dm >= 6 ? "bad" : dm >= 3 ? "warn" : "ok"}">${dm > 0 ? `+${dm} min` : "pünktlich"}</span></div>
      <div class="ttabs">${[["info", "Übersicht"], ["plan", "Fahrplan"], ["fis", "Fahrgastinfo"], ["funk", "Funk"], ["versp", "Verspätung"]]
        .map(([k, n]) => `<button data-t="${k}" class="${this.tab === k ? "on" : ""}">${n}</button>`).join("")}</div>`;
    let body = "";
    if (this.tab === "info") body = this.infoHtml(t);
    else if (this.tab === "plan") body = this.planHtml(t);
    else if (this.tab === "fis") body = this.fis(t);
    else if (this.tab === "funk") {
      body = `<div class="radio" id="radioLog"></div>
        <div class="rbtns">${RADIO_CMDS.map((c) => `<button data-r="${c.id}">${c.label}</button>`).join("")}</div>
        <form class="rform"><input id="radioIn" placeholder="Freier Funkspruch, z. B. „Warum stehen Sie?“" autocomplete="off"><button>Senden</button></form>`;
    } else if (this.tab === "versp") body = this.verspHtml(t);
    const html = head + `<div class="tbody">${body}</div>`;
    if (!full && html === this.lastHtml) return;
    // Fahrgastinfo: nur geänderte Teile tauschen, damit das Laufband nicht ständig neu startet
    const box = this.el.querySelector(".fisbox");
    if (!full && this.tab === "fis" && box && this.lastTab === "fis") {
      const tmp = document.createElement("div");
      tmp.innerHTML = body;
      for (const sel of [".fistop", ".fisnext", ".fislist", ".fisticker"]) {
        const a = box.querySelector(sel), b = tmp.querySelector(sel);
        if (a && b && a.innerHTML !== b.innerHTML) a.replaceWith(b);
      }
      this.lastHtml = html;
      return;
    }
    this.lastHtml = html;
    this.lastTab = this.tab;
    this.el.innerHTML = html;
    this.bind();
    if (this.tab === "funk") this.renderRadioLog();
  }

  infoHtml(t: Train): string {
    const w = this.w, g = this.g;
    const pos = w.position(t);
      const st = w.status(t);
      const nx = t.stops[t.stopIdx];
      const nxDelay = nx ? Math.round((w.eta(t, nx) - nx.arr) / 60) : 0;
      const depProg = nx ? Math.max(nx.dep, w.eta(t, nx) + (nx.dep - nx.arr)) : 0;
      const nextHtml = !nx || nx.done ? (t.trip.exitPortal ? `<div class="nexthalt">Kein Halt mehr im Bereich · weiter Richtung ${esc(g.portals[t.trip.exitPortal].label)}</div>` : "")
        : `<div class="nexthalt"><small>${t.dwelling ? "Hält in" : "Nächster Halt"}</small><b>${esc(g.stations[nx.st].name)}</b> <span class="gl">Gl. ${trackHtml(nx)}</span><br>
          an ${hm(nx.arr)}${t.dwelling ? ` (Ist ${hm(nx.actArr ?? nx.arr)})` : nxDelay > 0 ? ` <span class="${nxDelay >= 5 ? "bad" : "warn"}">(+${nxDelay})</span>` : ""} · ab ${hm(nx.dep)}${depProg - nx.dep >= 60 ? ` <span class="warn">(Prognose ${hm(depProg)})</span>` : ""}${t.stopIdx === t.stops.length - 1 && !t.trip.exitPortal ? " · Endhalt" : ""}</div>`;
      return `<div class="pos"><b>${pos.text[0].toUpperCase() + pos.text.slice(1)}</b><br>km ${pos.km.toFixed(2).replace(".", ",")} · ${pos.track} · Richtung ${t.dir > 0 ? "Betzdorf" : "Köln"}</div>
        ${nextHtml}
        <ul class="status">${st.map((x) => `<li class="${x.kind}">${esc(x.text)}</li>`).join("")}</ul>
        <table class="kv">
          <tr><td>Zuggattung</td><td>${t.cat === "G" ? "Güterzug" : t.cat === "S" ? "S-Bahn" : t.cat === "ICE" ? "ICE" : t.cat === "RE" ? "Regional-Express" : "Regionalbahn"} ${t.trip.line !== t.cat ? esc(t.trip.line) : ""}</td></tr>
          <tr><td>Zugbildung</td><td>${t.cat === "G" ? `Lok BR ${t.tfz} + ${Math.max(1, Math.round((t.len - 19) / 18))} Wagen, ${Math.round(t.len)} m${t.trip.mass ? `, ${t.trip.mass} t` : ""}` : `${Math.max(1, Math.round(t.len / ({ S: 68, RE: 75, RB: 42, ICE: 200 } as Record<string, number>)[t.cat]))} × BR ${t.tfz}, ${Math.round(t.len)} m`}</td></tr>
          <tr><td>Länge / Vmax</td><td>${Math.round(t.len)} m · ${Math.round(t.vmax * 3.6)} km/h${t.trip.mass ? ` · ${t.trip.mass} t` : ""}</td></tr>
          <tr><td>Tf</td><td>${esc(t.driver)}</td></tr>
          <tr><td>Nächstes Signal</td><td>${t.nextSig ? `${w.il.sig(t.nextSig).name} in ${Math.round(t.distNextSig)} m` : "–"}</td></tr>
          <tr><td>Weiter</td><td>${t.trip.exitPortal ? `Richtung ${g.portals[t.trip.exitPortal].label}` : t.trip.turnInto ? `wendet als ${t.trip.turnInto.no}` : "endet hier"}</td></tr>
        </table>
        <div class="tact"><button data-a="center">Im Gleisbild zeigen</button><button data-a="${t.hold ? "go" : "hold"}">${t.hold ? "Halt aufheben" : "Halt anordnen"}</button></div>`;
  }

  planHtml(t: Train): string {
    const w = this.w, g = this.g;
      const rows = t.stops.map((s, i) => {
        const prog = w.eta(t, s);
        const dArr = s.actArr !== undefined ? s.actArr - s.arr : prog - s.arr;
        const dDep = s.actDep !== undefined ? s.actDep - s.dep : Math.max(prog + (s.dep - s.arr), s.dep) - s.dep;
        const cls = (d: number) => (d >= 300 ? "bad" : d >= 60 ? "warn" : "ok");
        const ist = (x: number | undefined, d: number) => (x !== undefined ? `<span class="${cls(d)}">${hm(x)}</span>` : `<span class="${cls(d)} prog">${hm(s.arr + Math.max(0, d))}</span>`);
        return `<tr class="${s.done ? "done" : i === t.stopIdx ? "cur" : ""}"><td>${esc(g.stations[s.st].name)}${s.missed ? " ✕" : ""}</td>
          <td>${hm(s.arr)}</td><td>${ist(s.actArr, dArr)}</td><td>${hm(s.dep)}</td><td>${s.actDep !== undefined ? `<span class="${cls(dDep)}">${hm(s.actDep)}</span>` : `<span class="${cls(dDep)} prog">${hm(s.dep + Math.max(0, dDep))}</span>`}</td>
          <td>${!s.done && t.cat !== "G" && !(t.dwelling && i === t.stopIdx) && w.platformTracks(s.st).length > 1
            ? `<select class="trk" data-st="${s.st}">${w.platformTracks(s.st).map((p) => `<option value="${p.track}" ${(s.disp ?? s.plan) === p.track ? "selected" : ""}>${p.track}${p.track === s.plan ? " (Regel)" : ""}${p.len < t.len ? " (zu kurz)" : ""}</option>`).join("")}</select>${s.disp && s.disp !== s.plan ? ` <s>${s.plan ?? ""}</s>` : ""}`
            : trackHtml(s)}</td></tr>`;
      }).join("");
      return rows ? `<table class="plan"><tr><th>Halt</th><th>an Soll</th><th>an Ist/Prog</th><th>ab Soll</th><th>ab Ist/Prog</th><th>Gl.</th></tr>${rows}</table>
        <p class="hint">Kursiv = Prognose. Grün pünktlich, gelb ab 1 min, rot ab 5 min. Gleis ändern: Auswahl in der Spalte Gl. (Gleisänderung, Regelgleis wird durchgestrichen).</p>` : `<p class="hint">Güterzug ohne Verkehrshalt im Bereich.</p>`;
  }

  verspHtml(t: Train): string {
      const causes = Object.entries(t.causes).filter(([, s]) => s >= 20).sort((a, b) => b[1] - a[1]);
      return `<p class="hint">Automatisch erfasste Wartezeiten:</p>
        ${causes.length ? `<table class="kv">${causes.map(([c, s]) => `<tr><td>${esc(c)}</td><td>${Math.round(s / 60)} min</td></tr>`).join("")}</table>` : `<p class="hint">Noch nichts erfasst.</p>`}
        <p class="hint" style="margin-top:10px">Verspätungsursache eintragen (fließt in die Schichtauswertung ein):</p>
        <select id="reasonSel"><option value="">– bitte wählen –</option>${DELAY_REASONS.map((r) => `<option ${t.reason === r ? "selected" : ""}>${r}</option>`).join("")}</select>
        <input id="reasonNote" placeholder="Bemerkung (optional)" value="${esc(t.reasonNote ?? "")}">
        <div class="tact"><button data-a="reason">Speichern</button></div>`;
  }

  radioLogHtml(t: Train): string {
    return t.radio.length ? t.radio.map((m) => `<div class="${m.from}"><time>${hm(m.t)}</time><b>${m.from === "fdl" ? "Fdl" : "Tf"}</b> ${esc(m.text)}</div>`).join("")
      : `<p class="hint">Noch kein Funkverkehr mit ${t.no}. Knöpfe oder freien Text benutzen.</p>`;
  }

  // Große Zugansicht für den zweiten Monitor: alle Bereiche einzeln, damit nur Geändertes neu gezeichnet wird
  bigSections(t: Train): Record<string, string> {
    const dm = Math.round(this.w.liveDelay(t) / 60);
    return {
      head: `<h2 style="color:${this.catColor[t.cat]}">${t.no}</h2><div class="meta">${esc(t.trip.from)} → ${esc(t.trip.to)} · <span class="${dm >= 6 ? "bad" : dm >= 3 ? "warn" : "ok"}">${dm > 0 ? `+${dm} min` : "pünktlich"}</span> · Tf ${esc(t.driver)}</div>`,
      info: this.infoHtml(t).replace('data-a="center"', 'data-a="focus"').replace(/data-a="hold"/, 'data-a="radio" data-cmd="halt" data-text="Sofort anhalten"').replace(/data-a="go"/, 'data-a="radio" data-cmd="weiter" data-text="Weiterfahrt erlaubt"').replace("Im Gleisbild zeigen", "Im Stellwerk zeigen"),
      plan: this.planHtml(t).replace(/<select class="trk" data-st=/g, '<select class="trk" data-trk='),
      fis: this.fis(t),
      radio: this.radioLogHtml(t),
      versp: this.verspHtml(t).replace('id="reasonSel"', 'id="bigReason"').replace('id="reasonNote"', 'id="bigNote"').replace('data-a="reason"', 'data-a="reason"'),
    };
  }

  private renderRadioLog() {
    const t = this.train!;
    const el = this.el.querySelector<HTMLElement>("#radioLog");
    if (!el) return;
    this.lastRadio = t.radio.length;
    el.innerHTML = this.radioLogHtml(t);
    el.scrollTop = el.scrollHeight;
  }

  // Fahrgastinformation im Fahrzeug (eigene Gestaltung)
  private fis(t: Train): string {
    const w = this.w, g = this.g;
    if (t.cat === "G") return `<p class="hint">Güterzüge haben keine Fahrgastinformation.</p>`;
    const rest = t.stops.filter((s) => !s.done);
    const next = rest[0];
    const dm = Math.round(w.liveDelay(t) / 60);
    const reason = t.reason ?? Object.entries(t.causes).filter(([, s]) => s > 90).sort((a, b) => b[1] - a[1])[0]?.[0];
    const ticker = dm >= 3 ? `Wir haben derzeit eine Verspätung von ${dm} Minuten${reason ? `. Grund: ${reason.replace(/^Halt vor Signal.*/, "Verzögerungen im Betriebsablauf")}` : ""}. Wir bitten um Entschuldigung.`
      : t.dwelling ? "Bitte beachten Sie beim Aussteigen die Lücke zwischen Zug und Bahnsteig." : "Willkommen an Bord. Fahrscheine bitte bereithalten.";
    const isLast = !t.trip.exitPortal && rest.length <= 1;
    const nsoll = next ? next.track ?? next.disp ?? next.plan : undefined;
    const chg = next && nsoll && next.plan && nsoll !== next.plan ? nsoll : undefined;
    return `<div class="fisbox">
      <div class="fistop"><span class="fisline" style="background:${this.catColor[t.cat]}">${esc(t.trip.line)}</span><span class="fisdest">${esc(t.trip.to)}</span><span class="fisclock">${hm(w.time)}</span></div>
      ${next ? `<div class="fisnext"><small>${t.dwelling ? "Halt" : "Nächster Halt"}</small><div>${esc(g.stations[next.st].name)}</div><small>${hm(next.arr)}${dm > 0 ? ` <span class="fisdelay">+${dm}</span>` : ""}${next.plan ? ` · Gleis ${chg ? `<span class="fisdelay">${chg}</span> (Gleisänderung)` : next.plan}` : ""}${isLast ? " · Endstation, bitte alle aussteigen" : ""}</small></div>` : `<div class="fisnext"><small>Endstation</small><div>${esc(t.trip.to)}</div><small>Bitte alle aussteigen. Vielen Dank für Ihre Fahrt.</small></div>`}
      <div class="fislist">${rest.slice(1, 6).map((s) => `<div><span>${esc(g.stations[s.st].name)}</span><span>${hm(s.arr)}</span></div>`).join("")}${t.trip.exitPortal ? `<div class="dim"><span>${esc(t.trip.to)}</span><span></span></div>` : ""}</div>
      <div class="fisticker"><span>${esc(ticker)}</span></div>
    </div>`;
  }

  private bind() {
    const t = this.train!;
    this.el.querySelector<HTMLButtonElement>(".x")!.onclick = () => this.hide();
    this.el.querySelectorAll<HTMLButtonElement>(".ttabs button").forEach((b) => (b.onclick = () => { this.tab = b.dataset.t!; this.render(true); }));
    this.el.querySelectorAll<HTMLButtonElement>("[data-r]").forEach((b) => (b.onclick = () => {
      const c = RADIO_CMDS.find((x) => x.id === b.dataset.r)!;
      radio(this.w, t, c.label, c.id);
      this.renderRadioLog();
    }));
    const f = this.el.querySelector<HTMLFormElement>(".rform");
    if (f) f.onsubmit = (e) => {
      e.preventDefault();
      const i = this.el.querySelector<HTMLInputElement>("#radioIn")!;
      if (!i.value.trim()) return;
      radio(this.w, t, i.value.trim());
      i.value = "";
      this.renderRadioLog();
    };
    this.el.querySelectorAll<HTMLSelectElement>("select.trk").forEach((sel) => (sel.onchange = () => {
      const why = this.w.setTrack(t.trip.key, sel.dataset.st!, sel.value);
      this.toast(why ?? `Gleisänderung für ${t.no} angeordnet`);
      sel.blur();
      this.render(true);
    }));
    this.el.querySelectorAll<HTMLButtonElement>("[data-a]").forEach((b) => (b.onclick = () => {
      const a = b.dataset.a;
      if (a === "center") this.onCenter?.(t);
      if (a === "hold") { radio(this.w, t, "Sofort anhalten", "halt"); this.render(true); }
      if (a === "go") { radio(this.w, t, "Weiterfahrt erlaubt", "weiter"); this.render(true); }
      if (a === "reason") {
        t.reason = (this.el.querySelector<HTMLSelectElement>("#reasonSel")!.value) || undefined;
        t.reasonNote = this.el.querySelector<HTMLInputElement>("#reasonNote")!.value || undefined;
        this.toast(t.reason ? `Ursache für ${t.no} gespeichert` : "Ursache entfernt");
      }
    }));
  }

  onCenter?: (t: Train) => void;
}
