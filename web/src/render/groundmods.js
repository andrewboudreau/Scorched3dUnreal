import * as THREE from 'three';
import { TankMesh } from './tankMesh.js';
import { POINTDEF } from '../core/mods.js';

// The mods that stand on the ground, drawn (the rules are in core/mods.js;
// render/mods.js places them):
//   - the decoy: a copy of its owner's tank where it stood. Its owner sees a
//     hologram (see-through, scan lines, a flicker); everyone else a tank.
//     When it fizzles it comes apart in sparks (render/mods.js breakUp).
//   - Point Defense: a small turret beside its tank, its head sweeping, a
//     faint ring on the ground for its owner showing its reach, and when it
//     shoots a shell down a tracer from its barrels to the burst.

const HOLO = new THREE.Color('#7fe6ff');

// The decoy's hologram look: the owner's colour washed toward cyan, lit
// at the edges, with scan lines running up it and a flicker.
export const hologramMaterial = (color) => new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  uniforms: { color: { value: new THREE.Color(color).lerp(HOLO, 0.55) }, time: { value: 0 }, fade: { value: 1 } },
  vertexShader: `varying vec3 vN; varying vec3 vV; varying float vY;
    void main() {
      vec4 w = vec4(position, 1.0);
      vec3 n = normal;
      #ifdef USE_INSTANCING
        w = instanceMatrix * w;   // the tank's road wheels
        n = mat3(instanceMatrix) * n;
      #endif
      w = modelMatrix * w;
      vY = w.y;
      vec4 mv = viewMatrix * w;
      vN = normalize(normalMatrix * n); vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `uniform vec3 color; uniform float time; uniform float fade; varying vec3 vN; varying vec3 vV; varying float vY;
    void main() {
      float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
      float scan = 0.55 + 0.45 * step(0.5, fract(vY * 3.0 - time * 1.6));
      float flick = 0.85 + 0.15 * sin(time * 23.0) * sin(time * 7.0);
      float a = (0.16 + 0.75 * pow(rim, 1.8)) * scan * flick * fade;
      gl_FragColor = vec4(color * a * 1.6, a);
    }`,
});

// A copy of `color`'s tank for a decoy; a hologram when `holo`.
export function makeDecoy(color, holo) {
  const tank = new TankMesh(color);
  let mat = null;
  if (holo) {
    mat = hologramMaterial(color);
    tank.root.traverse((o) => { if (o.isMesh) { o.material = mat; o.castShadow = false; o.receiveShadow = false; o.renderOrder = 3; } });
  }
  return { group: tank.root, tank, mat, holo, kind: 'decoy' };
}

// The Point Defense turret: a squat base, a head that turns, twin barrels.
export function makeTurret(color, radius, mine) {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: '#59606a', roughness: 0.55, metalness: 0.5, flatShading: true });
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2, flatShading: true });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.15, 0.7, 8), steel);
  base.position.y = 0.35;
  const head = new THREE.Group();
  head.position.y = 1.0;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.6, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), paint);
  const pivot = new THREE.Group();
  pivot.position.y = 0.25;
  for (const s of [-1, 1]) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.3, 6), steel);
    barrel.rotation.z = -Math.PI / 2;
    barrel.position.set(0.75, 0, s * 0.17);
    pivot.add(barrel);
  }
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: '#ff5a3c' }));
  eye.position.set(0.48, 0.18, 0);
  head.add(dome, pivot, eye);
  g.add(base, head);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  let ring = null;
  if (mine) {
    ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.35, radius, 64),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.4), transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 4;
  }
  return { group: g, head, pivot, ring, radius, kind: 'pointdef', aim: null };
}

// The reach of a Point Defense at `level`.
export const turretReach = (level) => POINTDEF[level]?.radius || 0;

// A tracer from `from` to `to`: a bright line that fades in a moment.
export function makeTracer(from, to) {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...from), new THREE.Vector3(...to)]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: '#ffe08a', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  line.frustumCulled = false;
  return line;
}
