# Stellwerk Sieg

Browser-Stellwerkssimulation für den Korridor Porz-Wahn – Troisdorf – Siegburg/Bonn – Au (Sieg) – Betzdorf (Sieg).
Eigenes Design im Stil eines modernen elektronischen Stellwerks.

## Spielen

Online: https://alibu06.github.io/stellwerksim/

## Lokal starten

```
npm install
npm run dev
```

## Aufbau

- `src/data/corridor.ts` – schematisches Gleisbild (Knoten, Gleisabschnitte, Weichen, Signale, Bahnsteige)
- `src/sim/interlocking.ts` – Fahrstraßen, Weichenverschluss, Durchrutschwege, Teilauflösung, Signalbegriffe
- `src/sim/world.ts` – Zugfahrt mit Bremskurven, Halte, Wenden, Zuglenkung, Bewertung
- `src/sim/timetable.ts` – Fahrplan aus GTFS, Zugnummern, generierter Güterverkehr
- `src/render/view.ts` – Gleisbilddarstellung (Canvas)
- `tools/extract_gtfs.py` – erzeugt `public/data/timetable.json` aus gtfs.de-Feeds
- `tools/headless.ts` – Testlauf ohne Grafik (`npx tsx tools/headless.ts 4 20`)

## Daten

Personenverkehr: gtfs.de (DELFI e.V.), CC BY 4.0. Gleisdaten: © OpenStreetMap-Mitwirkende, ODbL. Güterzüge sind generiert, Zugnummern erzeugt.
