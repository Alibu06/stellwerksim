# Erzeugt aus einer CSS-Datei die Regeln für das helle Design (html.light ...), gleiche Farbregel wie src/ui/theme.ts
import re, sys, colorsys
def lightify(h):
    x = h[1:]
    if len(x) in (3, 4): x = ''.join(c*2 for c in x)
    r, g, b = (int(x[i:i+2], 16)/255 for i in (0, 2, 4))
    a = x[6:8] if len(x) == 8 else ''
    hh, l, s = colorsys.rgb_to_hls(r, g, b)
    if s < 0.35 or l < 0.3:
        l = 1 - l*0.92
        if l > 0.6: s = min(s, 0.35)
    elif l > 0.45:
        l = l*(0.62 if 0.08 < hh < 0.2 else 0.78)
    R, G, B = colorsys.hls_to_rgb(hh, max(0, min(1, l)), s)
    return '#%02x%02x%02x%s' % (round(R*255), round(G*255), round(B*255), a)
src = open(sys.argv[1]).read()
src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
out = []
# einfache Regeln (keine verschachtelten @-Blöcke außer @keyframes, die übersprungen werden)
src = re.sub(r'@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}', '', src)
for sel, body in re.findall(r'([^{}]+)\{([^}]*)\}', src):
    if '.zza' in sel: continue  # Zugzielanzeiger bleiben in beiden Designs blau wie am echten Bahnsteig
    decls = []
    for d in body.split(';'):
        if ':' not in d: continue
        prop, val = d.split(':', 1)
        if not re.search(r'#[0-9a-fA-F]{3,8}\b', val): continue
        decls.append(prop.strip() + ': ' + re.sub(r'#[0-9a-fA-F]{3,8}\b', lambda m: lightify(m.group(0)), val.strip()))
    if not decls: continue
    sels = []
    for s in sel.split(','):
        s = s.strip()
        if s == ':root': sels.append('html.light')
        elif s == 'html': sels.append('html.light')
        else: sels.append('html.light ' + s)
    out.append(', '.join(sels) + ' { ' + '; '.join(decls) + '; }')
print('/* automatisch erzeugt mit tools/lightcss.py – nicht von Hand ändern */')
print('\n'.join(out))
