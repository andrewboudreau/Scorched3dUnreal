import * as THREE from 'three';
import { BRIDGE, BUILDINGS, isBuilding } from '../core/scenery.js';
import { addFogShade } from './terrainMesh.js';
import { ArtifactMesh } from './artifactMesh.js';

// Draws core/scenery.js: one InstancedMesh per kind of prop, a merged bridge
// and a water plane. Static props are rewritten only when the scenery's
// `version` changes; villagers, sheep and windmill sails move every frame. A
// villager is a head-and-hat instance plus five `limb` boxes (tunic, legs,
// arms), so the limbs can swing as it walks and only the clothes take the
// villager's colour.
//
// Every building has three models: whole, `Hit` (broken open on its +z side,
// which the scenery turns toward the blow) and `Ruin`.

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();
const P = new THREE.Vector3();
const S = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const AXIS = new THREE.Vector3();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const BODY = new THREE.Matrix4();
const LIMB = new THREE.Matrix4();
const LEG_COLOUR = new THREE.Color('#3b3f52');
const VILLAGER_SCALE = 1.35;
const WHITE = new THREE.Color('#ffffff');
// Where each limb hangs from, in the villager's own space (x is forward):
// [x, y, z, which way it swings, kind]. Kind 0 is a leg, 1 an arm, 2 the tunic.
const LIMBS = [
  [0, 0.66, 0.13, 1, 0], [0, 0.66, -0.13, -1, 0],
  [0, 1.26, 0.33, -1, 1], [0, 1.26, -0.33, 1, 1],
  [0, 1.36, 0, 0, 2],
];
const TUNIC = new THREE.Vector3(2.4, 1.2, 3.2);
const ONE = new THREE.Vector3(1, 1, 1);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const SAIL = new THREE.Matrix4();
const EULER = new THREE.Euler();
const HUB = new THREE.Vector3(0, 9.3, 1.75);   // where a windmill's sails turn, in its own space

// Merge coloured parts into one flat-shaded geometry. Each part is
// [geometry, colour, x, y, z, (sx, sy, sz), (rotY), (rotX), (rotZ)].
function merge(parts) {
  const pos = [];
  const col = [];
  const c = new THREE.Color();
  for (const [geo, colour, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rotY = 0, rotX = 0, rotZ = 0] of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    M.compose(P.set(x, y, z), Q.setFromEuler(EULER.set(rotX, rotY, rotZ, 'YXZ')), S.set(sx, sy, sz));
    const a = g.attributes.position;
    c.set(colour);
    for (let i = 0; i < a.count; i++) {
      P.fromBufferAttribute(a, i).applyMatrix4(M);
      pos.push(P.x, P.y, P.z);
      col.push(c.r, c.g, c.b);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.computeVertexNormals();
  return out;
}

// A gable roof: ridge along x, `w` long, `d` deep, `h` high, base at y = 0.
function gable(w, h, d) {
  const x = w / 2;
  const z = d / 2;
  const v = [
    [-x, 0, z], [x, 0, z], [x, h, 0], [-x, 0, z], [x, h, 0], [-x, h, 0],       // front slope
    [x, 0, -z], [-x, 0, -z], [-x, h, 0], [x, 0, -z], [-x, h, 0], [x, h, 0],    // back slope
    [-x, 0, -z], [-x, 0, z], [-x, h, 0],                                       // gable ends
    [x, 0, z], [x, 0, -z], [x, h, 0],
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v.flat(), 3));
  return g;
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (top, bottom, h, n = 10) => new THREE.CylinderGeometry(top, bottom, h, n);

// Barns, silos, windmills and watchtowers, whole, broken open on the +z side
// (`Hit`, what falls off lands on the far side, -z) and in ruins, plus the turning sails and a broken-open house. Parts
// are [geometry, colour, x, y, z, (sx, sy, sz), (rotY), (rotX), (rotZ)].
function buildingModels(cone, blob) {
  const stone = '#9a958c';
  const stoneDark = '#7d786f';
  const plank = '#5e4630';
  const rubble = (x, z, s = 1, colour = '#6d655c') => [blob(1.3 * s), colour, x, 0.1, z, 1.5, 0.45, 1.2];
  const found = (w, d) => [box(w, 3.0, d), '#77706a', 0, -1.3, 0];
  return {
    houseHit: merge([
      found(7.8, 6.2),
      [box(7.2, 0.2, 5.4), '#4a3f36', 0, 0.1, 0],                          // the floor, open to the sky
      [box(7.2, 3.2, 0.4), '#ece4d2', 0, 1.6, -2.6],                       // back wall
      [box(0.4, 3.2, 5.6), '#ece4d2', -3.4, 1.6, 0],                       // gable walls
      [box(0.4, 2.3, 4.2), '#e2d8c4', 3.4, 1.15, -0.7],
      [box(2.4, 3.2, 0.4), '#ece4d2', -2.4, 1.6, 2.6],                     // what is left of the front
      [box(1.2, 1.5, 0.4), '#d8cdb8', 2.8, 0.75, 2.6],
      [box(8.0, 0.25, 3.75), '#a5523c', 0, 4.35, -1.6, 1, 1, 1, 0, -0.63], // back slope, still on
      [box(4.6, 0.25, 3.2), '#7d3f30', -1.3, 1.9, 1.0, 1, 1, 1, 0.2, 0.75, 0.25],   // front slope, fallen in
      [box(0.25, 0.25, 4.5), '#3a2a20', 1.6, 2.6, 0.2, 1, 1, 1, 0.3, 0.5], // a rafter
      [box(0.8, 1.8, 0.8), '#6f5f55', -2.2, 4.6, -1.2],                    // chimney
      rubble(1.6, 3.5, 0.9, '#8b8376'),
      rubble(-0.4, 4.2, 0.6, '#a5523c'),
    ]),
    barn: merge([
      found(11.0, 8.0),
      [box(10.4, 4.6, 7.4), '#a8402f', 0, 2.3, 0],
      [gable(11.2, 3.4, 8.2), '#4d4743', 0, 4.6, 0],
      [box(3.4, 3.6, 0.2), '#efe6d2', 0, 1.8, 3.72],                       // big doors, white trim
      [box(3.0, 3.3, 0.22), '#6e2a20', 0, 1.65, 3.74],
      [box(0.18, 4.4, 0.24), '#efe6d2', 0, 1.65, 3.76, 1, 1, 1, 0, 0, 0.72],   // the X brace
      [box(1.4, 1.2, 0.2), '#efe6d2', 0, 5.4, 3.72],                       // loft door
      [box(1.2, 0.9, 0.2), '#2f3b47', 3.6, 2.6, 3.72],
      [box(1.2, 0.9, 0.2), '#2f3b47', -3.6, 2.6, 3.72],
    ]),
    barnHit: merge([
      found(11.0, 8.0),
      [box(10.2, 0.2, 7.2), '#4a3f36', 0, 0.1, 0],
      [box(10.4, 4.6, 0.4), '#a8402f', 0, 2.3, -3.5],
      [box(0.4, 4.6, 7.4), '#a8402f', -5.0, 2.3, 0],
      [box(0.4, 3.0, 5.0), '#983a2b', 5.0, 1.5, -1.2],
      [box(3.6, 4.6, 0.4), '#a8402f', -3.3, 2.3, 3.5],
      [box(1.6, 1.8, 0.4), '#983a2b', 4.3, 0.9, 3.5],
      [box(11.2, 0.3, 4.7), '#4d4743', 0, 6.2, -2.0, 1, 1, 1, 0, -0.69],
      [box(6.5, 0.3, 4.4), '#3e3936', -1.2, 2.6, 1.3, 1, 1, 1, 0.15, 0.62, 0.2],
      ...[-3.5, -1, 1.5, 4].map((x, i) => [box(0.25, 0.25, 5.5), '#3a2a20', x, 4.4 - i * 0.4, 0.6, 1, 1, 1, 0.2 * i, 0.55]),
      [box(3.0, 3.3, 0.22), '#6e2a20', 1.2, 0.35, 0.8, 1, 1, 1, 0.4, -1.45],  // a door blown in flat
      rubble(2.6, 4.6, 1.1, '#8b4a3c'),
      rubble(-1.8, 5.0, 0.8, '#6d655c'),
    ]),
    barnRuin: merge([
      [box(11.0, 3.0, 8.0), '#5d5751', 0, -2.6, 0],
      [box(10.4, 1.4, 0.4), '#8b3a2c', 0, 0.7, -3.5],
      [box(0.4, 2.2, 4.0), '#8b3a2c', -5.0, 1.1, -1.4],
      [box(3.0, 0.9, 0.4), '#7a3427', 3.4, 0.45, 3.5],
      [blob(2.2), '#3e3936', 0.5, 0.2, 0.3, 2.0, 0.45, 1.5],
      ...[-2.5, 0, 2.2].map((x, i) => [box(0.3, 0.3, 6), plank, x, 0.9, 0.4, 1, 1, 1, 0.4 - i * 0.5, 0.25]),
      rubble(-3, 2.6, 1.0, '#8b4a3c'),
    ]),
    silo: merge([
      [cyl(2.25, 2.25, 2.6), '#77706a', 0, -1.1, 0],
      [cyl(2.0, 2.0, 9.0), '#c9c4b8', 0, 4.5, 0],
      [new THREE.SphereGeometry(2.05, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2), '#8d9aa3', 0, 9.0, 0],
      ...[2.2, 4.6, 7.0].map((y) => [cyl(2.08, 2.08, 0.16), '#8d9aa3', 0, y, 0]),
      [box(0.5, 9.4, 0.12), '#5b5f63', 0, 4.7, 2.05],                      // ladder
    ]),
    siloHit: merge([
      [cyl(2.25, 2.25, 2.6), '#77706a', 0, -1.1, 0],
      [cyl(2.0, 2.0, 5.2), '#c9c4b8', 0, 2.6, 0],
      [box(1.6, 2.0, 0.15), '#b8b2a4', -1.2, 5.8, -1.2, 1, 1, 1, 0.8, -0.2],  // jagged sheets at the break
      [box(1.4, 1.4, 0.15), '#b8b2a4', 1.4, 5.5, -0.8, 1, 1, 1, -0.9, 0.15],
      [box(1.0, 1.1, 0.15), '#b8b2a4', 0.2, 5.6, -1.9, 1, 1, 1, 0, -0.1],
      ...[2.2, 4.6].map((y) => [cyl(2.08, 2.08, 0.16), '#8d9aa3', 0, y, 0]),
      [new THREE.SphereGeometry(2.05, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2), '#8d9aa3', 0.6, 0.9, -5.2, 1, 1, 1, 0.4, -1.2],  // the dome, knocked off the far side
      [cyl(1.9, 1.9, 3.2), '#bcb6a9', -1.0, 1.0, -4.6, 1, 1, 1, 0.9, Math.PI / 2],     // a fallen ring of wall
      rubble(1.6, 3.0, 0.7, '#9a948a'),
    ]),
    siloRuin: merge([
      [cyl(2.25, 2.25, 2.6), '#5d5751', 0, -1.6, 0],
      [cyl(2.0, 2.0, 1.4), '#a9a396', 0, 0.7, 0],
      [box(1.4, 1.2, 0.15), '#a9a396', -0.9, 1.6, -1.6, 1, 1, 1, 0.7, -0.25],
      [cyl(1.9, 1.9, 2.6), '#9c968a', 0.8, 0.8, -4.0, 1, 1, 1, 0.5, Math.PI / 2],
      [new THREE.SphereGeometry(2.05, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2), '#6f7a82', -2.2, 0.5, -3.6, 1, 1, 1, 1.2, -2.1],
      rubble(0.5, -2.6, 0.8),
    ]),
    windmill: merge([
      [cyl(2.6, 2.6, 2.6, 8), '#77706a', 0, -1.1, 0],
      [cyl(1.45, 2.4, 9.0, 8), '#e9e2d2', 0, 4.5, 0],
      [cone(1.95, 2.4), '#6b4a3a', 0, 10.2, 0],
      [box(1.0, 1.9, 0.2), '#4a3526', 0, 0.95, 2.34, 1, 1, 1, 0, -0.12],  // door
      [box(0.7, 0.8, 0.2), '#2f3b47', 0, 5.4, 1.95, 1, 1, 1, 0, -0.12],
      [box(0.5, 0.5, 1.6), '#4a3526', 0, 9.3, 1.1],                        // the axle out to the sails
    ]),
    // Four lattice sails round the hub, turned about z by the renderer.
    sails: merge([
      [box(0.6, 0.6, 0.5), '#4a3526', 0, 0, 0],
      ...[0, 1, 2, 3].flatMap((k) => {
        const a = (k * Math.PI) / 2;
        const out = (r) => [Math.sin(a) * r, Math.cos(a) * r];
        const [sx, sy] = out(3.3);
        const [bx, by] = out(3.3);
        return [
          [box(0.16, 6.2, 0.12), '#4a3526', sx, sy, 0.1, 1, 1, 1, 0, 0, -a],              // the stock
          [box(1.15, 5.0, 0.06), '#d8cfbf', bx + Math.cos(a) * 0.62, by - Math.sin(a) * 0.62, 0.05, 1, 1, 1, 0, 0, -a],  // the cloth
        ];
      }),
    ]),
    windmillHit: merge([
      [cyl(2.6, 2.6, 2.6, 8), '#77706a', 0, -1.1, 0],
      [cyl(1.8, 2.4, 6.0, 8), '#e9e2d2', 0, 3.0, 0],
      [box(1.1, 1.4, 0.4), '#d6cebe', -0.8, 6.4, -1.0, 1, 1, 1, 0.5, 0.2],  // broken edge
      [box(0.9, 1.0, 0.4), '#d6cebe', 1.0, 6.2, -0.6, 1, 1, 1, -0.7, -0.2],
      [box(1.0, 1.9, 0.2), '#4a3526', 0, 0.95, 2.34, 1, 1, 1, 0, -0.12],
      [cone(1.95, 2.4), '#6b4a3a', 1.5, 1.0, -5.2, 1, 1, 1, 0.3, -1.9],    // the cap, fallen off the far side
      [box(0.16, 6.2, 0.12), '#4a3526', -1.8, 0.3, -6.6, 1, 1, 1, 0.9, Math.PI / 2],    // a sail flat on the grass
      [box(1.15, 5.0, 0.06), '#d8cfbf', -1.2, 0.25, -6.9, 1, 1, 1, 0.9, Math.PI / 2],
      [box(0.16, 6.2, 0.12), '#4a3526', 2.6, 0.6, -3.9, 1, 1, 1, -0.5, -1.3],
      rubble(0.3, -3.4, 0.8, '#bdb5a5'),
    ]),
    windmillRuin: merge([
      [cyl(2.6, 2.6, 2.6, 8), '#5d5751', 0, -1.6, 0],
      [cyl(2.1, 2.4, 1.8, 8), '#c4bcab', 0, 0.9, 0],
      [box(0.9, 1.2, 0.4), '#b5ad9c', 0.9, 2.1, -1.3, 1, 1, 1, -0.4, 0.2],
      [box(0.16, 6.2, 0.12), plank, 1.2, 0.3, -4.0, 1, 1, 1, 1.2, Math.PI / 2],
      [box(0.16, 6.2, 0.12), plank, -2.0, 0.35, -3.0, 1, 1, 1, -0.3, Math.PI / 2],
      rubble(-0.6, -3.0, 1.1, '#a39a88'),
    ]),
    tower: merge([
      [box(4.8, 2.6, 4.8), stoneDark, 0, -1.1, 0],
      [box(4.2, 10.0, 4.2), stone, 0, 5.0, 0],
      [box(4.8, 0.5, 4.8), stoneDark, 0, 10.2, 0],
      ...[[-1, -1], [-1, 1], [1, -1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]].map(([u, v]) => [box(1.0, 1.0, 1.0), stone, u * 1.9, 10.95, v * 1.9]),
      [box(0.12, 3.2, 0.12), plank, 1.4, 12.0, 1.4],                       // flagpole
      [box(1.3, 0.8, 0.06), '#b8483a', 2.05, 13.1, 1.4],
      [box(1.0, 2.0, 0.2), '#4a3526', 0, 1.0, 2.15],
      ...[3.6, 6.8].map((y) => [box(0.4, 1.0, 0.2), '#20262c', 0, y, 2.15]),   // arrow slits
    ]),
    towerHit: merge([
      [box(4.8, 2.6, 4.8), stoneDark, 0, -1.1, 0],
      [box(4.2, 6.2, 4.2), stone, 0, 3.1, -0.0],
      [box(4.2, 2.0, 2.0), stone, 0, 7.2, -1.1],                           // the back stands higher
      [box(1.6, 1.4, 1.6), stone, -1.3, 8.9, -1.3, 1, 1, 1, 0.3, 0.2],
      [box(1.2, 1.1, 1.2), stoneDark, 1.5, 6.6, 0.8, 1, 1, 1, 0.6, -0.3],
      [box(1.0, 2.0, 0.2), '#4a3526', 0, 1.0, 2.15],
      [box(1.2, 1.0, 1.0), stone, 1.0, 0.5, -3.6, 1, 1, 1, 0.5],           // blocks tumbled off the far side
      [box(1.0, 1.0, 1.0), stoneDark, -1.5, 0.5, -4.4, 1, 1, 1, 1.1],
      [box(0.9, 0.8, 0.9), stone, 0.2, 0.4, -5.6, 1, 1, 1, 0.3, 0.4],
      rubble(-0.2, -3.4, 0.9),
    ]),
    towerRuin: merge([
      [box(4.8, 2.6, 4.8), stoneDark, 0, -1.6, 0],
      [box(4.2, 1.6, 4.2), stone, 0, 0.8, 0],
      [box(4.2, 1.5, 1.2), stone, 0, 2.3, -1.5],
      [box(1.2, 1.0, 1.0), stone, 1.6, 0.5, -3.4, 1, 1, 1, 0.6],
      [box(1.0, 0.9, 1.0), stoneDark, -1.4, 0.45, -3.9, 1, 1, 1, 1.2],
      [box(0.12, 3.2, 0.12), plank, 2.6, 0.2, -2.4, 1, 1, 1, 0.8, Math.PI / 2],
      rubble(0.2, -2.6, 1.2),
      rubble(-2.6, 0.4, 0.8, '#5a554e'),
    ]),
  };
}

let shared = null;
function assets() {
  if (shared) return shared;
  const cone = (r, h) => new THREE.ConeGeometry(r, h, 7);
  const blob = (r) => new THREE.IcosahedronGeometry(r, 0);
  const geo = {
    pine: merge([
      [new THREE.CylinderGeometry(0.25, 0.38, 2.6, 6), '#5b4230', 0, 1.3, 0],
      [cone(2.3, 4.0), '#2f5a36', 0, 3.8, 0],
      [cone(1.8, 3.4), '#35663c', 0, 5.7, 0],
      [cone(1.2, 2.8), '#3d7343', 0, 7.5, 0],
    ]),
    oak: merge([
      [new THREE.CylinderGeometry(0.3, 0.48, 3.2, 6), '#644a33', 0, 1.6, 0],
      [blob(2.5), '#4f8a3a', 0, 4.9, 0, 1, 0.85, 1],
      [blob(1.8), '#5f9a43', 1.5, 4.2, 0.6, 1, 0.85, 1, 0.7],
      [blob(1.6), '#447a35', -1.2, 4.4, -0.9, 1, 0.85, 1, 1.9],
    ]),
    bush: merge([
      [blob(1), '#5a8a3f', 0, 0.55, 0, 1.25, 0.8, 1.2],
      [blob(0.7), '#6b9a48', 0.9, 0.4, 0.3, 1, 0.8, 1, 1.1],
    ]),
    rock: merge([
      [new THREE.DodecahedronGeometry(1, 0), '#8b8479', 0, 0.3, 0, 1.3, 0.75, 1],
      [new THREE.DodecahedronGeometry(0.5, 0), '#7a746a', 1.1, 0.1, 0.5, 1, 0.8, 1, 0.8],
    ]),
    house: merge([
      [box(7.8, 3.0, 6.2), '#77706a', 0, -1.3, 0],            // foundation, mostly below ground
      [box(7.2, 3.2, 5.6), '#ece4d2', 0, 1.6, 0],             // walls
      [gable(8.0, 2.4, 6.6), '#a5523c', 0, 3.2, 0],           // roof
      [box(1.1, 2.0, 0.2), '#4a3526', 0.9, 1.0, 2.8],         // door
      [box(1.0, 0.9, 0.2), '#2f3b47', -1.8, 1.9, 2.8],        // windows
      [box(1.0, 0.9, 0.2), '#2f3b47', 1.6, 1.9, -2.8],
      [box(1.0, 0.9, 0.2), '#2f3b47', -1.6, 1.9, -2.8],
      [box(0.8, 1.8, 0.8), '#6f5f55', -2.2, 4.6, -1.2],       // chimney
    ]),
    ...buildingModels(cone, blob),
    houseRuin: merge([
      [box(7.8, 3.0, 6.2), '#5d5751', 0, -2.6, 0],
      [box(7.2, 1.1, 0.5), '#8b8376', 0, 0.5, -2.55],
      [box(0.5, 1.9, 3.0), '#7d766b', -3.35, 0.9, -1.0],
      [box(2.4, 0.7, 0.5), '#8b8376', 2.2, 0.3, 2.55],
      [new THREE.DodecahedronGeometry(1.6, 0), '#4a403a', 0.6, 0.1, 0.2, 1.6, 0.4, 1.2],
      [box(3.2, 0.25, 0.4), '#3a2a20', -0.8, 0.75, 0.6, 1, 1, 1, 0.5],
    ]),
    villager: merge([
      [new THREE.SphereGeometry(0.25, 6, 5), '#e8c39e', 0, 1.55, 0],
      [box(0.56, 0.06, 0.56), '#5a4632', 0, 1.76, 0],                           // hat brim
      [box(0.3, 0.16, 0.3), '#5a4632', 0, 1.86, 0],
    ]),
    // An arm, a leg or (scaled up) the tunic, hanging down from its joint at the origin.
    limb: merge([[box(0.15, 0.64, 0.15), '#ffffff', 0, -0.32, 0]]),
    sheep: merge([
      [box(1.3, 0.75, 0.8), '#f2efe6', 0, 0.85, 0],
      [box(0.42, 0.42, 0.42), '#2e2a27', 0.8, 1.05, 0],
      [box(0.16, 0.5, 0.16), '#2e2a27', 0.45, 0.25, 0.25],
      [box(0.16, 0.5, 0.16), '#2e2a27', 0.45, 0.25, -0.25],
      [box(0.16, 0.5, 0.16), '#2e2a27', -0.45, 0.25, 0.25],
      [box(0.16, 0.5, 0.16), '#2e2a27', -0.45, 0.25, -0.25],
    ]),
  };
  const tints = {
    pine: ['#ffffff', '#e4f0df', '#f4f0d8', '#d6e6d6'],
    oak: ['#ffffff', '#f4efc8', '#dcecd0', '#ffe9c2'],
    bush: ['#ffffff', '#f0f0c8', '#d8ead0', '#ffe4c4'],
    rock: ['#ffffff', '#e8e2d6', '#d8d8dc', '#f2ead8'],
    house: ['#ffffff', '#f4e3c4', '#e2d6c8', '#dfe6ea'],
    barn: ['#ffffff', '#f2d6cc', '#e8dcd2', '#ffe6d2'],
    silo: ['#ffffff', '#e8e8f0', '#f2ead8', '#dce4e8'],
    windmill: ['#ffffff', '#f4e8d0', '#e6e0d6', '#eef0f2'],
    tower: ['#ffffff', '#ece4d4', '#dcdcdc', '#e8dccc'],
    sails: ['#ffffff', '#ffffff', '#ffffff', '#ffffff'],
    villager: ['#c9584a', '#4f78c2', '#d9b84e', '#6fa06a'],
    limb: ['#c9584a', '#4f78c2', '#d9b84e', '#6fa06a'],
    sheep: ['#ffffff', '#f2ecdf', '#e6e0d4', '#fff8ea'],
  };
  // A damaged or ruined building keeps its tint.
  for (const k of Object.keys(BUILDINGS)) tints[`${k}Hit`] = tints[`${k}Ruin`] = tints[k];
  for (const k of Object.keys(tints)) tints[k] = tints[k].map((c) => (c.isColor ? c : new THREE.Color(c)));
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0 });

  // Water: a glossy translucent sheet with a slow ripple in its normals. The ripple
  // is several waves in unrelated directions and lengths, bent by a little noise, so
  // the sun's glints never line up into a grid. It fades out with distance, where a
  // fine ripple would only alias.
  const water = new THREE.MeshStandardMaterial({ color: '#2d6f86', transparent: true, opacity: 0.82, roughness: 0.22, metalness: 0.1 });
  const time = { value: 0 };
  water.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWaterP;
uniform float uTime;
float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Slope of one travelling wave along unit direction d.
vec2 wWave(vec2 p, vec2 d, float k, float speed, float amp) { return d * amp * cos(dot(d, p) * k + uTime * speed); }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec2 w = vWaterP.xz;
  vec2 q = w + 5.0 * vec2(wNoise(w * 0.045 + uTime * 0.04), wNoise(w * 0.045 + vec2(7.3, 1.9) - uTime * 0.03));
  vec2 g = wWave(q, vec2(0.80, 0.60), 0.37, 0.9, 1.0)
         + wWave(q, vec2(-0.36, 0.93), 0.61, 1.2, 0.8)
         + wWave(q, vec2(0.97, -0.24), 0.89, 1.5, 0.6)
         + wWave(q, vec2(-0.69, -0.72), 1.31, 1.9, 0.45)
         + wWave(q, vec2(0.17, -0.99), 1.93, 2.3, 0.3);
  g *= 0.6 + 0.8 * wNoise(w * 0.02 - uTime * 0.02);    // calmer and choppier patches
  float fade = clamp(1.0 - length(vViewPosition) / 450.0, 0.1, 1.0);
  vec3 rip = vec3(g.x, 0.0, g.y) * 0.03 * fade;
  normal = normalize(normal + (viewMatrix * vec4(rip, 0.0)).xyz);
}`);
  };
  addFogShade(material, 'props');
  addFogShade(water, 'water');
  shared = { geo, tints, material, water, time };
  return shared;
}

const BUILT = Object.keys(BUILDINGS).flatMap((k) => [k, `${k}Hit`, `${k}Ruin`]);
const STATIC = ['pine', 'oak', 'bush', 'rock', ...BUILT];
const WALKERS = ['villager', 'limb', 'sheep', 'sails'];
const SHADOW = { pine: true, oak: true, bush: true, rock: true, villager: true, limb: true, sheep: true, sails: true };
for (const k of BUILT) SHADOW[k] = true;

// One stand-in for each scenery shader variant (water, a plain mesh such as
// the bridge, instanced props with and without per-instance colour), for the
// shader warm-up at match start. They are never rendered.
export function sceneryStandIns() {
  const a = assets();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const tinted = new THREE.InstancedMesh(box, a.material, 1);
  tinted.setColorAt(0, new THREE.Color(1, 1, 1));
  return [new THREE.Mesh(box, a.water), new THREE.Mesh(box, a.material), new THREE.InstancedMesh(box, a.material, 1), tinted];
}

export class SceneryMesh {
  constructor(scenery) {
    this.scenery = scenery;
    this.group = new THREE.Group();
    this.meshes = {};
    this.seen = -1;
    this.built = null;
    this.relics = new ArtifactMesh(scenery);   // the floating isles' relics
    this.group.add(this.relics.group);
  }

  // Size the instance buffers for the scenery as generated. Called on a full
  // terrain rebuild (each round).
  rebuild() {
    const a = assets();
    const sc = this.scenery;
    this.clear();
    const count = {};
    for (const p of sc.props) count[p.kind] = (count[p.kind] || 0) + 1;
    for (const k of Object.keys(BUILDINGS)) count[`${k}Hit`] = count[`${k}Ruin`] = count[k] || 0;
    count.sails = count.windmill || 0;
    this.mills = [];   // each windmill's matrix while its sails can turn, else null
    for (const w of sc.walkers) count[w.kind] = (count[w.kind] || 0) + 1;
    count.limb = (count.villager || 0) * LIMBS.length;
    for (const kind of [...STATIC, ...WALKERS]) {
      if (!count[kind]) continue;
      const mesh = new THREE.InstancedMesh(a.geo[kind], a.material, count[kind]);
      mesh.castShadow = !!SHADOW[kind];
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;   // instances are spread over the whole field
      this.meshes[kind] = mesh;
      this.group.add(mesh);
    }
    const t = sc.terrain;
    if (t.waterLevel > -Infinity) {
      const geo = new THREE.PlaneGeometry(t.size, t.size);
      geo.rotateX(-Math.PI / 2);
      this.water = new THREE.Mesh(geo, a.water);
      this.water.position.y = t.waterLevel;
      this.water.receiveShadow = true;
      this.water.renderOrder = 1;
      this.group.add(this.water);
    }
    if (sc.bridge) this.buildBridge(sc.bridge);
    this.relics.rebuild();
    this.seen = -1;
    this.sync(0);
  }

  buildBridge(b) {
    const t = this.scenery.terrain;
    const dx = b.b[0] - b.a[0];
    const dz = b.b[1] - b.a[1];
    const span = Math.hypot(dx, dz);
    const len = span + 2;
    const wood = '#8a6a48';
    const dark = '#5e4630';
    const parts = [
      [box(len, 0.35, BRIDGE.width), wood, 0, -0.18, 0],
      [box(len, 0.14, 0.14), dark, 0, 1.0, BRIDGE.width / 2 - 0.1],
      [box(len, 0.14, 0.14), dark, 0, 1.0, -BRIDGE.width / 2 + 0.1],
    ];
    for (let x = -len / 2 + 0.3; x <= len / 2; x += 2.6) {
      parts.push([box(0.16, 1.0, 0.16), dark, x, 0.5, BRIDGE.width / 2 - 0.1]);
      parts.push([box(0.16, 1.0, 0.16), dark, x, 0.5, -BRIDGE.width / 2 + 0.1]);
    }
    // Piers stand on the bed under the deck.
    const n = Math.max(1, Math.round(span / BRIDGE.pierEvery));
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      const drop = b.y - t.heightAt(b.a[0] + dx * u, b.a[1] + dz * u) + 1.5;
      const x = (u - 0.5) * span;
      for (const z of [-1, 1]) parts.push([box(0.5, drop, 0.5), dark, x, -drop / 2, z * (BRIDGE.width / 2 - 0.35)]);
      parts.push([box(0.3, 0.3, BRIDGE.width), dark, x, -0.5, 0]);
    }
    this.bridge = new THREE.Mesh(merge(parts), assets().material);
    this.bridge.position.set((b.a[0] + b.b[0]) / 2, b.y, (b.a[1] + b.b[1]) / 2);
    this.bridge.rotation.y = -Math.atan2(dz, dx);
    this.bridge.castShadow = true;
    this.bridge.receiveShadow = true;
    this.group.add(this.bridge);
  }

  writeStatic() {
    const a = assets();
    const sc = this.scenery;
    const next = {};
    const put = (kind, matrix, tint) => {
      const mesh = this.meshes[kind];
      const i = next[kind] = (next[kind] ?? -1) + 1;
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, a.tints[kind][tint]);
    };
    let mill = 0;
    for (const p of sc.props) {
      const gone = p.state === 'gone';
      if (isBuilding(p)) {
        const whole = p.state === 'ok';
        // The broken side faces the blow; the lean tips it away.
        Q.setFromAxisAngle(UP, whole ? p.rot : (p.face ?? p.rot));
        const lean = p.state === 'ruin' || !p.lean ? 0 : Math.hypot(p.lean[0], p.lean[1]);
        if (lean > 1e-4) Q.premultiply(Q2.setFromAxisAngle(AXIS.set(p.lean[1] / lean, 0, -p.lean[0] / lean), lean));
        M.compose(P.set(p.x, p.y, p.z), Q, S.setScalar(p.scale));
        put(p.kind, whole ? M : HIDDEN, p.tint);
        put(`${p.kind}Hit`, p.state === 'hit' ? M : HIDDEN, p.tint);
        put(`${p.kind}Ruin`, p.state === 'ruin' ? M : HIDDEN, p.tint);
        if (p.kind === 'windmill') this.mills[mill++] = whole ? M.clone() : null;
        continue;
      }
      Q.setFromAxisAngle(UP, p.rot);
      let lift = 0;
      if (p.state === 'fallen') {
        // Tip the trunk over, away from whatever knocked it down.
        AXIS.set(Math.sin(p.fall), 0, -Math.cos(p.fall));
        Q.premultiply(Q2.setFromAxisAngle(AXIS, 1.44));
        lift = 0.35 * p.scale;
      }
      M.compose(P.set(p.x, p.y + lift, p.z), Q, S.setScalar(p.scale));
      put(p.kind, gone ? HIDDEN : M, p.tint);
    }
    for (const kind of STATIC) {
      const mesh = this.meshes[kind];
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (this.bridge) this.bridge.visible = !!(sc.bridge && sc.bridge.alive);
  }

  // `time` in seconds drives the water ripple, the villagers' stride and the
  // sheep's hop.
  sync(time) {
    const a = assets();
    const sc = this.scenery;
    a.time.value = time;
    this.relics.sync(time);
    if (this.seen !== sc.version) {
      this.seen = sc.version;
      this.writeStatic();
    }
    const sails = this.meshes.sails;
    if (sails) {
      this.mills.forEach((m, i) => {
        if (!m) { sails.setMatrixAt(i, HIDDEN); return; }
        SAIL.compose(HUB, Q2.setFromAxisAngle(Z_AXIS, time * 0.8 + i * 1.3), ONE).premultiply(m);
        sails.setMatrixAt(i, SAIL);
      });
      if (!sails.userData.tinted) { for (let i = 0; i < this.mills.length; i++) sails.setColorAt(i, a.tints.sails[0]); sails.userData.tinted = true; }
    }
    const next = {};
    for (const w of sc.walkers) {
      const mesh = this.meshes[w.kind];
      if (!mesh) continue;
      const i = next[w.kind] = (next[w.kind] ?? -1) + 1;
      const limbs = w.kind === 'villager' ? this.meshes.limb : null;
      if (!w.alive) {
        mesh.setMatrixAt(i, HIDDEN);
        if (limbs) for (let k = 0; k < LIMBS.length; k++) limbs.setMatrixAt(i * LIMBS.length + k, HIDDEN);
        continue;
      }
      const flee = w.mode === 'flee';
      const moving = w.mode !== 'idle';
      Q.setFromAxisAngle(UP, -w.heading);
      if (w.kind === 'sheep') {
        // Trot in little hops, rocking nose to tail; graze with the head down when still.
        const phase = time * (flee ? 15 : 6) + i * 1.9;
        const hop = moving ? Math.abs(Math.sin(phase)) * (flee ? 0.34 : 0.14) : 0;
        const pitch = moving ? Math.cos(phase * 2) * (flee ? 0.16 : 0.07) : -0.2 * Math.max(0, Math.sin(time * 0.35 + i * 2.3));
        Q.multiply(Q2.setFromAxisAngle(AXIS.set(0, 0, 1), pitch));
        M.compose(P.set(w.x, w.y + hop, w.z), Q, S.setScalar(1.2));
        mesh.setMatrixAt(i, M);
      } else {
        // Stride: legs scissor, arms swing against them; arms go up when running away.
        const phase = time * (flee ? 15 : 7.5) + i * 2.1;
        const bob = moving ? Math.abs(Math.cos(phase)) * (flee ? 0.09 : 0.05) : 0;
        BODY.compose(P.set(w.x, w.y + bob, w.z), Q, S.setScalar(VILLAGER_SCALE));
        mesh.setMatrixAt(i, BODY);
        const stride = moving ? Math.sin(phase) * (flee ? 0.95 : 0.6) : 0;
        LIMBS.forEach(([lx, ly, lz, dir, kind], k) => {
          const arm = kind === 1;
          let angle = stride * dir * (arm ? 0.8 : 1);
          if (arm && flee) angle = 2.7 + Math.sin(phase * 1.3 + k) * 0.35;
          else if (arm && !moving) angle = Math.sin(time * 1.1 + i + k) * 0.05;
          LIMB.compose(P.set(lx, ly, lz), Q2.setFromAxisAngle(AXIS.set(0, 0, 1), angle), kind === 2 ? TUNIC : ONE);
          LIMB.premultiply(BODY);
          limbs.setMatrixAt(i * LIMBS.length + k, LIMB);
          if (!limbs.userData.tinted) limbs.setColorAt(i * LIMBS.length + k, kind ? a.tints.limb[w.tint] : LEG_COLOUR);
        });
      }
      if (!mesh.userData.tinted) mesh.setColorAt(i, w.kind === 'villager' ? WHITE : a.tints[w.kind][w.tint]);
    }
    for (const kind of WALKERS) {
      const mesh = this.meshes[kind];
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (!mesh.userData.tinted && mesh.instanceColor) { mesh.instanceColor.needsUpdate = true; mesh.userData.tinted = true; }
    }
  }

  clear() {
    for (const mesh of Object.values(this.meshes)) { this.group.remove(mesh); mesh.dispose(); }
    this.meshes = {};
    if (this.water) { this.group.remove(this.water); this.water.geometry.dispose(); this.water = null; }
    if (this.bridge) { this.group.remove(this.bridge); this.bridge.geometry.dispose(); this.bridge = null; }
    this.relics.clear();
  }

  dispose() { this.clear(); }
}
