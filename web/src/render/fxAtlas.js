import * as THREE from 'three';

// The fire, flash and smoke sprites (Kenney FX sprites, CC0), packed into one
// 4x4 sheet by tools/buildfx.py. Each cell is its own Texture that shares the
// one image, so the sheet uploads to the GPU once while every sprite can still
// pick its own cell. Keep the cell order in step with SPRITES in that script.

export const ATLAS_URL = 'fx/fx-atlas.png';
const COLS = 4, ROWS = 4;

// Cell indexes by kind.
export const CELLS = {
  fire: [0, 1, 2, 3],        // blobs of fire (additive)
  flash: [4, 5],             // white-hot bursts (additive)
  flame: [6, 7],             // a single tongue of flame (additive)
  smokeDark: [8, 9, 10, 11], // soot (normal blending)
  smokeLight: [12, 13, 14, 15],
};

// Returns { fire: [Texture...], flash: [...], ... }; `onLoad` fires once the
// image has arrived (until then the textures are empty).
export function loadAtlas(url = ATLAS_URL, onLoad = null) {
  const base = new THREE.TextureLoader().load(url, () => onLoad?.());
  base.colorSpace = THREE.SRGBColorSpace;
  base.generateMipmaps = true;
  base.minFilter = THREE.LinearMipmapLinearFilter;
  const cell = (i) => {
    const t = base.clone();          // shares the image (one upload)
    t.repeat.set(1 / COLS, 1 / ROWS);
    t.offset.set((i % COLS) / COLS, 1 - (Math.floor(i / COLS) + 1) / ROWS);
    t.needsUpdate = true;
    return t;
  };
  const out = {};
  for (const [kind, ids] of Object.entries(CELLS)) out[kind] = ids.map(cell);
  return out;
}
