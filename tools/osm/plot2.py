import json, math, sys, heapq
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
# Aufruf: plot2.py dateien Station WestAnker OstAnker R ex LAT [out]
files = sys.argv[1].split(","); name, wA, eA = sys.argv[2:5]
R = float(sys.argv[5]); ex = float(sys.argv[6]); LAT = float(sys.argv[7])
out = sys.argv[8] if len(sys.argv) > 8 else f"/home/user/osmtool/{name.split()[0].replace('/','_')}.png"
exec(open('/home/user/osmtool/common.py').read())
fig, a = plt.subplots(figsize=(float(os.environ.get('W',24)), float(os.environ.get('H',9))))
for w in rails:
    pts = [xy(nodes[i]) for i in w["nodes"] if i in nodes]
    if not any(abs(np.hypot(*p)) < R * 1.6 + abs(float(os.environ.get('SHIFT', 0))) for p in pts): continue
    q = np.array([pr(p) for p in pts])
    keep = (np.abs(q[:, 0]) < R * 1.05) & (np.abs(q[:, 1]) < LAT * ex)
    if keep.sum() < 2: continue
    q = np.where(keep[:, None], q, np.nan)
    t = w["tags"]; srv = t.get("service")
    col = {"siding": "tab:orange", "yard": "tab:green", "crossover": "tab:purple", "spur": "tab:brown"}.get(srv, "k")
    a.plot(q[:, 0], q[:, 1], color=col, lw=1)
    ok = np.where(keep)[0]; m = q[ok[len(ok) // 2]]
    lab = []
    if t.get("railway:track_ref"): lab.append("Gl " + t["railway:track_ref"])
    if t.get("maxspeed") and not srv: lab.append(t["maxspeed"])
    if t.get("ref") and not srv: lab.append("[" + t["ref"] + "]")
    if lab: a.text(m[0], m[1] + 2, " ".join(lab), fontsize=7, color="blue")
    for i in w["nodes"]:
        n = nodes.get(i); tg = n.get("tags", {}) if n else {}; rw = tg.get("railway")
        if rw not in ("switch", "signal", "buffer_stop", "level_crossing"): continue
        p = pr(xy(n))
        if abs(p[0]) > R or abs(p[1]) > LAT * ex: continue
        if rw == "switch":
            a.plot(*p, "o", color="red", ms=4); a.text(p[0], p[1] + 3, tg.get("ref", "?"), fontsize=6, color="red")
        elif rw == "buffer_stop": a.plot(*p, "s", color="black", ms=4)
        elif rw == "level_crossing": a.plot(*p, "x", color="magenta", ms=6)
        else:
            ids = w["nodes"]; k = ids.index(i)
            k2 = min(k + 1, len(ids) - 1); k1 = max(k - 1, 0)
            d = pr(xy(nodes[ids[k2]]))[0] - pr(xy(nodes[ids[k1]]))[0]
            east = (d > 0) == (tg.get("railway:signal:direction") == "forward")
            kind = "H" if ("railway:signal:main" in tg or "railway:signal:combined" in tg) else ("V" if "railway:signal:distant" in tg else ("S" if "railway:signal:minor" in tg else None))
            if not kind: continue
            col = {"H": "green", "V": "orange", "S": "blue"}[kind]
            a.plot(*p, ">" if east else "<", color=col, ms=6 if kind == "H" else 4)
            a.text(p[0], p[1] + (-10 if east else 5), tg.get("ref", ""), fontsize=7, color=col)
a.set_xlim(-R, R); a.set_ylim(-LAT * ex, LAT * ex); a.grid(alpha=0.25)
a.set_title(f"{name}: Abstand entlang Strecke {wA} -> {eA} (m), Querachse x{ex}")
plt.tight_layout(); plt.savefig(out, dpi=int(os.environ.get('DPI',75))); print(out)
