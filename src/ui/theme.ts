// Helles Design: dunkle Farben werden zur Laufzeit in passende helle umgerechnet (gleiche Regel wie tools/lightcss.py)

export const isLight = () => localStorage.getItem("theme") === "light";

function hexToRgb(h: string): [number, number, number, number] {
  let x = h.slice(1);
  if (x.length === 3 || x.length === 4) x = x.split("").map((c) => c + c).join("");
  const n = (i: number) => parseInt(x.slice(i, i + 2), 16) / 255;
  return [n(0), n(2), n(4), x.length === 8 ? n(6) : 1];
}
function rgbToHls(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, l, 0];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : mx === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return [h, l, s];
}
function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
export function lightify(hex: string): string {
  const [r, g, b, a] = hexToRgb(hex);
  let [h, l, s] = rgbToHls(r, g, b);
  if (s < 0.35 || l < 0.3) {
    // Grautöne und dunkle Flächen: Helligkeit umkehren
    l = 1 - l * 0.92;
    if (l > 0.6) s = Math.min(s, 0.35);
  } else if (l > 0.45) {
    // kräftige, helle Signalfarben für hellen Grund abdunkeln (Gelb stärker, sonst kaum lesbar)
    l = l * (h > 0.08 && h < 0.2 ? 0.62 : 0.78);
  }
  const [R, G, B] = hlsToRgb(h, Math.max(0, Math.min(1, l)), s);
  const c = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${c(R)}${c(G)}${c(B)}${a < 1 ? c(a) : ""}`;
}
const cache = new Map<string, string>();
export function tc(hex: string): string {
  if (!isLight()) return hex;
  let v = cache.get(hex);
  if (!v) cache.set(hex, (v = lightify(hex)));
  return v;
}
export function applyThemeClass() {
  document.documentElement.classList.toggle("light", isLight());
}
