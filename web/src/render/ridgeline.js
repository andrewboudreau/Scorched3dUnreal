import * as THREE from 'three';
import { addFogShade } from './terrainMesh.js';
import { look } from './timeofday.js';

// The Ridgeline's look (core/ridgeline.js): sandstone in a few broad, soft
// strata. The beds follow the world's height (five of them, bottom to top: deep
// rust, warm sandstone, a cream band, terracotta, pale cap rock) with gently
// wavy edges, so a crater wall cuts through them and shows the layers, and the
// field's four sides are cut-away cliff faces, a diorama of the range in
// cross-section.
//
// Slope decides how much shows. Steep faces wear the strata; flat tops and
// ledges (where the tanks stand) lie under a pale dust; ground a blast has cut
// or heaped, and the slopes that slumped from it, read as loose light sand.
// Colour carries no per-vertex noise: the beds are smooth and the only grain is
// a faint lamination. Far rock and the low floor fade into the scene's haze, so
// the look follows each time of day (render/sky.js sets the fog colour).
//
// TerrainMesh swaps these materials in for a ridgeline field (`useRidge`) and
// writes a `cut` attribute per vertex: how far the ground now lies below its
// crust (negative where dirt was heaped on it). Its vertex colours carry only
// the scorch and a little relief shading, which multiply the rock's colour.

const BED_RUST = '#8f4630';    // the base
const BED_SAND = '#c97f4e';    // warm sandstone
const BED_CREAM = '#e8c28a';   // the cream band
const BED_TERRA = '#b4623e';   // terracotta
const BED_CAP = '#dfba88';     // pale cap rock on the peaks
const DUST = '#d3a874';        // the dust on flat tops and ledges
const LOOSE = '#e4c08c';       // sand a blast has cut or heaped
const DEEP = '#3a2430';        // the rock sinking into the dark

const uniforms = {
  uRust: { value: new THREE.Color(BED_RUST) },
  uSand: { value: new THREE.Color(BED_SAND) },
  uCream: { value: new THREE.Color(BED_CREAM) },
  uTerra: { value: new THREE.Color(BED_TERRA) },
  uCap: { value: new THREE.Color(BED_CAP) },
  uDust: { value: new THREE.Color(DUST) },
  uLoose: { value: new THREE.Color(LOOSE) },
  uDeep: { value: new THREE.Color(DEEP) },
  uLit: look.lit,   // 0 by day, 1 at night: the rock cools and darkens (render/timeofday.js)
};

// The colour of the rock at world point p: broad beds with soft, slightly wavy
// edges (a low swell across the field, no fine stripes).
const STRATA = `
uniform vec3 uRust;
uniform vec3 uSand;
uniform vec3 uCream;
uniform vec3 uTerra;
uniform vec3 uCap;
uniform vec3 uDust;
uniform vec3 uLoose;
uniform vec3 uDeep;
uniform float uLit;
varying vec3 vRidgeP;
vec3 strataAt(vec3 p) {
  float y = p.y + sin(p.x * 0.013 + p.z * 0.009) * 3.4 + sin(p.x * 0.031 - p.z * 0.023) * 1.1;
  vec3 c = uRust;
  c = mix(c, uSand, smoothstep(14.0, 17.5, y));
  c = mix(c, uCream, smoothstep(34.0, 37.0, y));
  c = mix(c, uTerra, smoothstep(48.0, 51.0, y));
  c = mix(c, uCap, smoothstep(70.0, 73.0, y));
  c *= 0.97 + 0.03 * sin(y * 1.7);   // a faint lamination, the only grain
  return c;
}`;

function inject(material, { ground }) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRidgeP;${ground ? '\nattribute float cut;\nvarying float vCut;\nvarying vec3 vRidgeN;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvRidgeP = (modelMatrix * vec4(transformed, 1.0)).xyz;${ground ? '\nvCut = cut;\nvRidgeN = mat3(modelMatrix) * normal;' : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${STRATA}${ground ? '\nvarying float vCut;\nvarying vec3 vRidgeN;' : ''}`)
      .replace('#include <color_fragment>', ground ? `#include <color_fragment>
{
  vec3 rock = strataAt(vRidgeP);
  // Steep faces show the beds; flat tops and ledges lie under pale dust that
  // keeps a hint of the bed below.
  float ny = clamp(normalize(vRidgeN).y, 0.0, 1.0);
  float steep = 1.0 - smoothstep(0.55, 0.92, ny);
  vec3 dust = mix(uDust, rock, 0.18);
  // Under a low sun (Dawn, Dusk) the dust would go the same red-brown as a
  // tank standing on it: let it grey toward a cooler sand, so a dark red hull
  // keeps its edge. The sun's height comes from the scene's light (world y).
  #if NUM_DIR_LIGHTS > 0
  float sunY = (transpose(mat3(viewMatrix)) * directionalLights[0].direction).y;
  float lowSun = 1.0 - smoothstep(0.22, 0.55, sunY);
  float dl = dot(dust, vec3(0.3, 0.59, 0.11));
  dust = mix(dust, vec3(dl) * vec3(1.02, 1.0, 0.94) * 1.4, 0.6 * lowSun);
  #endif
  vec3 c = mix(dust, rock, steep);
  // Ground a blast cut or heaped, and the slopes that slumped from it: loose
  // light sand, except on a crater wall too steep to hold any.
  float loose = smoothstep(0.005, 0.12, abs(vCut)) * smoothstep(0.35, 0.62, ny);
  c = mix(c, uLoose, loose * 0.7);
  // Deep down the rock sinks into the haze's dark: a clean gradient into the floor.
  vec3 deep = mix(uDeep, fogColor * 0.25, 0.3);
  float sink = smoothstep(-44.0 - 36.0 * smoothstep(0.8, 1.0, uLit), -2.0, vRidgeP.y);   // Night: the range sinks less, so it still reads
  c = mix(deep, c, sink);
  diffuseColor.rgb *= c * 0.8;
}` : `#include <color_fragment>
{
  vec3 deep = mix(uDeep, fogColor * 0.25, 0.3);
  float sink = smoothstep(-44.0 - 36.0 * smoothstep(0.8, 1.0, uLit), -2.0, vRidgeP.y);   // Night: the range sinks less, so it still reads
  diffuseColor.rgb *= 0.8 * mix(deep, strataAt(vRidgeP), sink);
}`)
      // A share of the rock's own colour as glow, so faces turned from the sun
      // keep their colour, not a flat shadow.
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
float night = smoothstep(0.8, 1.0, uLit);   // only Night: a Dusk ridge keeps its own red look
diffuseColor.rgb *= mix(vec3(1.0), vec3(0.74, 0.86, 1.2), night);
totalEmissiveRadiance += diffuseColor.rgb * 0.18 * (1.0 + 0.5 * night);`)
      // Far rock fades toward the sky: haze that starts well inside the scene's fog.
      .replace('#include <fog_fragment>', `{
  float haze = smoothstep(400.0, 1500.0, vFogDepth) * 0.3 + smoothstep(14.0, -26.0, vRidgeP.y) * 0.18;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, haze);
}
#include <fog_fragment>`);
  };
  addFogShade(material, ground ? 'ridge-ground' : 'ridge-cliff');
}

let shared = null;
// The two materials, made once and shared by every ridgeline match.
export function ridgeMaterials() {
  if (shared) return shared;
  const ground = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.96, metalness: 0 });
  inject(ground, { ground: true });
  const cliff = new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, roughness: 1, metalness: 0, side: THREE.DoubleSide });
  inject(cliff, { ground: false });
  shared = { ground, cliff };
  return shared;
}

// The per-vertex values a TerrainMesh writes for a ridgeline field: a grey
// that carries the scorch and a little relief shading (`hollow`: how far the
// vertex sits below its neighbours), and the cut below the crust. A burn shows
// less on cut rock, so a crater's walls keep their bands.
export function ridgeShade(field, k, hollow) {
  const cut = field.crust ? field.crust[k] - field.heights[k] : 0;
  const burn = Math.min(0.7, field.scorch[k] * (cut > 0.5 ? 0.25 : 0.45));
  return Math.min(1.04, Math.max(0.9, 1 - hollow * 0.05)) * (1 - burn);
}
export function ridgeCut(field, k) {
  const cut = field.crust ? field.crust[k] - field.heights[k] : 0;
  return Math.max(-6, Math.min(80, cut));
}

// The overview (the V key): over the isles and meadows it looks down from high
// in the south; on a ridgeline it stands back level with the range, side on,
// so the profile reads, far enough back for the near edge to fill the width.
export function overviewGoal(game, camera) {
  if (!game?.ridgeline) return new THREE.Vector3(0, 610, 520);
  const half = game.terrain.half;
  const tanH = Math.tan((camera.fov * Math.PI) / 360) * camera.aspect;
  const d = Math.min(1350, half + (half * 1.04) / Math.max(0.2, tanH));
  return new THREE.Vector3(0, d * 0.1, d);
}

// The far floor of a ridgeline match: unlit, dark under the range (a tint of
// the scene's fog colour, so it follows the time of day) and clearing to the
// haze with distance, a clean gradient into the horizon.
let floorMat = null;
function ridgeFloorMaterial() {
  if (floorMat) return floorMat;
  floorMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  floorMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb = fogColor * vec3(0.2, 0.14, 0.15);`)
      .replace('#include <fog_fragment>', 'gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, smoothstep(300.0, 3600.0, vFogDepth));');
  };
  floorMat.customProgramCacheKey = () => 'ridge-floor';
  return floorMat;
}

// A ridgeline match in the sky and on the far floor (or back to the meadows'
// with `on` false).
export function setRidgeWorld(on, { sky, floor }) {
  sky.setRidge?.(on);
  if (!floor) return;
  floor.userData.meadow ??= floor.material;
  floor.material = on ? ridgeFloorMaterial() : floor.userData.meadow;
}
