import { setLowDetail } from './detail.js';
import { setTerrainLow, SHADOW_LAYER } from './terrainMesh.js';
import { setTankBlobs } from './tankMesh.js';

// What Settings > Graphics > Detail draws (the choice and the Auto rule are
// src/graphics.js). All of it applies live: the next frame draws at the new
// tier, and the shaders that change recompile once.
//
// High is the game as designed: pixel ratio up to 1.5 (1.25 on a phone or
// tablet), a 4096² sun shadow map (2048² on a phone), and the ground's full
// shader. Low is the same game, plainer:
// - pixel ratio 1;
// - a 1024² shadow map (tanks, trees and buildings still cast; softer edges),
//   plus a soft dark blob under each tank (tankMesh.js setTankBlobs) so its
//   contact shadow stays as readable as on High;
// - the ground casts its shadow from a quarter-triangle copy of itself
//   (terrainMesh.js setTerrainLow) instead of drawing all of it twice;
// - the ground shader drops its warp, a noise layer, the bump tilt and the
//   cloud shadows, and the water three of its five waves and its noise
//   (render/detail.js, the GFX_LOW define). Palette, paths, scorch, the fog of
//   war and the City's pavement are the same.

export const TIERS = {
  high: { ratio: 1.5, phoneRatio: 1.25, shadow: 4096, phoneShadow: 2048 },
  low: { ratio: 1, phoneRatio: 1, shadow: 1024, phoneShadow: 1024 },
};

export function applyGraphics(tier, { renderer, sky, coarse = false }) {
  const T = TIERS[tier] || TIERS.high;
  const low = tier === 'low';
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, coarse ? T.phoneRatio : T.ratio));
  const shadow = sky.sun.shadow;
  const size = coarse ? T.phoneShadow : T.shadow;
  // The next shadow pass resizes the map in place (WebGLShadowMap calls
  // setSize). Don't drop the map instead: the materials keep the old texture.
  shadow.mapSize.set(size, size);
  shadow.camera.layers.enable(SHADOW_LAYER);   // the ground's coarse shadow caster
  setTerrainLow(low);
  setLowDetail(low);
  setTankBlobs(low);
}
