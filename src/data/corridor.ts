import { Builder } from "../sim/builder";
import { Graph } from "../sim/graph";

// Schematisches Gleisbild Porz-Wahn – Troisdorf – Siegburg/Bonn – Au (Sieg) – Betzdorf (Sieg)
// Eigenes Spurplan-Layout. Reihenfolge der Betriebsstellen und Abstände orientieren sich an der realen Strecke,
// Gleisanlagen sind vorerst vereinfacht und werden mit OpenStreetMap-Daten verfeinert.
//
// Zeilen (y): SFS 0/1 (Siegburg zusätzlich -1/2) · S-Bahn/Siegstrecke 4/5 (+3,6,7 in Bahnhöfen)
//             Rechte Rheinstrecke 7/8 (+9) · Abzweig Bonn-Beuel 12/13
// Gleis mit kleinerem y = Regelgleis Richtung West, größeres y = Richtung Ost.

export function buildCorridor(): Graph {
  const b = new Builder();

  // ---------- S-Bahn Köln – Troisdorf und Siegstrecke bis Betzdorf (y 4 / 5) ----------
  const L: Record<number, number> = {
    0: 2000, 3: 400, 6: 210, 9: 1900, 14: 1900, 19: 210, 22: 1100, 27: 500,
    38: 300, 56: 1800, 70: 1800, 84: 600, 96: 300, 112: 1800, 118: 1800,
    128: 300, 134: 400, 138: 300, 140: 600, 142: 210, 145: 900, 148: 900, 154: 210, 157: 1300, 162: 1100,
    168: 210, 171: 1500, 174: 1500, 182: 300, 188: 300, 191: 1700, 194: 1700, 198: 210, 201: 1600, 204: 1500,
    208: 210, 211: 1400, 213: 1400, 216: 210, 219: 1100, 221: 1000, 224: 210, 227: 1400, 238: 300,
    254: 700, 258: 700, 262: 210, 265: 1700, 268: 1700, 274: 300, 284: 2200, 287: 2200, 290: 2200,
    292: 210, 295: 1100, 304: 300, 320: 2000,
  };
  const xs = [
    0, 3, 6, 9, 14, 19, 22, 27, 32, 34, 36, 38, 44, 50, 52, 54, 56, 70, 84, 92, 94, 96, 102, 104, 106, 108, 112,
    118, 121, 122, 124, 126, 128, 132, 134, 138, 140, 142, 145, 148, 150, 152, 154, 157, 162, 165, 168, 171, 174,
    177, 180, 182, 186, 188, 191, 194, 198, 201, 204, 208, 211, 213, 216, 219, 221, 224, 227, 228, 230, 232, 236,
    238, 244, 246, 248, 250, 252, 254, 258, 262, 265, 268, 271, 272, 274, 280, 282, 284, 287, 290, 292, 295,
    296, 298, 300, 302, 304, 310, 312, 314, 316, 320, 324,
  ];
  b.double(xs, 4, 5, xs.slice(0, -1).map((x) => L[x]));

  // ---------- Rechte Rheinstrecke / Güterverkehr Gremberg – Troisdorf (y 7 / 8) ----------
  b.double([0, 3, 10, 20, 32, 34, 38, 44, 46, 48, 56], 7, 8, [2000, 2500, 2500, 2400, 80, 120, 300, 80, 80, 300]);
  // Abzweig Richtung Bonn-Beuel über Friedrich-Wilhelms-Hütte und Menden
  b.track([[56, 7], [62, 12, 1200]], { v: 80 });
  b.track([[56, 8], [62, 13, 1200]], { v: 80 });
  b.double([62, 66, 69, 74, 78, 81, 86, 90], 12, 13, [500, 210, 1400, 1400, 210, 2500, 2000], 100);

  // ---------- Schnellfahrstrecke Köln – Rhein/Main (y 0 / 1) ----------
  b.double([0, 3, 25, 50, 75, 90, 94, 96, 102, 104, 110, 116], 0, 1, [2000, 4000, 3500, 3500, 2500, 300, 80, 410, 80, 300, 2000], 250);
  // Bahnsteiggleise Siegburg/Bonn an der SFS
  b.track([[94, 1], [96, 2], [102, 2, 410], [104, 1]], { v: 80 });
  b.track([[94, 0], [96, -1], [102, -1, 410], [104, 0]], { v: 80 });

  // ================= Troisdorf (TR) =================
  b.xover(34, 4, 36, 5); // Kehrgleiswechsel S-Bahn
  b.track([[34, 8], [36, 9], [46, 9, 750], [48, 8]], { v: 60 }); // Gl. 5 Überholgleis
  b.xover(44, 8, 46, 7); // Gl. 4 -> Gegengleis
  b.xover(48, 7, 50, 5); // Rheinstrecke -> Siegstrecke
  b.xover(52, 5, 54, 4); // Gleiswechsel Siegstrecke
  b.plat(38, 44, 4, "TR", "1");
  b.plat(38, 44, 5, "TR", "2");
  b.plat(38, 44, 7, "TR", "3");
  b.plat(38, 44, 8, "TR", "4");
  b.station("TR", "Troisdorf", 41, 2.6);
  b.sig(32, 5, 1, "TR A"); b.sig(32, 8, 1, "TR B");
  b.sig(56, 4, -1, "TR F"); b.sig(56, 7, -1, "TR G");
  for (const [y, t] of [[4, 1], [5, 2], [7, 3], [8, 4]]) {
    b.sig(44, y, 1, `TR N${t}`);
    b.sig(38, y, -1, `TR P${t}`);
  }
  b.sig(46, 9, 1, "TR N5");

  // Halte Porz-Wahn und Spich
  b.plat(6, 9, 4, "PW", "1"); b.plat(6, 9, 5, "PW", "2");
  b.station("PW", "Porz-Wahn", 7.5, 2.6);
  b.plat(19, 22, 4, "SP", "1"); b.plat(19, 22, 5, "SP", "2");
  b.station("SP", "Spich", 20.5, 2.6);
  // Blocksignale
  b.blocks([3, 14, 27], 4, 5, "Sbk S");
  b.blocks([3, 10, 20], 7, 8, "Sbk G");
  b.blocks([3, 25, 50, 75], 0, 1, "Sbk H");
  b.blocks([70, 84], 4, 5, "Sbk T");

  // Abzweig Bonn-Beuel
  b.plat(66, 69, 12, "FH", "1"); b.plat(66, 69, 13, "FH", "2");
  b.station("FH", "Friedrich-Wilhelms-Hütte", 67.5, 14.6);
  b.plat(78, 81, 12, "SM", "1"); b.plat(78, 81, 13, "SM", "2");
  b.station("SM", "St. Augustin-Menden", 79.5, 14.6);
  b.blocks([74, 86], 12, 13, "Sbk B");

  // ================= Siegburg/Bonn (SB) =================
  b.track([[94, 5], [96, 6], [102, 6, 300], [104, 5]], { v: 60 }); // Gl. 3
  b.xover(106, 5, 108, 4);
  b.plat(96, 102, 4, "SB", "1"); b.plat(96, 102, 5, "SB", "2"); b.plat(96, 102, 6, "SB", "3");
  b.plat(96, 102, 2, "SB", "4"); b.plat(96, 102, -1, "SB", "5");
  b.station("SB", "Siegburg/Bonn", 99, -2.6);
  b.sig(92, 5, 1, "SB A"); b.sig(112, 4, -1, "SB F");
  b.sig(90, 1, 1, "SB C"); b.sig(110, 0, -1, "SB H");
  for (const [y, t] of [[4, 1], [5, 2], [6, 3]]) b.sig(96, y, -1, `SB P${t}`);
  for (const [y, t] of [[5, 2], [6, 3]]) b.sig(102, y, 1, `SB N${t}`);
  b.sig(102, 2, 1, "SB N4"); b.sig(102, 1, 1, "SB N41");
  b.sig(96, -1, -1, "SB P5"); b.sig(96, 0, -1, "SB P51");
  b.blocks([118], 4, 5, "Sbk K");

  // ================= Hennef (Sieg) (HN) =================
  b.xover(122, 4, 124, 5);
  b.track([[126, 5], [128, 6], [132, 6, 300], [134, 5]], { v: 60 }); // Gl. 3
  b.plat(128, 132, 4, "HN", "1"); b.plat(128, 132, 5, "HN", "2"); b.plat(128, 132, 6, "HN", "3");
  b.station("HN", "Hennef (Sieg)", 130, 2.6);
  b.sig(121, 5, 1, "HN A"); b.sig(138, 4, -1, "HN F");
  for (const [y, t] of [[4, 1], [5, 2], [6, 3]]) b.sig(128, y, -1, `HN P${t}`);
  for (const [y, t] of [[5, 2], [6, 3]]) b.sig(132, y, 1, `HN N${t}`);

  b.plat(142, 145, 4, "HS", "1"); b.plat(142, 145, 5, "HS", "2");
  b.station("HS", "Hennef Im Siegbogen", 143.5, 2.6);
  b.blocks([140], 4, 5, "Sbk L");

  // ================= Blankenberg (Sieg) (BL) – Kehranlage =================
  b.xover(150, 4, 152, 5);
  b.plat(154, 157, 4, "BL", "1"); b.plat(154, 157, 5, "BL", "2");
  b.station("BL", "Blankenberg (Sieg)", 155.5, 2.6);
  b.sig(148, 5, 1, "BL A"); b.sig(162, 4, -1, "BL F");
  b.sig(154, 4, -1, "BL P1"); b.sig(154, 5, -1, "BL P2");
  b.sig(157, 5, 1, "BL N2");

  b.plat(168, 171, 4, "ME", "1"); b.plat(168, 171, 5, "ME", "2");
  b.station("ME", "Merten (Sieg)", 169.5, 2.6);
  b.blocks([165, 174], 4, 5, "Sbk M");

  // ================= Eitorf (EI) =================
  b.track([[180, 5], [182, 6], [186, 6, 300], [188, 5]], { v: 60 });
  b.plat(182, 186, 4, "EI", "1"); b.plat(182, 186, 5, "EI", "2"); b.plat(182, 186, 6, "EI", "3");
  b.station("EI", "Eitorf", 184, 2.6);
  b.sig(177, 5, 1, "EI A"); b.sig(191, 4, -1, "EI F");
  b.sig(182, 4, -1, "EI P1");
  b.sig(186, 5, 1, "EI N2"); b.sig(186, 6, 1, "EI N3");
  b.blocks([194, 204, 213, 221], 4, 5, "Sbk E");

  for (const [x, c, n] of [[198, "HE", "Herchen"], [208, "DA", "Dattenfeld (Sieg)"], [216, "SL", "Schladern (Sieg)"], [224, "RO", "Rosbach (Sieg)"]] as const) {
    b.plat(x, x + 3, 4, c, "1"); b.plat(x, x + 3, 5, c, "2");
    b.station(c, n, x + 1.5, 2.6);
  }

  // ================= Au (Sieg) (AU) =================
  b.xover(227, 4, 228, 5); // Kehrgleiswechsel
  b.xover(230, 5, 232, 4);
  b.track([[236, 4], [238, 3], [244, 3, 300], [246, 4]], { v: 60 }); // Gl. 4 (Kehrgleis S-Bahn)
  b.track([[236, 5], [238, 6], [244, 6, 300], [246, 5]], { v: 60 }); // Gl. 3
  // Westerwaldstrecke (eingleisig) über Gl. 5
  b.track([[228, 10], [232, 10, 2500], [234, 7, 300], [238, 7], [244, 7, 250], [246, 6], [248, 5]], { v: 60 });
  b.xover(250, 5, 252, 4);
  for (const [y, t] of [[3, 4], [4, 1], [5, 2], [6, 3], [7, 5]]) {
    b.plat(238, 244, y, "AU", String(t));
    b.sig(238, y, -1, `AU P${t}`);
    b.sig(244, y, 1, `AU N${t}`);
  }
  b.station("AU", "Au (Sieg)", 241, 1.6);
  b.sig(228, 5, 1, "AU A"); b.sig(254, 4, -1, "AU F"); b.sig(232, 10, 1, "AU W");
  b.blocks([258, 268], 4, 5, "Sbk U");

  b.plat(262, 265, 4, "EZ", "1"); b.plat(262, 265, 5, "EZ", "2");
  b.station("EZ", "Etzbach", 263.5, 2.6);

  // ================= Wissen (Sieg) (WI) =================
  b.track([[272, 5], [274, 6], [280, 6, 300], [282, 5]], { v: 60 });
  b.plat(274, 280, 4, "WI", "1"); b.plat(274, 280, 5, "WI", "2"); b.plat(274, 280, 6, "WI", "3");
  b.station("WI", "Wissen (Sieg)", 277, 2.6);
  b.sig(271, 5, 1, "WI A"); b.sig(284, 4, -1, "WI F");
  b.sig(274, 4, -1, "WI P1");
  b.sig(280, 5, 1, "WI N2"); b.sig(280, 6, 1, "WI N3");
  b.blocks([287, 290], 4, 5, "Sbk W");

  b.plat(292, 295, 4, "SF", "1"); b.plat(292, 295, 5, "SF", "2");
  b.station("SF", "Scheuerfeld (Sieg)", 293.5, 2.6);

  // ================= Betzdorf (Sieg) (BZ) =================
  b.xover(298, 4, 300, 5);
  b.track([[302, 4], [304, 3], [310, 3, 300], [312, 4]], { v: 60 });
  b.track([[302, 5], [304, 6], [310, 6, 300], [312, 5]], { v: 60 });
  b.xover(314, 4, 316, 5);
  for (const [y, t] of [[3, 1], [4, 2], [5, 3], [6, 4]]) {
    b.plat(304, 310, y, "BZ", String(t));
    b.sig(304, y, -1, `BZ P${t}`);
    b.sig(310, y, 1, `BZ N${t}`);
  }
  b.station("BZ", "Betzdorf (Sieg)", 307, 1.6);
  b.sig(296, 5, 1, "BZ A"); b.sig(320, 4, -1, "BZ F");

  // ---------- Streckenenden ----------
  b.portal("W_S", 0, 5, 4, 1, "Köln (S-Bahn)");
  b.portal("W_M", 0, 8, 7, 1, "Köln-Gremberg");
  b.portal("W_SFS", 0, 1, 0, 1, "Köln (SFS)");
  b.portal("E_SFS", 116, 0, 1, -1, "Frankfurt (SFS)");
  b.portal("S_BB", 90, 12, 13, -1, "Bonn-Beuel");
  b.portal("WW", 228, 10, 10, 1, "Altenkirchen");
  b.portal("E_BZ", 324, 4, 5, -1, "Siegen");

  // Abstände der Betriebsstellen nach Luftlinie der GTFS-Koordinaten × 1,1 (Gleisverlauf)
  const D: [string, string, number][] = [
    ["PW", "SP", 4282], ["SP", "TR", 2899], ["TR", "SB", 4282], ["SB", "HN", 6175], ["HN", "HS", 2020],
    ["HS", "BL", 2533], ["BL", "ME", 2625], ["ME", "EI", 4355], ["EI", "HE", 5217], ["HE", "DA", 4541],
    ["DA", "SL", 3245], ["SL", "RO", 1621], ["RO", "AU", 4215], ["AU", "EZ", 2410], ["EZ", "WI", 3604],
    ["WI", "SF", 6886], ["SF", "BZ", 2370],
  ];
  for (const [f, t, m] of D) b.calibrate(f, t, m * 1.1, [[4, 3], [5, 6]]);
  b.calibrate("TR", "FH", 1442 * 1.15, [[7, 12], [8, 13]]);
  b.calibrate("FH", "SM", 2542 * 1.1, [[12], [13]]);

  // Stellen, an denen die Darstellung in eine neue Zeile umbrechen darf (zwischen den Betriebsstellen)
  b.g.breakpoints = [11.5, 24.5, 91, 115, 136, 146.5, 159.5, 175.5, 192.5, 206, 214.5, 222.5, 256, 269.5, 288.5];

  b.label(14, 10.6, "Rechte Rheinstrecke");
  b.label(30, -1.6, "SFS Köln – Rhein/Main");
  b.label(200, 7.2, "Siegstrecke");
  b.label(229, 11.6, "Westerwald");

  return b.finish();
}
