// How far the orbit camera may sink at a spot: pure, so it is testable without
// three.js. main.js applies it each frame after the orbit controls.

export const CAM_CLEARANCE = 4;

// Returns { min, max } for the camera's y at x/z (either may be infinite).
//  - Ordinary field: stay `margin` above the ground.
//  - Floating isles, in open sky: nothing to hit but the far bedrock, so only
//    that floor. Past the arena's edge the caller's `fallbackFloor` applies.
//  - Under an isle's footprint the camera is either above it (stay over the top,
//    as on any ground) or below it (stay under the underside, never pushed up
//    through the isle). A camera inside the body goes to the nearer face, by
//    the middle height, as a blast does (Terrain.carve).
export function cameraLimits(terrain, x, y, z, margin = CAM_CLEARANCE, fallbackFloor = -Infinity) {
  if (!terrain.inBounds(x, z)) return { min: fallbackFloor, max: Infinity };
  const top = terrain.heightAt(x, z);
  if (!terrain.under) return { min: top + margin, max: Infinity };
  const floor = Number.isFinite(terrain.bedrock) ? terrain.bedrock + margin : -Infinity;
  if (!terrain.solidAt(x, z)) return { min: floor, max: Infinity };
  const under = terrain.underAt(x, z);
  if (y >= (top + under) / 2) return { min: top + margin, max: Infinity };
  return { min: floor, max: under - margin };
}

// The camera y after the limits are applied.
export function clampCameraY(terrain, x, y, z, margin = CAM_CLEARANCE, fallbackFloor = -Infinity) {
  const { min, max } = cameraLimits(terrain, x, y, z, margin, fallbackFloor);
  return Math.min(max, Math.max(min, y));
}
