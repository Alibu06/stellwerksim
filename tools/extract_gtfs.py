"""Extrahiert alle Personenzüge im Korridor Porz-Wahn - Troisdorf - Siegburg - Au - Betzdorf
aus gtfs.de-Feeds (rv_free, fv_free) für einen Stichtag und schreibt public/data/timetable.json.
Aufruf: python3 tools/extract_gtfs.py <gtfs-dir> [<gtfs-dir>...] --date 20261117
"""
import csv, json, sys, datetime, os

# Parent-Stationen (gtfs.de-IDs) -> unsere Betriebsstellen-Kürzel
STATIONS = {
    "624616": ("PW", "Porz-Wahn"),
    "511763": ("SP", "Spich"),
    "81750": ("TR", "Troisdorf"),
    "69554": ("FH", "Friedrich-Wilhelms-Hütte"),
    "244311": ("SM", "St. Augustin-Menden"),
    "371700": ("BB", "Bonn-Beuel"),
    "127210": ("SB", "Siegburg/Bonn"),
    "319386": ("HN", "Hennef (Sieg)"),
    "470736": ("HS", "Hennef Im Siegbogen"),
    "123120": ("BL", "Blankenberg (Sieg)"),
    "293569": ("ME", "Merten (Sieg)"),
    "51034": ("EI", "Eitorf"),
    "581784": ("HE", "Herchen"),
    "69740": ("DA", "Dattenfeld (Sieg)"),
    "70691": ("SL", "Schladern (Sieg)"),
    "315590": ("RO", "Rosbach (Sieg)"),
    "278651": ("AU", "Au (Sieg)"),
    "566476": ("EZ", "Etzbach"),
    "400335": ("WI", "Wissen (Sieg)"),
    "265157": ("SF", "Scheuerfeld (Sieg)"),
    "382362": ("BZ", "Betzdorf (Sieg)"),
}

def t2s(t):
    h, m, s = map(int, t.split(":"))
    return h * 3600 + m * 60 + s

def main():
    args = sys.argv[1:]
    date = args[args.index("--date") + 1]
    dirs = [a for a in args if not a.startswith("--") and a != date]
    d = datetime.date(int(date[:4]), int(date[4:6]), int(date[6:]))
    wd = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"][d.weekday()]
    trains = []
    for gd in dirs:
        rd = lambda f: csv.DictReader(open(os.path.join(gd, f), encoding="utf-8-sig"))
        stopmap, names = {}, {}
        for r in rd("stops.txt"):
            names[r["stop_id"]] = r["stop_name"]
            pid = r["parent_station"] or r["stop_id"]
            if pid in STATIONS:
                stopmap[r["stop_id"]] = STATIONS[pid]
        active = set()
        for r in rd("calendar.txt"):
            if r["start_date"] <= date <= r["end_date"] and r[wd] == "1":
                active.add(r["service_id"])
        for r in rd("calendar_dates.txt"):
            if r["date"] == date:
                (active.add if r["exception_type"] == "1" else active.discard)(r["service_id"])
        routes = {r["route_id"]: r for r in rd("routes.txt")}
        trips = {r["trip_id"]: r for r in rd("trips.txt") if r["service_id"] in active}
        st = {}
        for r in rd("stop_times.txt"):
            if r["trip_id"] in trips:
                st.setdefault(r["trip_id"], []).append(r)
        for tid, rows in st.items():
            rows.sort(key=lambda r: int(r["stop_sequence"]))
            idx = [i for i, r in enumerate(rows) if r["stop_id"] in stopmap]
            if len(idx) < 1:
                continue
            route = routes[trips[tid]["route_id"]]
            stops = []
            for i in idx:
                r = rows[i]
                code, name = stopmap[r["stop_id"]]
                stops.append({"st": code, "arr": t2s(r["arrival_time"]), "dep": t2s(r["departure_time"])})
            trains.append({
                "line": route["route_short_name"],
                "from": names[rows[0]["stop_id"]],
                "to": names[rows[-1]["stop_id"]],
                "prev": names[rows[idx[0] - 1]["stop_id"]] if idx[0] > 0 else None,
                "next": names[rows[idx[-1] + 1]["stop_id"]] if idx[-1] + 1 < len(rows) else None,
                "stops": stops,
            })
    trains.sort(key=lambda t: t["stops"][0]["dep"])
    out = {"date": date, "source": "gtfs.de (DELFI e.V.), CC BY 4.0",
           "stations": {c: n for c, n in STATIONS.values()}, "trains": trains}
    p = os.path.join(os.path.dirname(__file__), "..", "public", "data", "timetable.json")
    json.dump(out, open(p, "w"), ensure_ascii=False, separators=(",", ":"))
    from collections import Counter
    print(len(trains), "Züge"); print(Counter(t["line"] for t in trains).most_common())

main()
