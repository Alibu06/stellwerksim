import json, math, sys, heapq, os
import numpy as np
files = sys.argv[1].split(","); name, wA, eA = sys.argv[2:5]; ex=1
exec(open('/home/user/osmtool/common.py').read())
# Densify rail ways, project points
pts = []
for w in rails:
    if w["tags"].get("service"): continue
    ids = [i for i in w["nodes"] if i in nodes]
    P = [xy(nodes[i]) for i in ids]
    for a, b in zip(P, P[1:]):
        n = max(1, int(np.hypot(*(b - a)) / 20))
        for k in range(n):
            p = a + (b - a) * k / n
            if np.hypot(*p) > cum[-1] + 2000: continue
            pts.append((pr(p), w["tags"].get("ref", "")))
bins = {}
for (s, l), ref in pts:
    if abs(l) < 30: bins.setdefault(int(s // 100), []).append(l)
prevc = None
out = []
for b in sorted(bins):
    ls = sorted(bins[b]); c = 1
    for x, y in zip(ls, ls[1:]):
        if y - x > 2.5: c += 1
    if c != prevc: out.append((b * 100, c)); prevc = c
print("Gleiszahl ab km:", " ".join(f"{s}:{c}" for s, c in out))
# stations, switches, main signals
ev = []
for n in nodes.values():
    t = n.get("tags", {}); rw = t.get("railway")
    if rw in ("station", "halt", "switch", "signal"):
        p = pr(xy(n))
        if abs(p[1]) > 40 or p[0] < -500 or p[0] > cum[-1] - s0 + 500: continue
        if rw == "signal":
            if not ("railway:signal:main" in t or "railway:signal:combined" in t): continue
            ev.append((p[0], f"S {t.get('ref','?')} {t.get('railway:signal:direction','')[:3]} lat{p[1]:.0f}"))
        elif rw == "switch": ev.append((p[0], f"W {t.get('ref','?')} lat{p[1]:.0f}"))
        else: ev.append((p[0], f"=== {t.get('name')} ==="))
for s, e in sorted(ev): print(f"{s:7.0f} {e}")
