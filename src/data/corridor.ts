import { Layout } from "../sim/layout";
import { Graph } from "../sim/graph";

// Gleisbild Porz-Wahn – Troisdorf – Siegburg/Bonn – Au (Sieg) – Betzdorf (Sieg)
//
// Eigene schematische Darstellung. Lage der Bahnhöfe, Zahl und Nummern der Gleise, Weichenverbindungen,
// Signalstandorte und eingleisige Abschnitte folgen den OpenStreetMap-Daten (© OpenStreetMap-Mitwirkende, ODbL).
// Alle Angaben in Metern entlang der Strecke (s = 0 in Porz-Wahn), Spuren (y) von oben nach unten:
//   0/1   Schnellfahrstrecke Köln – Rhein/Main (bis Siegburg/Bonn)
//   4/5   S-Bahn-Strecke Köln – Troisdorf und Siegstrecke bis Betzdorf (4 = Regelgleis Richtung West)
//   7/8   Troisdorf Gl. 5/6 mit Flughafenstrecke
//   10/11 Rechte Rheinstrecke (Troisdorf Gl. 7/8) und weiter über Friedrich-Wilhelms-Hütte Richtung Bonn-Beuel
//   4.5   eingleisige Abschnitte

export function buildCorridor(): Graph {
  const L = new Layout();

  // ---------------- Darstellung: Bahnhofsbereiche breiter ----------------
  for (const [a, b] of [
    [-900, 1000], [4100, 8000], [9000, 10100], [10100, 13600], [17050, 18800], [19900, 20150],
    [21650, 23150], [25250, 25900], [29450, 31150], [36100, 37450], [42150, 42350], [44550, 47000],
    [47150, 47450], [50550, 52900], [54380, 54600], [57450, 59150], [61500, 63100], [66700, 66900], [67800, 70900],
  ]) L.zone(a, b);

  // ================= Hauptstrecken =================
  L.double(0, 1, -1600, 13300, 250); // SFS
  L.double(4, 5, -1600, 22880, 120); // S-Bahn / Siegstrecke bis Blankenberg
  L.double(10, 11, -1600, 15500, 120); // Rechte Rheinstrecke / Richtung Bonn-Beuel
  L.speed(4, 9000, 22880, 140); L.speed(5, 9000, 22880, 140);
  L.speed(4, -1600, 4000, 160); L.speed(5, -1600, 4000, 160);

  // ---------------- Porz-Wahn (PW) ----------------
  L.plat(-100, 100, 4, "PW", "1"); L.plat(-100, 100, 5, "PW", "2");
  L.sig(-100, 4, -1, "PW P1"); L.sig(-100, 5, -1, "PW P2");
  L.sig(100, 4, 1, "PW N1"); L.sig(100, 5, 1, "PW N2");
  L.sig(-700, 5, 1, "PW A");
  // Flughafenstrecke mündet westlich von Porz-Wahn
  L.lane(2, -1600, -900, { v: 100, pref: -1 }); L.lane(3, -1600, -760, { v: 100, pref: 1 });
  L.conn(-900, 2, -820, 4); L.conn(-760, 3, -680, 4); L.xo(-620, 4, 5, 80);
  L.sig(-1000, 3, 1, "PW AF"); L.sig(-1000, 2, -1, "PW AFF", "block");
  L.portal("W_FL", -1600, 3, 2, 1, "Flughafen");
  L.xo(440, 4, 5, 110); L.xo(566, 5, 4, 97);
  L.sig(905, 4, -1, "PW F");
  L.station("PW", "Porz-Wahn", 0, 2.6);
  for (const s of [1360, 2516, 3536]) L.blk(s, 4, 5, `Sbk ${Math.round(s / 100)}`);

  // ---------------- Spich (SP) ----------------
  L.plat(4180, 4330, 4, "SP", "1"); L.plat(4180, 4330, 5, "SP", "2");
  L.station("SP", "Spich", 4255, 2.6);
  L.blk(4765, 4, 5, "Sbk 47");

  // ---------------- Troisdorf (TR) ----------------
  // Gl. 1/2 S-Bahn (y 4/5), Gl. 5/6 (y 7/8) mit Flughafenstrecke, Gl. 7/8 Rheinstrecke (y 10/11),
  // Gl. 9/10 Güterzuggleise (y 12/13), Abstellgleise 27/28 bei Spich (y 13/14)
  L.sig(5535, 5, 1, "TR 80A"); L.sig(5535, 4, -1, "TR 80AA");
  L.xo(5700, 5, 4); L.xo(5800, 4, 5, 100);
  L.conn(6000, 5, 6150, 7);
  L.lane(7, 6150, 7500, { v: 80, pref: -1 }); L.lane(8, 6330, 7500, { v: 80, pref: 1 });
  L.xo(6450, 7, 8); L.xo(6600, 8, 7);
  // Rheinstrecke ↔ Gl. 5/6
  L.xo(6050, 11, 10); L.conn(6200, 10, 6330, 8);
  // Abstellgleise 27/28
  L.sig(4500, 11, 1, "TR 81B"); L.sig(4500, 10, -1, "TR 81BB");
  L.xo(4800, 10, 11, 80);
  L.conn(4900, 11, 5000, 13); L.conn(5000, 13, 5100, 14);
  L.lane(13, 5000, 6600, { v: 40 }); L.lane(14, 5100, 6500, { v: 40 });
  L.conn(6500, 14, 6600, 13); L.conn(6600, 13, 6650, 11, 40);
  L.sig(5150, 13, -1, "TR P27"); L.sig(5150, 14, -1, "TR P28");
  L.sig(6450, 13, 1, "TR N27"); L.sig(6450, 14, 1, "TR N28");
  // Gl. 9/10
  L.conn(6700, 11, 6800, 12); L.conn(6800, 12, 6900, 13);
  L.lane(12, 6800, 7550, { v: 60 }); L.lane(13, 6900, 7450, { v: 60 });
  L.conn(7450, 13, 7550, 12); L.conn(7550, 12, 7650, 11);
  L.sig(6950, 12, -1, "TR P9"); L.sig(6950, 13, -1, "TR P10");
  L.sig(7400, 12, 1, "TR N9"); L.sig(7400, 13, 1, "TR N10");
  L.xo(7700, 11, 10, 100);
  // Bahnsteige
  for (const [y, t] of [[4, "1"], [5, "2"], [7, "5"], [8, "6"], [10, "7"], [11, "8"]] as const) {
    L.plat(6900, 7250, y, "TR", t);
    L.sig(6900, y, -1, `TR P${t}`);
    L.sig(7250, y, 1, `TR N${t}`);
  }
  L.station("TR", "Troisdorf", 7075, 2.6);
  // Ostkopf: Gl. 5/6 an die Strecke nach Siegburg
  L.conn(7400, 8, 7470, 7); L.conn(7500, 7, 7650, 5);
  L.xo(7300, 4, 5); L.xo(7520, 4, 5, 80);
  L.sig(8350, 5, 1, "TR 80 07", "block"); L.sig(7926, 4, -1, "TR 80F");

  // ---------------- Rheinstrecke West ----------------
  for (const s of [1000, 3000]) L.blk(s, 10, 11, `Sbk G${Math.round(s / 100)}`);

  // ---------------- Friedrich-Wilhelms-Hütte (FH) ----------------
  L.sig(9100, 11, 1, "FH 82ZS44");
  L.xo(9200, 11, 10);
  L.conn(9350, 11, 9420, 12, 40);
  L.lane(12, 9420, 9800, { v: 40 });
  L.conn(9800, 12, 9880, 11, 40);
  L.plat(9450, 9650, 10, "FH", "1"); L.plat(9450, 9650, 11, "FH", "2");
  L.sig(9450, 10, -1, "FH 82P1"); L.sig(9450, 11, -1, "FH 82P2");
  L.sig(9650, 10, 1, "FH 82N44"); L.sig(9650, 11, 1, "FH 82N43");
  L.station("FH", "Friedrich-Wilhelms-Hütte", 9550, 12.9);
  L.sig(9950, 10, -1, "FH 82F");
  L.blk(10430, 10, 11, "Sbk 104");

  // ---------------- St. Augustin-Menden (SM) ----------------
  L.sig(11386, 11, 1, "SM 83A"); L.sig(11386, 10, -1, "SM 83AA");
  L.xo(11677, 11, 10, 85);
  L.plat(12100, 12400, 10, "SM", "1"); L.plat(12100, 12400, 11, "SM", "2");
  L.sig(12100, 10, -1, "SM 83P1"); L.sig(12100, 11, -1, "SM 83P2");
  L.sig(12495, 10, 1, "SM 83N1"); L.sig(12495, 11, 1, "SM 83N2");
  L.xo(13195, 10, 11, 88);
  L.sig(13470, 10, -1, "SM F36"); L.sig(13470, 11, 1, "SM F35", "block");
  L.station("SM", "St. Augustin-Menden", 12250, 12.9);
  L.blk(14710, 10, 11, "Sbk 147");
  L.portal("S_BB", 15500, 10, 11, -1, "Bonn-Beuel");

  // ---------------- SFS ----------------
  for (const s of [1500, 4500, 7500]) L.blk(s, 0, 1, `Sbk H${Math.round(s / 100)}`);
  L.portal("W_SFS", -1600, 1, 0, 1, "Köln (SFS)");
  L.portal("E_SFS", 13300, 0, 1, -1, "Frankfurt (SFS)");

  // ---------------- Siegburg/Bonn (SB) ----------------
  // Gl. 4/5 SFS (y 0/1), Gl. 6 Überholgleis (y 2), Gl. 3 (y 3), Gl. 1/2 Siegstrecke (y 4/5)
  L.sig(10300, 5, 1, "SB 90A"); L.sig(10300, 4, -1, "SB 90AA");
  L.sig(10770, 1, 1, "SB 91B"); L.sig(10770, 0, -1, "SB 91BB");
  L.xo(10420, 4, 5, 90);
  L.xo(11100, 0, 1, 150);
  L.xo(11200, 5, 4, 90);
  L.conn(11380, 1, 11483, 2); L.conn(11894, 2, 12000, 1);
  L.conn(11380, 4, 11483, 3); L.conn(11894, 3, 12000, 4);
  L.lane(2, 11483, 11894, { v: 60 }); L.lane(3, 11483, 11894, { v: 60 });
  for (const [y, t, p] of [[0, "4", true], [1, "5", true], [2, "6", false], [3, "3", true], [4, "1", true], [5, "2", true]] as const) {
    if (p) L.plat(11483, 11894, y, "SB", t);
    L.sig(11483, y, -1, `SB P${t}`);
    L.sig(11894, y, 1, `SB N${t}`);
  }
  L.xo(12240, 0, 1, 140);
  L.xo(12060, 4, 5, 90);
  L.sig(12470, 4, -1, "SB 90F"); L.sig(12470, 5, 1, "SB 90FF", "block");
  L.sig(12700, 0, -1, "SB 91G"); L.sig(12700, 1, 1, "SB 91GG", "block");
  L.station("SB", "Siegburg/Bonn", 11679, -1.6);

  // Siegburg – Hennef
  L.blk(14450, 4, 5, "Sbk 144"); L.blk(15160, 4, 5, "Sbk 151");

  // ---------------- Hennef (Sieg) (HN) ----------------
  L.sig(17123, 5, 1, "HN A201"); L.sig(17123, 4, -1, "HN A202");
  L.xo(17410, 4, 5, 90);
  L.conn(17560, 5, 17650, 6);
  L.lane(6, 17650, 18240, { v: 60 });
  for (const [y, t] of [[4, "1"], [5, "2"], [6, "3"]] as const) {
    L.plat(17740, 18160, y, "HN", t);
    L.sig(17740, y, -1, `HN P20${t}`);
    L.sig(18160, y, 1, `HN N20${t}`);
  }
  L.lane(7, 17850, 18170, { v: 25 }); L.conn(18170, 7, 18210, 6, 25); // Gl. 4 Stumpfgleis
  L.conn(18240, 6, 18336, 5); L.xo(18405, 5, 4, 87);
  L.sig(18920, 4, -1, "HN F"); L.sig(18920, 5, 1, "Sbk 189", "block");
  L.station("HN", "Hennef (Sieg)", 17950, 2.6);

  // ---------------- Hennef Im Siegbogen (HS) ----------------
  L.plat(19950, 20090, 4, "HS", "1"); L.plat(19950, 20090, 5, "HS", "2");
  L.station("HS", "Hennef Im Siegbogen", 20021, 2.6);

  // ---------------- Blankenberg (Sieg) (BL) ----------------
  L.sig(21713, 5, 1, "BL A101"); L.sig(21713, 4, -1, "BL A102");
  L.xo(21956, 5, 4, 93); L.xo(22062, 4, 5, 93);
  L.plat(22400, 22640, 4, "BL", "1"); L.plat(22400, 22640, 5, "BL", "2");
  L.sig(22400, 4, -1, "BL P1"); L.sig(22400, 5, -1, "BL P2");
  L.sig(22765, 4, 1, "BL R102"); L.sig(22765, 5, 1, "BL R101");
  L.station("BL", "Blankenberg (Sieg)", 22517, 2.6);
  // eingleisig Blankenberg – Merten
  L.conn(22880, 4, 22960, 4.5); L.conn(22880, 5, 22960, 4.5);
  L.lane(4.5, 22960, 25350, { v: 100 });
  L.sig(23060, 4.5, -1, "BL F");
  L.sig(25250, 4.5, 1, "ME N200");
  L.conn(25350, 4.5, 25430, 4); L.conn(25350, 4.5, 25430, 5);
  L.label(24100, 3.6, "eingleisig");

  return finishEast(L);
}

function finishEast(L: Layout): Graph {
  // Merten (Sieg) – Schladern zweigleisig
  L.double(4, 5, 25430, 45650, 120);
  L.speed(4, 25430, 45650, 100); L.speed(5, 25430, 45650, 100);
  L.sig(25550, 4, -1, "ME A");
  L.plat(25700, 25850, 4, "ME", "1"); L.plat(25700, 25850, 5, "ME", "2");
  L.station("ME", "Merten (Sieg)", 25753, 2.6);
  L.blk(26020, 4, 5, "Sbk 260"); L.blk(26854, 4, 5, "Sbk 268"); L.blk(28902, 4, 5, "Sbk 289");

  // ---------------- Eitorf (EI) ----------------
  L.sig(29500, 5, 1, "EI A"); L.sig(29500, 4, -1, "EI AA", "block");
  L.xo(29612, 5, 4, 87);
  L.plat(30150, 30420, 4, "EI", "1"); L.plat(30150, 30420, 5, "EI", "2");
  L.sig(30150, 4, -1, "EI P1"); L.sig(30150, 5, -1, "EI P2");
  L.sig(30420, 4, 1, "EI N1"); L.sig(30420, 5, 1, "EI N2");
  L.xo(30548, 4, 5, 82);
  L.sig(31110, 4, -1, "EI F"); L.sig(31110, 5, 1, "Sbk 311", "block");
  L.station("EI", "Eitorf", 30285, 2.6);
  L.blk(34785, 4, 5, "Sbk 347");

  // ---------------- Herchen (HE) ----------------
  L.sig(36176, 5, 1, "HE A1"); L.sig(36176, 4, -1, "HE A2", "block");
  L.xo(36380, 4, 5, 100);
  L.plat(36880, 37080, 4, "HE", "1"); L.plat(36880, 37080, 5, "HE", "2");
  L.sig(36880, 4, -1, "HE P1"); L.sig(36880, 5, -1, "HE P2");
  L.sig(37217, 4, 1, "HE N1"); L.sig(37217, 5, 1, "HE N2");
  L.xo(37310, 5, 4, 90);
  L.sig(38137, 4, -1, "HE F"); L.sig(38137, 5, 1, "Sbk 381", "block");
  L.station("HE", "Herchen", 36979, 2.6);
  L.blk(40726, 4, 5, "Sbk 407");

  // ---------------- Dattenfeld (Sieg) (DA) ----------------
  L.plat(42180, 42330, 4, "DA", "1"); L.plat(42180, 42330, 5, "DA", "2");
  L.station("DA", "Dattenfeld (Sieg)", 42256, 2.6);

  // ---------------- Schladern (Sieg) (SL) ----------------
  L.sig(44586, 5, 1, "SL A102"); L.sig(44586, 4, -1, "SL A101", "block");
  L.xo(44893, 4, 5, 87);
  L.plat(45330, 45580, 4, "SL", "1"); L.plat(45330, 45580, 5, "SL", "2");
  L.sig(45330, 4, -1, "SL P101"); L.sig(45330, 5, -1, "SL P102");
  L.sig(45580, 4, 1, "SL N101"); L.sig(45580, 5, 1, "SL N102");
  L.station("SL", "Schladern (Sieg)", 45455, 2.6);
  // eingleisig über die Siegbrücke
  L.conn(45650, 4, 45730, 4.5); L.conn(45650, 5, 45730, 4.5);
  L.lane(4.5, 45730, 46830, { v: 80 });
  L.sig(46156, 4.5, -1, "SL F101");
  L.sig(46713, 4.5, 1, "RO A200");
  L.conn(46830, 4.5, 46910, 4); L.conn(46830, 4.5, 46910, 5);
  L.label(46280, 3.6, "eingleisig");

  // Rosbach – Betzdorf zweigleisig
  L.double(4, 5, 46910, 70800, 100);
  L.sig(47156, 4, -1, "RO F201"); L.sig(47156, 5, 1, "Sbk 471", "block");
  L.plat(47230, 47380, 4, "RO", "1"); L.plat(47230, 47380, 5, "RO", "2");
  L.station("RO", "Rosbach (Sieg)", 47307, 2.6);
  L.blk(48520, 4, 5, "Sbk 485"); L.blk(49336, 4, 5, "Sbk 493");

  // ---------------- Au (Sieg) (AU) ----------------
  // Gl. 2 (y 4), Gl. 1 (y 5), Gl. 11 Westerwaldstrecke (y 6), Gl. 31 (y 3)
  L.sig(51212, 5, 1, "AU A1"); L.sig(51212, 4, -1, "AU A2", "block");
  L.lane(7, 50600, 51300, { v: 50 });
  L.portal("WW", 50600, 7, 7, 1, "Altenkirchen (Westerwald)");
  L.sig(51250, 7, 1, "AU A11");
  L.conn(51300, 7, 51387, 6, 40);
  L.lane(6, 51387, 52200, { v: 40 });
  L.xo(51420, 4, 5, 80);
  L.conn(51480, 6, 51570, 5, 40);
  L.xo(51600, 5, 4, 80);
  L.conn(51700, 4, 51790, 3, 40);
  L.lane(3, 51790, 52300, { v: 40 });
  L.conn(52300, 3, 52380, 4, 40);
  for (const [y, t] of [[4, "2"], [5, "1"], [6, "11"]] as const) {
    L.plat(51760, 52130, y, "AU", t);
    L.sig(51760, y, -1, `AU P${t}`);
    L.sig(52130, y, 1, `AU N${t}`); // Gl. 11: Gleisende-Signal am Stumpfgleis
  }
  L.sig(51850, 3, -1, "AU P31"); L.sig(52150, 3, 1, "AU N31");
  L.xo(52420, 4, 5, 80); L.xo(52520, 5, 4, 80);
  L.sig(52849, 4, -1, "AU F2"); L.sig(52849, 5, 1, "AU F1", "block");
  L.station("AU", "Au (Sieg)", 51943, 1.6);
  L.label(50700, 8.2, "Westerwaldstrecke");

  // ---------------- Etzbach (EZ) ----------------
  L.plat(54410, 54560, 4, "EZ", "1"); L.plat(54410, 54560, 5, "EZ", "2");
  L.station("EZ", "Etzbach", 54487, 2.6);
  L.blk(55083, 4, 5, "Sbk 550");

  // ---------------- Wissen (Sieg) (WI) ----------------
  // Gl. 602 (y 4), Gl. 601 (y 5), Überholgleise 603/604 (y 3/2)
  L.sig(57492, 5, 1, "WI A647"); L.sig(57492, 4, -1, "WI A648", "block");
  L.xo(57735, 5, 4, 85);
  L.conn(57865, 4, 57940, 3, 40);
  L.lane(3, 57940, 58700, { v: 40 });
  L.conn(57980, 3, 58050, 2, 40);
  L.lane(2, 58050, 58600, { v: 40 });
  L.conn(58600, 2, 58660, 3, 40);
  L.conn(58700, 3, 58780, 4, 40);
  L.plat(57990, 58600, 4, "WI", "602"); L.plat(57990, 58600, 5, "WI", "601");
  L.sig(57990, 4, -1, "WI P602"); L.sig(57990, 5, -1, "WI P601");
  L.sig(58600, 4, 1, "WI N602"); L.sig(58600, 5, 1, "WI N601");
  L.sig(58070, 3, -1, "WI P603"); L.sig(58560, 3, 1, "WI N603");
  L.sig(58100, 2, -1, "WI P604"); L.sig(58560, 2, 1, "WI N604");
  L.xo(58812, 4, 5, 70);
  L.sig(59124, 4, -1, "WI F650"); L.sig(59124, 5, 1, "WI F649", "block");
  L.station("WI", "Wissen (Sieg)", 58300, 0.6);

  // ---------------- Niederhövels (NH), Kreuzungsbahnhof ohne Halt ----------------
  L.sig(61553, 5, 1, "NH A549"); L.sig(61553, 4, -1, "NH X550", "block");
  L.xo(61817, 4, 5, 54);
  L.conn(62007, 5, 62080, 6, 40);
  L.lane(6, 62080, 62700, { v: 40 });
  L.conn(62700, 6, 62760, 5, 40);
  for (const [y, t] of [[4, "502"], [5, "501"], [6, "503"]] as const) {
    L.sig(62150, y, -1, `NH P${t}`);
    L.sig(62680, y, 1, `NH N${t}`);
  }
  L.xo(62812, 5, 4, 105);
  L.sig(63078, 4, -1, "NH F551"); L.sig(63078, 5, 1, "NH Y552", "block");
  L.station("NH", "Niederhövels", 62400, 2.6);

  // ---------------- Scheuerfeld (Sieg) (SF) ----------------
  L.blk(66135, 4, 5, "BZ A452");
  L.plat(66730, 66870, 4, "SF", "1"); L.plat(66730, 66870, 5, "SF", "2");
  L.station("SF", "Scheuerfeld (Sieg)", 66800, 2.6);

  // ---------------- Betzdorf (Sieg) (BZ) ----------------
  // Gl. 5 (y 3), Gl. 2 (y 4), Gl. 4 (y 5), Gl. 6 Durchfahrgleis Güterzüge (y 2)
  L.sig(67900, 5, 1, "BZ A"); L.sig(67900, 4, -1, "BZ AA", "block");
  L.xo(68250, 5, 4, 80); L.xo(68350, 4, 5, 80);
  L.conn(68470, 4, 68550, 3, 40);
  L.lane(3, 68550, 69400, { v: 40 });
  L.conn(68580, 3, 68650, 2, 40);
  L.lane(2, 68650, 69300, { v: 40 });
  L.conn(69300, 2, 69360, 3, 40);
  L.conn(69400, 3, 69480, 4, 40);
  for (const [y, t] of [[3, "5"], [4, "2"], [5, "4"]] as const) {
    L.plat(68700, 69350, y, "BZ", t);
    L.sig(68700, y, -1, `BZ P${t}`);
    L.sig(69350, y, 1, `BZ N${t}`);
  }
  L.sig(68700, 2, -1, "BZ P6"); L.sig(69250, 2, 1, "BZ N6");
  L.xo(69520, 4, 5, 80); L.xo(69620, 5, 4, 80);
  // Hellertalbahn und Daadetalbahn (eingleisig)
  L.conn(69760, 5, 69840, 7, 50);
  L.lane(7, 69840, 70800, { v: 80 });
  L.conn(69900, 7, 69980, 8, 40);
  L.lane(8, 69980, 70800, { v: 50 });
  L.sig(70000, 4, -1, "BZ F"); L.sig(70000, 7, -1, "BZ H"); L.sig(70000, 8, -1, "BZ D");
  L.portal("E_BZ", 70800, 4, 5, -1, "Siegen");
  L.portal("E_HT", 70800, 7, 7, -1, "Haiger (Hellertal)");
  L.portal("E_DT", 70800, 8, 8, -1, "Daaden");
  L.station("BZ", "Betzdorf (Sieg)", 69025, 0.6);

  // Streckenenden West
  L.portal("W_S", -1600, 5, 4, 1, "Köln (S-Bahn)");
  L.portal("W_M", -1600, 11, 10, 1, "Köln-Gremberg");

  L.label(-1200, -0.9, "SFS Köln – Rhein/Main");
  L.label(-1200, 9.2, "Rechte Rheinstrecke");
  L.label(14000, 9.2, "Richtung Bonn");
  L.label(33000, 3.2, "Siegstrecke");
  L.label(70300, 9.2, "Hellertal / Daadetal");
  return L.build();
}
