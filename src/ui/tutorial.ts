// Geführtes Tutorial: Schritt für Schritt durch die Bedienung, wartet jeweils auf die passende Handlung.

export interface TutStep {
  title: string;
  text: string;
  target?: string; // CSS-Selektor, der hervorgehoben wird
  mark?: () => { x: number; y: number } | null; // Punkt im Gleisbild (Weltkoordinaten)
  done?: () => boolean; // Schritt ist erledigt, sobald true
  enter?: () => void;
}

export class Tutorial {
  private i = 0;
  private el: HTMLDivElement;
  private hl: HTMLDivElement;
  private timer = 0;
  active = false;

  constructor(private steps: TutStep[], private setMark: (p: { x: number; y: number } | null) => void) {
    this.el = document.createElement("div");
    this.el.id = "tut";
    this.hl = document.createElement("div");
    this.hl.id = "tutHl";
    document.body.append(this.hl, this.el);
    this.el.classList.add("hidden");
    this.hl.classList.add("hidden");
  }

  start() {
    this.active = true;
    this.i = 0;
    this.show();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), 300);
  }

  stop() {
    this.active = false;
    clearInterval(this.timer);
    this.el.classList.add("hidden");
    this.hl.classList.add("hidden");
    this.setMark(null);
  }

  private show() {
    const s = this.steps[this.i];
    if (!s) return this.stop();
    s.enter?.();
    this.el.classList.remove("hidden");
    this.el.innerHTML = `<div class="tstep">Schritt ${this.i + 1} von ${this.steps.length}</div><h3>${s.title}</h3><p>${s.text}</p>
      <div class="tbtn">${s.done ? `<span class="twait">Warte auf deine Aktion …</span><button data-t="next" class="ghost">Überspringen</button>` : `<button data-t="next">${this.i === this.steps.length - 1 ? "Fertig" : "Weiter"}</button>`}<button data-t="stop" class="ghost">Tutorial beenden</button></div>`;
    this.el.querySelector<HTMLButtonElement>('[data-t="next"]')!.onclick = () => this.next();
    this.el.querySelector<HTMLButtonElement>('[data-t="stop"]')!.onclick = () => this.stop();
    this.tick();
  }

  private next() {
    this.i++;
    if (this.i >= this.steps.length) this.stop();
    else this.show();
  }

  private tick() {
    const s = this.steps[this.i];
    if (!s || !this.active) return;
    if (s.target) {
      const t = document.querySelector(s.target);
      if (t) {
        const r = t.getBoundingClientRect();
        Object.assign(this.hl.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
        this.hl.classList.remove("hidden");
      } else this.hl.classList.add("hidden");
    } else this.hl.classList.add("hidden");
    this.setMark(s.mark ? s.mark() : null);
    if (s.done && s.done()) {
      this.el.classList.add("ok");
      setTimeout(() => this.el.classList.remove("ok"), 600);
      this.next();
    }
  }
}
