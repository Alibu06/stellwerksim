// Rechtsklick-Menü im Gleisbild
export interface MenuItem { label: string; act?: () => void; sub?: MenuItem[]; disabled?: boolean; sep?: boolean; }

export class ContextMenu {
  el: HTMLElement;
  constructor() {
    this.el = document.createElement("div");
    this.el.id = "ctx";
    this.el.className = "hidden";
    document.body.appendChild(this.el);
    window.addEventListener("mousedown", (e) => { if (!this.el.contains(e.target as Node)) this.hide(); });
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") this.hide(); });
  }

  show(x: number, y: number, title: string, items: MenuItem[]) {
    const render = (list: MenuItem[], head: string) => {
      this.el.innerHTML = `<div class="ctxh">${head}</div>` + list.map((it, i) => it.sep ? `<hr>` :
        `<button data-i="${i}" ${it.disabled ? "disabled" : ""}>${it.label}${it.sub ? " ▸" : ""}</button>`).join("");
      this.el.querySelectorAll<HTMLButtonElement>("button[data-i]").forEach((b) => (b.onclick = () => {
        const it = list[Number(b.dataset.i)];
        if (it.sub) return render(it.sub, it.label);
        this.hide();
        it.act?.();
      }));
    };
    render(items, title);
    this.el.classList.remove("hidden");
    const r = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    this.el.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  }

  hide() { this.el.classList.add("hidden"); }
}
