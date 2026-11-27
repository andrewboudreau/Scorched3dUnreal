import * as THREE from 'three';
import { jamPulse, JAM_STEADY_R, JAM_STEADY_OPACITY } from '../jamring.js';
import { mergeGeometries } from '../../vendor/three/addons/utils/BufferGeometryUtils.js';

// The Jammer Drone, drawn (the rules are in core/mods.js JAM; render/mods.js
// places it). Our own little model, three draw calls:
//   - the frame: a flat hexagonal body, two crossed arms, a mast and a dish
//     slung under it, pointing down at the tank it jams (one mesh, dark);
//   - the rotors: four blurred discs at the arm tips (one mesh, see-through);
//   - the emitters: a glowing ring under the body and a light on each arm tip,
//     in the owner's colour (one mesh), pulsing.
// And on the tank it jams, a steady ring and a pulse on the ground (makeJamRing),
// in the jammer's colour.

const DARK = '#2b2f36';

function frameGeometry() {
  const parts = [];
  const body = new THREE.CylinderGeometry(0.85, 1.0, 0.45, 6);
  parts.push(body);
  for (const a of [Math.PI / 4, -Math.PI / 4]) {
    const arm = new THREE.BoxGeometry(3.6, 0.14, 0.24);
    arm.rotateY(a);
    parts.push(arm);
  }
  const mast = new THREE.CylinderGeometry(0.05, 0.05, 0.9, 5);
  mast.translate(0, 0.65, 0);
  parts.push(mast);
  const dish = new THREE.ConeGeometry(0.55, 0.45, 8, 1, true);
  dish.rotateX(Math.PI);
  dish.translate(0, -0.5, 0);
  parts.push(dish);
  // Every part in the same shape (no index, normals and uvs) so they merge.
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
}

const TIPS = [0, 1, 2, 3].map((k) => {
  const a = Math.PI / 4 + (k * Math.PI) / 2;
  return [Math.cos(a) * 1.8, Math.sin(a) * 1.8];
});

function rotorGeometry() {
  return mergeGeometries(TIPS.map(([x, z]) => {
    const g = new THREE.CircleGeometry(0.75, 14).rotateX(-Math.PI / 2);
    g.translate(x, 0.2, z);
    return g;
  }));
}

function glowGeometry() {
  const parts = [new THREE.TorusGeometry(0.62, 0.09, 6, 18).rotateX(Math.PI / 2).translate(0, -0.28, 0)];
  for (const [x, z] of TIPS) parts.push(new THREE.SphereGeometry(0.13, 6, 4).translate(x, 0.02, z));
  parts.push(new THREE.SphereGeometry(0.12, 6, 4).translate(0, 1.12, 0));   // the mast's tip
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => { g.deleteAttribute('uv'); return g; }));
}

// One drone in the owner's colour: { group, body, glow, rotors }.
export function makeJammer(color) {
  const group = new THREE.Group();
  const body = new THREE.Group();
  const frame = new THREE.Mesh(frameGeometry(), new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.55, metalness: 0.35, flatShading: true }));
  const rotors = new THREE.Mesh(rotorGeometry(), new THREE.MeshBasicMaterial({ color: '#c9d2dc', transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }));
  const glowMat = new THREE.MeshStandardMaterial({ color: '#111', emissive: new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.25), emissiveIntensity: 1.4 });
  const glow = new THREE.Mesh(glowGeometry(), glowMat);
  body.add(frame, rotors, glow);
  group.add(body);
  return { group, body, glow, rotors, kind: 'jammer' };
}

// The jammed tank's ring, in its jammer's colour: flat on the ground round the
// aim dial (jamring.js), a steady faint ring and a pulse that swells out and
// fades. Drawn over the ground (no depth test), so a slope never hides it, and
// with plain blending: added light turns any colour to white on bright grass.
const RING = new THREE.RingGeometry(0.88, 1, 48).rotateX(-Math.PI / 2);
export function makeJamRing(color) {
  const tint = new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.3);
  const ring = (opacity) => {
    const mesh = new THREE.Mesh(RING, new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
    mesh.renderOrder = 4;
    return mesh;
  };
  const steady = ring(JAM_STEADY_OPACITY);
  steady.scale.setScalar(JAM_STEADY_R);
  const mesh = ring(0.5);
  const group = new THREE.Group();
  group.add(steady, mesh);
  return { group, mesh, steady, kind: 'jamring', shared: RING };
}

// The ring `t` seconds on.
export function pulseJamRing(it, t) {
  const { radius, opacity } = jamPulse(t);
  it.mesh.scale.setScalar(radius);
  it.mesh.material.opacity = opacity;
}
