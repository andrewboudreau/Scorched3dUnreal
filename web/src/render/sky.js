import * as THREE from 'three';
import { groundShade, MAX_CLOUD_SHADOWS } from './terrainMesh.js';

// Sky dome, sun, sky light, fog and clouds. The sun crosses the sky over a
// match: `setDay(0)` is late morning, `setDay(1)` a golden late afternoon. It
// never gets dark; only the direction and the warmth of the light change.

const DAY = {
  sun: new THREE.Color('#fff0d8'), skyLight: new THREE.Color('#cfe1ff'), groundLight: new THREE.Color('#6b5638'),
  top: new THREE.Color('#1c63e8'), mid: new THREE.Color('#6fa8ee'), horizon: new THREE.Color('#b4d4f2'), cloud: new THREE.Color('#ffffff'),
};
const GOLD = {
  sun: new THREE.Color('#ffc078'), skyLight: new THREE.Color('#ffdcc0'), groundLight: new THREE.Color('#70503a'),
  top: new THREE.Color('#2a62d0'), mid: new THREE.Color('#86b2e6'), horizon: new THREE.Color('#f8c890'), cloud: new THREE.Color('#ffe6c8'),
};
const CLOUD_SPAN = 1500;

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const P = new THREE.Vector3();
const S = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Sky {
  constructor(scene) {
    this.day = -1;
    this.half = 400;
    this.sunDir = new THREE.Vector3(0.55, 0.62, 0.35).normalize();
    this.horizon = DAY.horizon.clone();
    scene.fog = new THREE.Fog(this.horizon, 700, 2600);

    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(4500, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          top: { value: DAY.top.clone() },
          mid: { value: DAY.mid.clone() },
          horizon: { value: this.horizon },
          bottom: { value: new THREE.Color('#a39276') },
          sun: { value: this.sunDir },
          glow: { value: new THREE.Color('#ffd99a') },
        },
        vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 sun; uniform vec3 glow; varying vec3 vDir;
          void main(){
            float h = vDir.y;
            // Three stops: the horizon colour is a narrow band over the hills,
            // then clear blue. Blending a warm horizon straight into the deep
            // top made a wide lavender-grey wash, and the camera mostly looks
            // at those first few degrees of sky.
            vec3 c = h > 0.0
              ? mix(mix(horizon, mid, smoothstep(0.0, 0.16, h)), top, smoothstep(0.08, 0.85, h))
              : mix(horizon, bottom, pow(-h, 0.4));
            float s = max(dot(vDir, sun), 0.0);
            c += glow * (pow(s, 600.0) * 4.0 + pow(s, 12.0) * 0.25 + pow(s, 3.0) * 0.08);
            gl_FragColor = vec4(c, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    scene.add(this.dome);

    this.hemi = new THREE.HemisphereLight(DAY.skyLight, DAY.groundLight, 0.8);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(DAY.sun, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.8;
    this.sun.target.position.set(0, 20, 0);
    scene.add(this.sun, this.sun.target);
    this.probe = new THREE.Object3D();

    this.buildClouds(scene);
    this.setDay(0);
  }

  // Low-poly clouds: every cloud is a handful of flattened blobs, and all the
  // blobs of all the clouds are one InstancedMesh.
  buildClouds(scene) {
    const rand = (a, b) => a + Math.random() * (b - a);
    this.clouds = [];
    let blobs = 0;
    for (let i = 0; i < 14; i++) {
      const size = rand(55, 120);
      const parts = [];
      const n = 4 + Math.floor(Math.random() * 3);
      for (let k = 0; k < n; k++) {
        const u = n === 1 ? 0 : k / (n - 1) - 0.5;
        const r = size * (0.55 - Math.abs(u) * 0.5) * rand(0.85, 1.2);
        parts.push({ x: u * size * 1.9 + rand(-8, 8), y: r * 0.22 + rand(-3, 3), z: rand(-0.3, 0.3) * size, r, turn: rand(0, 6.28) });
      }
      this.clouds.push({ x: rand(-CLOUD_SPAN, CLOUD_SPAN), y: rand(210, 360), z: rand(-CLOUD_SPAN, CLOUD_SPAN), size, parts, pace: rand(0.8, 1.2) });
      blobs += n;
    }
    this.cloudMaterial = new THREE.MeshStandardMaterial({
      color: DAY.cloud.clone(), roughness: 1, flatShading: true, fog: false,
      emissive: '#c3d3e6', emissiveIntensity: 0.6,
    });
    this.cloudMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), this.cloudMaterial, blobs);
    this.cloudMesh.frustumCulled = false;
    scene.add(this.cloudMesh);
  }

  // The shadow camera is fitted to the playfield (`half` its half-width) so
  // the whole map is shadowed and no texel is spent outside it.
  fit(half) {
    this.half = half;
    this.place();
  }

  setDay(k) {
    if (this.frozen) return;      // a sky from the pack review (src/review.js) holds the light
    k = Math.max(0, Math.min(1, k));
    if (Math.abs(k - this.day) < 0.0004) return;
    this.day = k;
    const elev = (58 - 34 * k ** 1.4) * (Math.PI / 180);
    const azim = 0.45 + 2.0 * k;
    this.sunDir.set(Math.cos(azim) * Math.cos(elev), Math.sin(elev), Math.sin(azim) * Math.cos(elev));
    const w = THREE.MathUtils.smoothstep(k, 0.35, 1);
    this.sun.color.lerpColors(DAY.sun, GOLD.sun, w);
    this.sun.intensity = 2.2 - 0.15 * w;
    this.hemi.color.lerpColors(DAY.skyLight, GOLD.skyLight, w);
    this.hemi.groundColor.lerpColors(DAY.groundLight, GOLD.groundLight, w);
    this.hemi.intensity = 0.8 + 0.12 * w;
    this.dome.material.uniforms.top.value.lerpColors(DAY.top, GOLD.top, w);
    this.dome.material.uniforms.mid.value.lerpColors(DAY.mid, GOLD.mid, w);
    this.horizon.lerpColors(DAY.horizon, GOLD.horizon, w);
    this.cloudMaterial.color.lerpColors(DAY.cloud, GOLD.cloud, w);
    this.place();
  }

  place() {
    const sun = this.sun;
    const target = sun.target.position;
    sun.position.copy(this.sunDir).multiplyScalar(1000).add(target);
    // Box the playfield in light space.
    const probe = this.probe;
    probe.position.copy(sun.position);
    probe.lookAt(target);
    probe.updateMatrix();
    M.copy(probe.matrix).invert();
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
    const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const h = this.half + 12;
    for (const x of [-h, h]) for (const y of [-70, 190]) for (const z of [-h, h]) {
      P.set(x, y, z).applyMatrix4(M);
      lo.min(P);
      hi.max(P);
    }
    const cam = sun.shadow.camera;
    // Object3D.lookAt points +z at the target for a non-camera; a camera looks down -z.
    cam.left = -hi.x; cam.right = -lo.x; cam.bottom = lo.y; cam.top = hi.y;
    cam.near = Math.max(1, lo.z - 20); cam.far = hi.z + 20;
    cam.updateProjectionMatrix();
  }

  update(dt, wind) {
    if (this.frozen) return;      // an HDRI sky from the pack review: no clouds
    const mesh = this.cloudMesh;
    const sx = this.sunDir.x / this.sunDir.y;
    const sz = this.sunDir.z / this.sunDir.y;
    let i = 0;
    this.clouds.forEach((c, n) => {
      c.x += (3 + wind[0] * 8) * c.pace * dt;
      c.z += (1.2 + wind[1] * 8) * c.pace * dt;
      if (c.x > CLOUD_SPAN) c.x -= CLOUD_SPAN * 2; else if (c.x < -CLOUD_SPAN) c.x += CLOUD_SPAN * 2;
      if (c.z > CLOUD_SPAN) c.z -= CLOUD_SPAN * 2; else if (c.z < -CLOUD_SPAN) c.z += CLOUD_SPAN * 2;
      for (const b of c.parts) {
        M.compose(P.set(c.x + b.x, c.y + b.y, c.z + b.z), Q.setFromAxisAngle(UP, b.turn), S.set(b.r, b.r * 0.5, b.r * 0.8));
        mesh.setMatrixAt(i++, M);
      }
      // Where its shadow falls on ground about 15 m up.
      if (n < MAX_CLOUD_SHADOWS) groundShade.clouds.value[n].set(c.x - sx * (c.y - 15), c.z - sz * (c.y - 15), c.size * 1.15);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }
}
