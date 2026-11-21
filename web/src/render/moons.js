import * as THREE from 'three';
import { makePerlin } from '../core/noise.js';

// The floating isles' moons (core/terrain.js `wells`): small cratered rocks
// hanging in the sky, each with a faint glow out to where its pull starts to
// tell on a shell, and a few pebbles circling it to show which way it pulls.

const ROCK = new THREE.Color('#9a8fa6');
const ROCK_DARK = new THREE.Color('#5e5570');
const GLOW = new THREE.Color('#9db8ff');
const PEBBLES = 5;

// A lumpy, cratered unit ball, flat shaded.
function moonGeometry(seed) {
  const geo = new THREE.IcosahedronGeometry(1, 4);
  const noise = makePerlin(seed);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  // A few craters: dents with a raised lip.
  const craters = Array.from({ length: 7 }, (_, i) => {
    const a = noise(i * 3.1, 0.5) * Math.PI * 2 + i;
    const b = Math.acos(Math.max(-1, Math.min(1, noise(0.7, i * 2.3) * 1.6)));
    return { dir: new THREE.Vector3(Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)), r: 0.25 + 0.2 * Math.abs(noise(i, i)) };
  });
  for (let k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k).normalize();
    let h = 1 + 0.08 * noise(v.x * 2.5 + v.z, v.y * 2.5 + 4) + 0.04 * noise(v.x * 6, v.z * 6 + v.y);
    let shade = 0.5 + 0.5 * noise(v.x * 3 + 7, v.y * 3 - v.z);
    for (const cr of craters) {
      const d = v.angleTo(cr.dir) / cr.r;
      if (d < 1) { h -= 0.07 * (1 - d * d); shade *= 0.8; } else if (d < 1.35) h += 0.025 * (1 - (d - 1) / 0.35);
    }
    v.multiplyScalar(h);
    pos.setXYZ(k, v.x, v.y, v.z);
    c.copy(ROCK_DARK).lerp(ROCK, Math.max(0, Math.min(1, shade)));
    col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

// A soft rim glow: brightest at the edge of the sphere as seen, fading inward.
const glowMaterial = () => new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.BackSide,
  uniforms: { color: { value: GLOW }, strength: { value: 0.55 } },
  vertexShader: `varying vec3 vN; varying vec3 vV;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `uniform vec3 color; uniform float strength; varying vec3 vN; varying vec3 vV;
    void main() {
      float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
      float a = pow(1.0 - f, 2.2) * strength;
      gl_FragColor = vec4(color * a, a);
    }`,
});

export class Moons {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: true });
    this.pebbleGeo = new THREE.DodecahedronGeometry(1, 0);
    this.pebbleMat = new THREE.MeshStandardMaterial({ color: '#8a8096', roughness: 1, flatShading: true });
    this.items = [];
    this.key = '';
  }

  // Show these wells (or none). Rebuilt only when they change.
  set(wells = []) {
    const key = wells.map((w) => `${w.x.toFixed(2)},${w.y.toFixed(2)},${w.z.toFixed(2)},${w.r.toFixed(2)}`).join('|');
    if (key === this.key) return;
    this.key = key;
    this.clear();
    wells.forEach((w, i) => {
      const root = new THREE.Group();
      root.position.set(w.x, w.y, w.z);
      const rock = new THREE.Mesh(moonGeometry(Math.round(w.x * 13 + w.z * 7 + i)), this.material);
      rock.scale.setScalar(w.r);
      rock.castShadow = true;
      rock.receiveShadow = true;
      // The glow reaches out to where the pull is about a quarter of the ground's gravity.
      const reach = Math.min(Math.sqrt(w.mu / 2.5), w.r * 6);
      const glow = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), glowMaterial());
      glow.scale.setScalar(reach);
      const halo = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), glowMaterial());
      halo.material.uniforms.strength.value = 0.9;
      halo.scale.setScalar(w.r * 1.35);
      const pebbles = new THREE.InstancedMesh(this.pebbleGeo, this.pebbleMat, PEBBLES);
      pebbles.frustumCulled = false;
      root.add(rock, glow, halo, pebbles);
      this.group.add(root);
      const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3 + i * 0.4, i * 1.7, 0.2 * i));
      const orbits = Array.from({ length: PEBBLES }, (_, k) => ({
        r: w.r * (1.6 + 0.35 * k), speed: (0.5 - 0.06 * k) * (i % 2 ? -1 : 1), phase: k * 2.1 + i, size: 0.5 + 0.25 * (k % 3),
      }));
      this.items.push({ root, rock, glow, halo, pebbles, tilt, orbits, spin: 0.05 + 0.03 * i });
    });
  }

  clear() {
    for (const m of this.items) {
      this.group.remove(m.root);
      m.rock.geometry.dispose();
      m.glow.geometry.dispose(); m.glow.material.dispose();
      m.halo.geometry.dispose(); m.halo.material.dispose();
      m.pebbles.dispose();
    }
    this.items = [];
  }

  update(time) {
    const M = MAT;
    for (const m of this.items) {
      m.rock.rotation.y = time * m.spin;
      m.orbits.forEach((o, k) => {
        const a = o.phase + time * o.speed;
        P.set(Math.cos(a) * o.r, Math.sin(a * 1.3) * o.r * 0.12, Math.sin(a) * o.r).applyQuaternion(m.tilt);
        Q.setFromEuler(E.set(a, a * 0.7, 0));
        M.compose(P, Q, S.setScalar(o.size));
        m.pebbles.setMatrixAt(k, M);
      });
      m.pebbles.instanceMatrix.needsUpdate = true;
    }
  }
}

const MAT = new THREE.Matrix4();
const P = new THREE.Vector3();
const Q = new THREE.Quaternion();
const S = new THREE.Vector3();
const E = new THREE.Euler();
