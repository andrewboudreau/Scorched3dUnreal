// Which game event asks for which sound. Pure (no audio, no DOM) so a test can
// pin the table; main.js plays what this returns through Sound.cue (audio.js).
//
//   cuesFor(e, ctx)  the cues one game event asks for:
//                    [{ cue, pos?, gain?, delay?, rate?, cluster? }]
//                    `pos` is where it happens (the sound is quieter and duller
//                    the farther from the camera); `cluster` is Sound.cue's
//                    "n small blasts follow" (a split shell's children).
//                    ctx.mine(playerId) says whether a local human plays that
//                    tank; ctx.at(playerId, modId) gives where a mod is.
//   runCues(outcome) the cues after a run fight: the hull, the reward, the end.
//   offerCue(kind)   the cue for a Cache offer taken ('rank', 'money', 'ammo').

const none = () => false;
const nowhere = () => null;

export function cuesFor(e, { mine = none, at = nowhere } = {}) {
  switch (e.type) {
    case 'bossPhase':
      return [{ cue: 'bossPhase' }];
    case 'bossMark':
      // The mark on you is louder than one on somebody else.
      return e.clear ? [] : [{ cue: 'bossMark', gain: mine(e.target) ? 1.3 : 0.7 }];
    case 'weakSpot':
      return [{ cue: 'weakSpot', pos: e.pos }];
    case 'intercept':
      return [{ cue: 'intercept', pos: e.from || e.pos }];
    case 'blink':
      // The decoy's blink armed: only its owner hears it (to the others it is just their tank).
      return e.armed && e.player != null && mine(e.player) ? [{ cue: 'blink' }] : [];
    case 'mod': {
      if (e.mod === 'decoy' && !mine(e.player)) return [];
      if (e.what === 'deploy') return [{ cue: 'deploy', pos: at(e.player, e.mod) }];
      if (e.what === 'down' && !e.tank) return [{ cue: 'modDown', pos: e.pos || at(e.player, e.mod) }];
      return [];
    }
    case 'split':
      // Flak bursts and its fragments tick down; the others pop and their
      // children land as a quick run of thuds. (Counts are the usual ones:
      // an upgrade adds a shell and the extra just times out.)
      if (e.airburst) return [{ cue: 'flak', pos: e.pos, cluster: { kind: 'frag', n: 12 } }];
      return [{ cue: 'pop', pos: e.pos, cluster: { kind: 'thud', n: e.thrown ? 3 : 6 } }];
    default:
      return [];
  }
}

const REWARD_CUE = { money: 'coin', ammo: 'ammo', point: 'skill' };

// After a fight in a run: `outcome` is core/run.js's applyFightResult outcome
// ({ won, hullLost, over, reward }); `items` its rewardItems(outcome.reward).
// Each cue comes with the delay (s) to start it at, so they do not pile up.
export function runCues(outcome, items = []) {
  const out = [];
  let t = 0;
  if (outcome.hullLost) { out.push({ cue: 'hull', delay: t }); t += 0.35; }
  if (outcome.over === 'won') out.push({ cue: 'runWon', delay: t });
  else if (outcome.over === 'lost') out.push({ cue: 'runOver', delay: t });
  else if (outcome.won) {
    for (const it of items) {
      const cue = REWARD_CUE[it.kind];
      if (cue) { out.push({ cue, delay: t }); t += 0.22; }
    }
  }
  return out;
}

const OFFER_CUE = { rank: 'skill', money: 'coin', ammo: 'ammo' };
export const offerCue = (kind) => OFFER_CUE[kind] || null;
