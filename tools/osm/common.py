import os
nodes = {}; ways = {}
for f in files:
    for x in json.load(open(f))["elements"]:
        if x["type"] == "node":
            if x["id"] not in nodes or "tags" in x: nodes[x["id"]] = x
        else: ways[x["id"]] = x
def stn(nm):
    if "," in nm:
        la, lo = map(float, nm.split(",")); return {"lat": la, "lon": lo}
    return [n for n in nodes.values() if n.get("tags", {}).get("name") == nm and n["tags"].get("railway") in ("station", "halt")][0]
st = stn(name); lat0, lon0 = st["lat"], st["lon"]
K = 111320 * math.cos(math.radians(lat0))
def xy(n): return np.array([(n["lon"] - lon0) * K, (n["lat"] - lat0) * 110540])
rails = [w for w in ways.values() if w["tags"].get("railway") == "rail"]
adj = {}
for w in rails:
    pen = 4 if w["tags"].get("service") else 1
    ids = [i for i in w["nodes"] if i in nodes]
    for a, b in zip(ids, ids[1:]):
        d = pen * float(np.hypot(*(xy(nodes[a]) - xy(nodes[b]))))
        adj.setdefault(a, []).append((b, d)); adj.setdefault(b, []).append((a, d))
def nearest(n):
    p = xy(n); return min(adj, key=lambda i: np.hypot(*(xy(nodes[i]) - p)))
A, B = nearest(stn(wA)), nearest(stn(eA))
dist = {A: 0}; prev = {}; pq = [(0, A)]
while pq:
    d, u = heapq.heappop(pq)
    if u == B: break
    if d > dist[u]: continue
    for v, w in adj[u]:
        if d + w < dist.get(v, 1e18): dist[v] = d + w; prev[v] = u; heapq.heappush(pq, (d + w, v))
path = [B]
while path[-1] != A: path.append(prev[path[-1]])
path.reverse()
L = np.array([xy(nodes[i]) for i in path])
seg = L[1:] - L[:-1]; sl = np.hypot(seg[:, 0], seg[:, 1]); cum = np.concatenate([[0], np.cumsum(sl)])
def proj(p):
    t = np.clip(((p - L[:-1]) * seg).sum(1) / np.maximum(sl ** 2, 1e-9), 0, 1)
    q = L[:-1] + seg * t[:, None]; d = np.hypot(*(q - p).T); k = int(np.argmin(d))
    sgn = np.sign(seg[k, 0] * (p - q[k])[1] - seg[k, 1] * (p - q[k])[0])
    return np.array([cum[k] + t[k] * sl[k], sgn * d[k]])
import os
s0 = proj(np.zeros(2))[0] + float(os.environ.get('SHIFT', 0))
def pr(p):
    r = proj(p); return np.array([r[0] - s0, r[1] * ex])
