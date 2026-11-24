import * as THREE from 'three';
import { addFogShade } from './terrainMesh.js';

// The Ridgeline's look (core/ridgeline.js): flat-shaded rock in banded strata.
// The beds follow the world's height, so a crater wall cuts through them and
// shows the layers, and the field's four sides are cut-away cliff faces, a
// diorama of the range in cross-section. The undisturbed surface is the same
// rock under a weathered crust: paler toward the peaks, its bands softened.
//
// TerrainMesh swaps these materials in for a ridgeline field (`useRidge`) and
// writes a `cut` attribute per vertex: how far the ground now lies below its
// crust (negative where dirt was heaped on it). Its vertex colours carry only
// the scorch and the relief shading, which multiply the rock's colour.

// The beds, bottom to top of one cycle, and the dark rock they sink into.
const BEDS = ['#a2583a', '#e2b57e', '#7c4636', '#d0915c', '#b8744b', '#efd29e', '#8c5446', '#c98454'];
const DEEP = '#3a2a3c';
const CRUST_LOW = '#b06848';    // the weathered surface, low in the valleys
const CRUST_HIGH = '#f1d3a0';   // and high on the peaks
const LOOSE = '#9a6a4a';        // dirt heaped by a Mound

const uniforms = {
  uBeds: { value: BEDS.map((c) => new THREE.Color(c)) },
  uDeep: { value: new THREE.Color(DEEP) },
  uCrustLo: { value: new THREE.Color(CRUST_LOW) },
  uCrustHi: { value: new THREE.Color(CRUST_HIGH) },
  uLoose: { value: new THREE.Color(LOOSE) },
};

// The colour of the rock at world point p: beds about 3 m thick, of uneven
// thickness, dipping gently across the field, with a dark seam under each.
const STRATA = `
uniform vec3 uBeds[8];
uniform vec3 uDeep;
uniform vec3 uCrustLo;
uniform vec3 uCrustHi;
uniform vec3 uLoose;
varying vec3 vRidgeP;
vec3 strataAt(vec3 p) {
  float y = p.y + sin(p.x * 0.019 + p.z * 0.011) * 2.2 + sin(p.x * 0.061 - p.z * 0.037) * 0.7;
  y += 2.2 * sin(y * 0.093);
  float b = y / 3.3;
  float f = fract(b);
  int i = int(mod(floor(b), 8.0));
  vec3 c = uBeds[i];
  c *= 0.78 + 0.22 * smoothstep(0.0, 0.1, f);
  return mix(c, uDeep, clamp((8.0 - p.y) / 70.0, 0.0, 0.8));
}`;

function inject(material, { ground }) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRidgeP;${ground ? '\nattribute float cut;\nvarying float vCut;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvRidgeP = (modelMatrix * vec4(transformed, 1.0)).xyz;${ground ? '\nvCut = cut;' : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${STRATA}${ground ? '\nvarying float vCut;' : ''}`)
      .replace('#include <color_fragment>', ground ? `#include <color_fragment>
{
  vec3 rock = strataAt(vRidgeP);
  // The crust: the same beds, softened and paler toward the peaks.
  vec3 crust = mix(rock, mix(uCrustLo, uCrustHi, smoothstep(5.0, 120.0, vRidgeP.y)), 0.62);
  vec3 c = mix(crust, rock, smoothstep(0.35, 1.4, vCut));
  c = mix(c, uLoose, smoothstep(0.3, 1.2, -vCut) * 0.8);
  diffuseColor.rgb *= c;
}` : `#include <color_fragment>
diffuseColor.rgb *= strataAt(vRidgeP);`)
      // A share of the rock's own colour as glow, so beds in shadow (a crater's
      // far wall, a cliff face turned from the sun) keep their bands.
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * 0.16;`);
  };
  addFogShade(material, ground ? 'ridge-ground' : 'ridge-cliff');
}

let shared = null;
// The two materials, made once and shared by every ridgeline match.
export function ridgeMaterials() {
  if (shared) return shared;
  const ground = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.96, metalness: 0 });
  inject(ground, { ground: true });
  const cliff = new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, roughness: 1, metalness: 0, side: THREE.DoubleSide });
  inject(cliff, { ground: false });
  shared = { ground, cliff };
  return shared;
}

// The per-vertex values a TerrainMesh writes for a ridgeline field: a grey
// that carries the scorch and the relief shading (`hollow`: how far the vertex
// sits below its neighbours), and the cut below the crust. A burn shows less
// on cut rock, so a crater's walls keep their bands.
export function ridgeShade(field, k, hollow) {
  const cut = field.crust ? field.crust[k] - field.heights[k] : 0;
  const burn = Math.min(0.7, field.scorch[k] * (cut > 0.5 ? 0.25 : 0.45));
  return Math.min(1.08, Math.max(0.8, 1 - hollow * 0.12)) * (1 - burn);
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
  return new THREE.Vector3(0, d * 0.14, d);
}

// A ridgeline match in the sky and on the far floor (or back to the meadows'
// with `on` false).
const FLOOR_RIDGE = new THREE.Color('#3c2a32');
export function setRidgeWorld(on, { sky, floor }) {
  sky.setRidge?.(on);
  if (!floor) return;
  floor.userData.meadow ??= floor.material.color.clone();
  floor.material.color.copy(on ? FLOOR_RIDGE : floor.userData.meadow);
}
