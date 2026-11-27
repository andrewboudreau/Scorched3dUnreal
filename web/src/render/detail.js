// Settings > Graphics > Detail, for shaders (render/graphics.js sets it). A
// material handed to cheapWhenLow() gets the GFX_LOW define while Detail is
// Low, and its shader takes a cheaper path under `#ifdef GFX_LOW`. Defines are
// part of three.js's program key, so a switch recompiles each one once.

const materials = new Set();
let low = false;

function mark(m) {
  const has = 'GFX_LOW' in (m.defines || {});
  if (has === low) return;
  m.defines ??= {};
  if (low) m.defines.GFX_LOW = '';
  else delete m.defines.GFX_LOW;
  m.needsUpdate = true;
}

export function cheapWhenLow(material) {
  materials.add(material);
  mark(material);
  return material;
}

// A material that is being thrown away (TerrainMesh.dispose).
export function forgetDetail(material) { materials.delete(material); }

export function setLowDetail(on) {
  low = !!on;
  for (const m of materials) mark(m);
}

export const lowDetail = () => low;
