// What each time of day looks like (the match config's `time`, core/timeofday.js).
// Plain data, no three.js: render/sky.js reads it for the light, sky, fog and
// shadows, render/sceneryMesh.js for the water and the village windows,
// render/effects.js for how hard a blast flashes, render/tankMesh.js and
// render/cityMesh.js for the lights that come on in the dark.
//
// A time has two keyframes, `a` (the match's first round) and `b` (its last);
// the sky eases from one to the other as the match goes on, as the old
// morning-to-golden-afternoon did. `Day` is exactly that old look.
//
//   sun, sunI      the key light's colour and strength (at night, the moon's)
//   sky, ground, hemiI   the hemisphere (ambient) light: sky side, ground side, strength
//   top, mid, horizon    the dome's three colours; cloud, fog likewise
// and, for the whole time:
//   elev, azim     the sun's height in degrees and its swing in radians: [start, change]
//   glow           the colour of the sun's disc and halo in the sky (the moon, at night)
//   bottom         the dome below the horizon
//   fogNear/Far    how far the fog starts and ends
//   shadow         shadow strength (0..1)
//   water          the water's tint
//   cloudGlow      how much the clouds shine for themselves
//   wet            how bright a Rain round's greys are (a rainy night stays dark)
//   stars          the stars show over the meadows
//   lit            0..1: windows, street lights and tank headlights come on
//   flash          how much a blast's light flash is boosted
//   shade          how bright ordinary smoke is (it is not lit by the scene)

export const PRESETS = {
  // Late morning to a golden afternoon (the original look).
  day: {
    id: 'day',
    a: { sun: '#fff0d8', sunI: 2.2, sky: '#cfe1ff', ground: '#6b5638', hemiI: 0.8, top: '#1c63e8', mid: '#6fa8ee', horizon: '#b4d4f2', cloud: '#ffffff', fog: '#b4d4f2' },
    b: { sun: '#ffc078', sunI: 2.05, sky: '#ffdcc0', ground: '#70503a', hemiI: 0.92, top: '#2a62d0', mid: '#86b2e6', horizon: '#f8c890', cloud: '#ffe6c8', fog: '#b4d4f2' },
    elev: [58, 24], azim: [0.45, 2.0], glow: '#ffd99a', bottom: '#a39276',
    fogNear: 700, fogFar: 2600, shadow: 1, water: '#2d6f86', cloudGlow: 0.6, wet: 1, stars: false, lit: 0, flash: 1, shade: 1,
  },
  // A low pink-gold sun climbing out of a hazy sky.
  dawn: {
    id: 'dawn',
    a: { sun: '#ffb48a', sunI: 1.7, sky: '#ffcfc4', ground: '#5d4a52', hemiI: 0.78, top: '#3a56b4', mid: '#c48fb4', horizon: '#ffb283', cloud: '#ffc2a8', fog: '#e6b0a2' },
    b: { sun: '#ffe0bc', sunI: 2.0, sky: '#e2e4ff', ground: '#64543f', hemiI: 0.85, top: '#2c62d8', mid: '#86aee4', horizon: '#f4d8b4', cloud: '#fff0e0', fog: '#d6d0c8' },
    elev: [7, 30], azim: [0.1, 1.4], glow: '#ffc890', bottom: '#8c7a74',
    fogNear: 520, fogFar: 2100, shadow: 0.9, water: '#3a6c86', cloudGlow: 0.6, wet: 0.9, stars: false, lit: 0, flash: 1.1, shade: 0.95,
  },
  // A red sun sinking, violet sky overhead, street lights coming on.
  dusk: {
    id: 'dusk',
    a: { sun: '#ff9a58', sunI: 2.0, sky: '#d6b0c8', ground: '#5a3a34', hemiI: 0.78, top: '#27358c', mid: '#8a5a96', horizon: '#f08850', cloud: '#ffb48c', fog: '#c8867a' },
    b: { sun: '#ff6c3c', sunI: 1.5, sky: '#9a88c4', ground: '#4a2c36', hemiI: 0.68, top: '#14194a', mid: '#5a3a78', horizon: '#dc643e', cloud: '#a8607c', fog: '#a46068' },
    elev: [16, 4], azim: [0.7, 1.3], glow: '#ff9a5e', bottom: '#5c3a40',
    fogNear: 450, fogFar: 2000, shadow: 0.85, water: '#355078', cloudGlow: 0.35, wet: 0.7, stars: false, lit: 0.7, flash: 1.5, shade: 0.75,
  },
  // Moonlight: a blue key light and enough sky light to read the ground.
  night: {
    id: 'night',
    a: { sun: '#9db8ff', sunI: 1.0, sky: '#6f88d0', ground: '#2a3250', hemiI: 0.95, top: '#050a22', mid: '#0f1c44', horizon: '#1c2e5c', cloud: '#3a4672', fog: '#1a2a54' },
    b: { sun: '#b0c6ff', sunI: 1.0, sky: '#7690d6', ground: '#2c3454', hemiI: 0.95, top: '#050a22', mid: '#102048', horizon: '#20336a', cloud: '#404c7a', fog: '#1e305e' },
    elev: [46, 30], azim: [0.9, 1.0], glow: '#dce8ff', bottom: '#0c1430',
    fogNear: 420, fogFar: 1800, shadow: 0.6, water: '#2a6a8c', cloudGlow: 0.12, wet: 0.25, stars: true, lit: 1, flash: 1.8, shade: 0.35,
  },
};

// The look now: set by Sky.setTime when a match starts (and back to Day for the
// menu). `lit` is an object so shaders can share it as a uniform.
export const look = { id: 'day', preset: PRESETS.day, lit: { value: 0 } };

export function setLook(id) {
  const p = PRESETS[id] || PRESETS.day;
  look.id = p.id;
  look.preset = p;
  look.lit.value = p.lit;
  return p;
}
