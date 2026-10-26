#!/usr/bin/env python3
"""
Prepares the visual simulator (viz/index.html):
  * copies item/block textures out of your local Minecraft 1.21 client jar into viz/textures/ (first run only)
  * writes viz/sets.json, the list of item sets in data/sets/

    python viz/prepare.py [--jar path/to/client.jar]
"""
import argparse, glob, json, os, re, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TEX = HERE / 'textures'
GUI = ['gui/container/shulker_box', 'gui/container/generic_54', 'font/ascii']   # shulker/chest screens, item-count font


def find_jar():
    home = Path.home()
    pats = [home / '.local/share/PrismLauncher/libraries/com/mojang/minecraft/1.21*/*client.jar',
            home / '.minecraft/versions/1.21*/*.jar']
    jars = [j for p in pats for j in glob.glob(str(p))]
    ver = lambda j: [int(x) for x in re.findall(r'1\.21(?:\.(\d+))?', j)[0:1] if x] or [0]
    return max(jars, key=ver) if jars else None


def extract(jar):
    names = {'item': [], 'block': []}
    with zipfile.ZipFile(jar) as z:
        for info in z.infolist():
            m = re.fullmatch(r'assets/minecraft/textures/(item|block)/([a-z0-9_]+)\.png', info.filename)
            g = re.fullmatch(r'assets/minecraft/textures/(.+)\.png', info.filename)
            if m or (g and g[1] in GUI):
                out = TEX / f'{g[1]}.png'
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(z.read(info))
                if m:
                    names[m[1]].append(m[2])
    (TEX / 'manifest.json').write_text(json.dumps({k: sorted(v) for k, v in names.items()}))
    with zipfile.ZipFile(jar) as z:
        (TEX / 'icons.json').write_text(json.dumps(icon_specs(z), separators=(',', ':')))
    return sum(map(len, names.values()))


# ---------------------------------------------------------------- inventory icons (3D blocks like the game's GUI)
TINT = {'minecraft:grass': 0x7CBD6B, 'minecraft:foliage': 0x48B518, 'minecraft:dry_foliage': 0xA4823E}


def icon_specs(z):
    """item name -> how the inventory draws it: {'els': cuboids, 'gui': transform} or {'flat': [texture layers]}."""
    files = set(z.namelist())
    cache = {}

    def model(name):
        name = name.removeprefix('minecraft:')
        if name not in cache:
            path = f'assets/minecraft/models/{name}.json'
            cache[name] = json.loads(z.read(path)) if path in files else {}
        return cache[name]

    def flatten(name):                       # merge the parent chain: textures, elements, gui display
        chain, n = [], name
        while n and not n.startswith('builtin/') and len(chain) < 20:
            m = model(n); chain.append(m); n = m.get('parent', '').removeprefix('minecraft:')
        tex, els, gui = {}, None, None
        for m in reversed(chain):
            tex.update(m.get('textures', {}))
            els = m.get('elements', els)
            gui = m.get('display', {}).get('gui', gui)
        return tex, els, gui, n

    def resolve(tex, ref, depth=0):
        while ref.startswith('#') and depth < 10:
            ref, depth = tex.get(ref[1:], ''), depth + 1
        return ref.removeprefix('minecraft:') if ref and not ref.startswith('#') else None

    def pick(node):                           # item definition -> (model name, tints, special?)
        t = node.get('type', '').removeprefix('minecraft:')
        if t == 'model':
            return node['model'], node.get('tints', []), False
        if t == 'special':
            return node['base'], [], True
        for k in ('fallback', 'on_false', 'on_true'):
            if node.get(k):
                return pick(node[k])
        for k in ('cases', 'entries', 'models'):
            if node.get(k):
                first = node[k][0]
                return pick(first.get('model', first))
        return None, [], False

    def tint_color(t):
        kind = t.get('type', '')
        if kind == 'minecraft:constant':
            return t['value'] & 0xFFFFFF
        if kind in TINT:
            return TINT[kind]
        return t['default'] & 0xFFFFFF if 'default' in t else None

    out = {}
    for f in files:
        m = re.fullmatch(r'assets/minecraft/items/([a-z0-9_]+)\.json', f)
        if not m:
            continue
        try:
            name, tints, special = pick(json.loads(z.read(f))['model'])
            if not name:
                continue
            tex, els, gui, base = flatten(name.removeprefix('minecraft:'))
            colors = [tint_color(t) for t in tints]
            if els and not special:
                spec_els = []
                for e in els:
                    faces = {}
                    for d, fc in e.get('faces', {}).items():
                        tx = resolve(tex, fc.get('texture', ''))
                        if tx:
                            ti = fc.get('tintindex', -1)
                            faces[d] = {'t': tx, 'uv': fc.get('uv'), 'r': fc.get('rotation', 0),
                                        'c': colors[ti] if 0 <= ti < len(colors) else None}
                    spec_els.append({'f': e['from'], 't': e['to'], 'rot': e.get('rotation'), 'faces': faces})
                out[m[1]] = {'els': spec_els, 'gui': gui or {'rotation': [30, 225, 0], 'scale': [0.625] * 3}}
            elif base == 'builtin/generated' or not special:
                layers = [resolve(tex, f'#layer{i}') for i in range(5)]
                layers = [l for l in layers if l]
                if layers:
                    out[m[1]] = {'flat': layers, 'c': [colors[i] if i < len(colors) else None for i in range(len(layers))]}
            else:                               # chests and shulker boxes drawn as plain cubes; heads, beds... keep a flat fallback
                part = resolve(tex, '#particle')
                if part and ('chest' in m[1] or 'shulker_box' in m[1]):
                    out[m[1]] = {'cube': part}
        except (KeyError, ValueError, TypeError):
            continue
    return out


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--jar')
    a = ap.parse_args()
    if not (TEX / 'icons.json').exists() or a.jar or not all((TEX / f'{g}.png').exists() for g in GUI):
        jar = a.jar or find_jar()
        if jar and os.path.isfile(jar):
            print(f'textures: {extract(jar)} copied from {jar}')
        else:
            print('textures: no Minecraft 1.21 client jar found (use --jar); items will show as coloured squares')
    sets = sorted(p.name for p in (ROOT / 'data' / 'sets').glob('*.litematic'))
    (HERE / 'sets.json').write_text(json.dumps(sets))
    print(f'sets: {len(sets)} in data/sets')
