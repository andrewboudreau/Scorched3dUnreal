"""Builds web/fx/fx-atlas.png: one 4x4 sheet of Kenney FX sprites (CC0) for the
fire, flash and smoke effects (src/render/fxAtlas.js lists the cells; keep the
two in step).

Reads the pack library folder from tools/local.json ("packs") or the
CRATERFALL_PACKS environment variable, so no machine path is committed.

    python tools/buildfx.py
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

CELL = 192
COLS = ROWS = 4
# Row by row, left to right. Must match CELLS in src/render/fxAtlas.js.
SPRITES = [
    'explosion-1', 'explosion-3', 'explosion-5', 'explosion-8',
    'flash-2', 'flash-5', 'explosion-2', 'explosion-6',
    'smoke-black-1', 'smoke-black-8', 'smoke-black-15', 'smoke-black-22',
    'smoke-white-puff-1', 'smoke-white-puff-8', 'smoke-white-puff-15', 'smoke-white-puff-22',
]

here = Path(__file__).resolve().parent
packs = os.environ.get('CRATERFALL_PACKS')
if not packs:
    packs = json.loads((here / 'local.json').read_text())['packs']
src = Path(packs) / 'kenney-fx-sprites' / 'sprites'
out = here.parent / 'fx' / 'fx-atlas.png'
out.parent.mkdir(exist_ok=True)

sheet = Image.new('RGBA', (CELL * COLS, CELL * ROWS), (0, 0, 0, 0))
for i, name in enumerate(SPRITES):
    im = Image.open(src / f'{name}.png').convert('RGBA')
    # Resize with premultiplied alpha so transparent edges do not pick up a dark fringe.
    a = np.asarray(im, dtype=np.float32) / 255
    a[..., :3] *= a[..., 3:4]
    pm = Image.fromarray((a * 255).round().astype(np.uint8), 'RGBA')
    scale = (CELL - 4) / max(pm.size)
    pm = pm.resize((max(1, round(pm.width * scale)), max(1, round(pm.height * scale))), Image.LANCZOS)
    b = np.asarray(pm, dtype=np.float32) / 255
    al = b[..., 3:4]
    b[..., :3] = np.where(al > 0.004, b[..., :3] / np.maximum(al, 0.004), 0)
    cell = Image.fromarray((np.clip(b, 0, 1) * 255).round().astype(np.uint8), 'RGBA')
    x = (i % COLS) * CELL + (CELL - cell.width) // 2
    y = (i // COLS) * CELL + (CELL - cell.height) // 2
    sheet.paste(cell, (x, y))
sheet.save(out, optimize=True)
print(out, out.stat().st_size, 'bytes')
sys.exit(0)
