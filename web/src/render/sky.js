import * as THREE from 'three';
import { groundShade, MAX_CLOUD_SHADOWS } from './terrainMesh.js';
import { setLook } from './timeofday.js';

// Sky dome, sun, sky light, fog and clouds. The sun crosses the sky over a
// match: `setDay(0)` is the match's start, `setDay(1)` its end. What the sky,
// light, fog, shadows and water look like comes from the match's time of day
// (render/timeofday.js, set with `setTime`): Dawn, Day (late morning to a golden
// afternoon), Dusk or Night.

const DEG = Math.PI / 180;
const FOG_SPACE = new THREE.Color('#b4d4f2');   // the isles' own fog colour, whatever the time

// One time's keyframe hexes as Colors, made once per time and kept.
const KEYS = ['sun', 'sky', 'ground', 'top', 'mid', 'horizon', 'cloud', 'fog'];
const kfCache = new Map();
function keyframes(p) {
  if (!kfCache.has(p.id)) {
    const make = (f) => Object.fromEntries(KEYS.map((k) => [k, new THREE.Color(f[k])]));
    kfCache.set(p.id, { a: make(p.a), b: make(p.b), glow: new THREE.Color(p.glow), bottom: new THREE.Color(p.bottom), water: new THREE.Color(p.water) });
  }
  return kfCache.get(p.id);
}
const WET_C = new THREE.Color();   // a Rain round's grey, dimmed for the time of day
// The floating isles hang in open space: a dark sky with a violet glow low
// down, stars all round (below as well), and a ringed planet.
const SPACE = {
  skyLight: new THREE.Color('#aab8ff'), groundLight: new THREE.Color('#a68fd2'),
  top: new THREE.Color('#03040d'), mid: new THREE.Color('#0b0d26'), horizon: new THREE.Color('#2a1f4d'), bottom: new THREE.Color('#05061a'),
  sun: new THREE.Color('#fff4e6'),
};
// The Ridgeline (render/ridgeline.js): a clear dusk, deep blue overhead
// through violet to a wide warm band at the horizon, and a low sun from the
// south-west that rakes across the ridges. No clouds: the profile stays crisp.
const RIDGE = {
  sun: new THREE.Color('#ffd0a0'), skyLight: new THREE.Color('#a4a8e8'), groundLight: new THREE.Color('#6e4034'),
  top: new THREE.Color('#141a44'), mid: new THREE.Color('#5b3f7e'), horizon: new THREE.Color('#f39a5c'), bottom: new THREE.Color('#4a2c3c'),
  dir: new THREE.Vector3(-0.62, 0.36, 0.7).normalize(), band: 0.42, fog: new THREE.Color('#c98670'),
};
// A Rain round (render/rain.js): the day's colours lean toward these by the
// rain's amount, the sun dims and the fog closes in.
const WET = {
  skyLight: new THREE.Color('#b4bcc6'), groundLight: new THREE.Color('#4e4a44'),
  top: new THREE.Color('#4f5c6c'), mid: new THREE.Color('#7f8b98'), horizon: new THREE.Color('#a9b0b8'), cloud: new THREE.Color('#8d959e'),
  mix: 0.7, sun: 0.5, fogNear: 260, fogFar: 1500,
};
const FOG = { near: 700, far: 2600 };   // the isles' and the ridgeline's fog distances
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
    this.horizon = new THREE.Color('#b4d4f2');
    scene.fog = new THREE.Fog(this.horizon, FOG.near, FOG.far);
    this.fog = scene.fog;
    this.wet = 0;                 // 0..1, how much a Rain round greys the day (setWeather)

    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(4500, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          top: { value: new THREE.Color('#1c63e8') },
          mid: { value: new THREE.Color('#6fa8ee') },
          horizon: { value: this.horizon },
          bottom: { value: new THREE.Color('#a39276') },
          sun: { value: this.sunDir },
          glow: { value: new THREE.Color('#ffd99a') },
          space: { value: 0 },
          band: { value: 0.16 },
        },
        vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 sun; uniform vec3 glow; uniform float space; uniform float band; varying vec3 vDir;
          float sh(vec3 p) { p = fract(p * 0.3183 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
          float sn(vec3 p) {
            vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(mix(sh(i), sh(i + vec3(1,0,0)), f.x), mix(sh(i + vec3(0,1,0)), sh(i + vec3(1,1,0)), f.x), f.y),
                       mix(mix(sh(i + vec3(0,0,1)), sh(i + vec3(1,0,1)), f.x), mix(sh(i + vec3(0,1,1)), sh(i + vec3(1,1,1)), f.x), f.y), f.z);
          }
          void main(){
            float h = vDir.y;
            if (space > 0.5) {
              // Deep space: a violet band low all round, darker overhead and
              // underfoot, and drifting nebula clouds.
              vec3 c = mix(horizon, h > 0.0 ? top : bottom, pow(min(1.0, abs(h) * 1.6), 0.6));
              float n = sn(vDir * 3.0) * 0.55 + sn(vDir * 7.0) * 0.3 + sn(vDir * 15.0) * 0.15;
              float neb = smoothstep(0.5, 0.9, n) * (0.6 + 0.4 * sn(vDir * 2.0 + 5.0));
              c += mix(vec3(0.30, 0.10, 0.42), vec3(0.08, 0.22, 0.45), sn(vDir * 1.5 + 2.0)) * neb * 0.3;
              float s = max(dot(vDir, sun), 0.0);
              c += vec3(1.0, 0.95, 0.85) * (pow(s, 900.0) * 6.0 + pow(s, 40.0) * 0.18);
              gl_FragColor = vec4(c, 1.0);
              #include <tonemapping_fragment>
              #include <colorspace_fragment>
              return;
            }
            // Three stops: the horizon colour is a narrow band over the hills,
            // then clear blue. Blending a warm horizon straight into the deep
            // top made a wide lavender-grey wash, and the camera mostly looks
            // at those first few degrees of sky.
            vec3 c = h > 0.0
              ? mix(mix(horizon, mid, smoothstep(0.0, band, h)), top, smoothstep(band * 0.5, 0.85, h))
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

    this.hemi = new THREE.HemisphereLight('#cfe1ff', '#6b5638', 0.8);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff0d8', 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.8;
    this.sun.target.position.set(0, 20, 0);
    scene.add(this.sun, this.sun.target);
    this.probe = new THREE.Object3D();

    this.buildClouds(scene);
    this.buildSpace(scene);
    this.space = false;
    this.ridge = false;
    this.setTime('day');
  }

  // The match's time of day ('dawn', 'day', 'dusk' or 'night'): the sky,
  // light, fog, shadows, water and the lights that come on in the dark all
  // follow it. Called when a match starts, and with 'day' for the menu.
  setTime(id) {
    this.tod = setLook(id);
    this.kf = keyframes(this.tod);
    this.syncStars();
    const d = this.day;
    this.day = -1;
    this.setDay(d < 0 ? 0 : d);
  }

  // Stars over the isles always, and over the meadows on a night.
  syncStars() {
    this.stars.visible = this.space || (this.tod.stars && !this.ridge);
  }

  // Stars and a ringed planet, shown only over the floating isles.
  buildSpace(scene) {
    const n = 2400;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos.set([Math.cos(a) * r * 4000, u * 4000, Math.sin(a) * r * 4000], i * 3);
      c.setHSL(0.55 + Math.random() * 0.2 - (Math.random() < 0.2 ? 0.5 : 0), 0.5, 0.6 + Math.random() * 0.4).multiplyScalar(0.4 + Math.random() ** 3 * 1.2);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(geo, new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }));
    this.stars.frustumCulled = false;
    this.stars.visible = false;
    this.dome.renderOrder = -2;   // the stars draw over the dome, which writes no depth
    const planet = new THREE.Group();
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(380, 48, 24),
      new THREE.MeshStandardMaterial({ color: '#c08a6a', roughness: 1, fog: false, emissive: '#2a1830', emissiveIntensity: 0.6 }),
    );
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(520, 760, 96, 1),
      new THREE.MeshBasicMaterial({ color: '#d9c3a6', transparent: true, opacity: 0.45, side: THREE.DoubleSide, fog: false, depthWrite: false }),
    );
    ring.rotation.x = Math.PI / 2 - 0.35;
    ring.rotation.y = 0.25;
    planet.add(ball, ring);
    planet.position.set(-1900, 900, -2600);
    planet.visible = false;
    this.planet = planet;
    scene.add(this.stars, planet);
  }

  // Over the floating isles (true) or the meadows (false).
  setSpace(on) {
    if (on === this.space) return;
    this.space = on;
    this.planet.visible = on;
    this.syncStars();
    this.cloudMesh.visible = !on && !this.ridge;
    if (on) for (let i = 0; i < MAX_CLOUD_SHADOWS; i++) groundShade.clouds.value[i].z = 0;
    const d = this.day;
    this.day = -1;
    this.setDay(d < 0 ? 0 : d);
  }

  // Over a ridgeline (true) or not.
  setRidge(on) {
    if (on === this.ridge) return;
    this.ridge = on;
    this.cloudMesh.visible = !on && !this.space;
    if (on) for (let i = 0; i < MAX_CLOUD_SHADOWS; i++) groundShade.clouds.value[i].z = 0;
    this.syncStars();
    const d = this.day;
    this.day = -1;
    this.setDay(d < 0 ? 0 : d);
  }

  // Rain (render/rain.js amount, 0..1): a greyer, dimmer sky and closer fog.
  setWeather(k) {
    k = Math.max(0, Math.min(1, k));
    if (Math.abs(k - this.wet) < 0.004 && (k > 0 || this.wet === 0)) return;
    this.wet = k;
    const d = this.day;
    this.day = -1;
    this.setDay(d < 0 ? 0 : d);
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
      color: new THREE.Color('#ffffff'), roughness: 1, flatShading: true, fog: false,
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
    const T = this.tod, { a, b } = this.kf;
    const elev = (T.elev[0] + (T.elev[1] - T.elev[0]) * k ** 1.4) * DEG;
    const azim = T.azim[0] + T.azim[1] * k;
    this.sunDir.set(Math.cos(azim) * Math.cos(elev), Math.sin(elev), Math.sin(azim) * Math.cos(elev));
    const w = THREE.MathUtils.smoothstep(k, 0.35, 1);
    this.sun.color.lerpColors(a.sun, b.sun, w);
    this.sun.intensity = T.a.sunI + (T.b.sunI - T.a.sunI) * w;
    this.sun.shadow.intensity = T.shadow;
    this.hemi.color.lerpColors(a.sky, b.sky, w);
    this.hemi.groundColor.lerpColors(a.ground, b.ground, w);
    this.hemi.intensity = T.a.hemiI + (T.b.hemiI - T.a.hemiI) * w;
    this.dome.material.uniforms.top.value.lerpColors(a.top, b.top, w);
    this.dome.material.uniforms.mid.value.lerpColors(a.mid, b.mid, w);
    this.horizon.lerpColors(a.horizon, b.horizon, w);
    this.cloudMaterial.color.lerpColors(a.cloud, b.cloud, w);
    const U = this.dome.material.uniforms;
    U.space.value = this.space ? 1 : 0;
    U.bottom.value.copy(this.space ? SPACE.bottom : this.kf.bottom);
    U.glow.value.copy(this.kf.glow);
    U.band.value = this.ridge ? RIDGE.band : 0.16;
    // The Ridgeline's own look is a dusk: on a Dusk match it keeps that one, and
    // on the other times it takes the time's sky (with its own wide horizon band).
    if (this.ridge && !this.space && T.id === 'dusk') {
      // Dusk all match long: the sun holds low in the south-west.
      this.sunDir.copy(RIDGE.dir);
      this.sun.color.copy(RIDGE.sun);
      this.sun.intensity = 2.5;
      this.hemi.color.copy(RIDGE.skyLight);
      this.hemi.groundColor.copy(RIDGE.groundLight);
      this.hemi.intensity = 0.95;
      U.top.value.copy(RIDGE.top);
      U.mid.value.copy(RIDGE.mid);
      U.bottom.value.copy(RIDGE.bottom);
      this.horizon.copy(RIDGE.horizon);
    }
    if (this.space) {
      // The sun still swings round, but space keeps its own colours.
      this.sun.color.copy(SPACE.sun);
      this.sun.intensity = 2.4;
      this.hemi.color.copy(SPACE.skyLight);
      this.hemi.groundColor.copy(SPACE.groundLight);
      this.hemi.intensity = 1.0;   // the undersides see only this light (its ground colour, a violet bounce)
      U.top.value.copy(SPACE.top);
      U.mid.value.copy(SPACE.mid);
      this.horizon.copy(SPACE.horizon);
      this.sun.shadow.intensity = 1;
    }
    const r = this.space ? 0 : this.wet;
    if (r > 0) {
      // The Rain round's greys, as bright as the time of day lets them be.
      const m = r * WET.mix, wet = T.wet;
      this.sun.intensity *= 1 - WET.sun * r;
      this.hemi.intensity *= 1 - 0.15 * r;
      this.hemi.color.lerp(WET_C.copy(WET.skyLight).multiplyScalar(wet), m);
      this.hemi.groundColor.lerp(WET_C.copy(WET.groundLight).multiplyScalar(wet), m);
      U.top.value.lerp(WET_C.copy(WET.top).multiplyScalar(wet), m);
      U.mid.value.lerp(WET_C.copy(WET.mid).multiplyScalar(wet), m);
      this.horizon.lerp(WET_C.copy(WET.horizon).multiplyScalar(wet), m);
      this.cloudMaterial.color.lerp(WET_C.copy(WET.cloud).multiplyScalar(wet), m);
    }
    this.cloudMaterial.emissiveIntensity = (this.space ? 0.6 : T.cloudGlow) * (1 - 0.6 * r);
    // The fog: the time's own colour and distances over the meadows (and the
    // ridgeline), the old ones over the isles and a Dusk ridgeline. Rain greys
    // and closes it in.
    const own = this.space || (this.ridge && T.id === 'dusk');
    const fc = this.fog.color;
    if (this.space) fc.copy(FOG_SPACE);
    else if (own) fc.copy(RIDGE.fog);
    else fc.lerpColors(a.fog, b.fog, w);
    if (r > 0) fc.lerp(WET_C.copy(WET.horizon).multiplyScalar(T.wet), r * 0.85);
    const near = own ? FOG.near : T.fogNear, far = own ? FOG.far : T.fogFar;
    this.fog.near = near + (Math.min(near, WET.fogNear) - near) * r;
    this.fog.far = far + (Math.min(far, WET.fogFar) - far) * r;
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
    if (this.space || this.ridge) {
      for (let i = 0; i < MAX_CLOUD_SHADOWS; i++) groundShade.clouds.value[i].z = 0;
      return;
    }
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
