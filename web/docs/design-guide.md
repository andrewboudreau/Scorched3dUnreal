# Craterfall game design guide

This is a living document: where the game is going and why. `README.md` covers
how it plays today. Ideas live here until they're built, and then the README
takes over. Backlog and work in progress are GitHub issues labelled
`craterfall`.

## Where it's going

Today Craterfall is a **playable sandbox**: a place to try weapons, mods and
rules quickly, with Lab options so the host can bend the rules for a test.

The long-term goal is **roguelike player-versus-player battles**: short runs
where you draft upgrades between rounds and fight other people. Two game modes:

- **Turn-based:** the game as it plays today (take turns, or everyone plans and
  fires together in volleys). Good for phones, and for thinking.
- **Real-time** (future): everyone aims and fires on their own clock, with
  reload timers instead of turns. The simulation must stay deterministic, so
  real-time means a fixed tick with inputs stamped by tick, not free-running
  frames.

Build the sandbox so both modes can share the core: rules, weapons, mods and
statuses are data plus a deterministic step, and the mode only decides when
inputs are accepted.

## Players and accounts

Stages, simplest first:

1. **Now: a cookie identity.** On the first visit the server issues a random
   player id in a long-lived cookie. You pick a name once; the id and name are
   reused for every match and room, so a player is tracked across sessions
   (and can rejoin their seat after a reload). No password, no email.
2. **Later: email-validated login.** Claim your id with an email address (a
   one-time link, no password), so it follows you to another device.
3. **Then: stored player data.** Match history, wins, unlocked cosmetics and
   roguelike progress, kept server-side against the id.

Keep personal data to the minimum: a name, and later an email used only to
sign in.

## Pillars

- **Artillery first.** Reading the arc, the wind and the ground is the game.
  Everything else exists to make that duel richer, never to replace it.
- **Phone first.** Every feature is designed for a thumb in landscape before
  a keyboard. The view stays uncluttered, and each camera shows only what it
  needs.
- **Same game on every screen.** The simulation is deterministic: online play
  replays inputs, so nothing in the core may use unseeded randomness.
- **Roguelike runs.** A match is a short run. Between rounds you draft perks,
  so two matches never play the same.

## What a tank carries

| Kind | What it is | Spent how | Examples |
| --- | --- | --- | --- |
| **Weapons** | Ammo, fired one shot at a time | Each shot uses a round | Shell, Flak, Breacher, Guided Missile, Roller |
| **Mods** | Equipment deployed onto the field or mounted on the tank. It has health and/or charges or a lifetime, can be shot down, and wears out | Deployed; then lost, destroyed or expired | Survey Satellite, Gravity Orbiter, Missile Defense, drones |
| **Perks** | Roguelike advancements drafted between rounds. They change your numbers, unlock mods or level them up | Kept for the match | Heavy Rounds, Double Strike, Sat Recon II |
| **Abilities** (idea) | Active powers on a cooldown, usually granted by a perk or a mod | Cooldown in turns | Signal jam pulse, emergency hop |

Mods are tracked in #10.

## Attributes: buffs and debuffs

Mods and abilities mostly act by putting **status effects** on tanks or on
other mods. A status has a kind, a source, a strength and a duration in
turns, and it shows as a small icon on the tank's mark (only in the views that
show health; see the HUD rules). Statuses are game state, so they travel online.

Buffs (ideas):
- **Uplinked:** your recon mods reach further or label more (from a comms
  relay).
- **Shielded:** the next blast does less damage.
- **Ranged:** your last shot's landing is known to you (the sight already
  shows it).

Debuffs (ideas):
- **Jammed:** your Survey Satellite's labels scramble or go dark, your aim arc
  is hidden, and a Guided Missile can't be steered. This comes from a jamming
  drone or pulse.
- **Spotted:** you show through fog of war to everyone, from a recon drone
  or satellite.
- **Shaken:** turret slew is slower for a turn, after a near miss.

## Rock, paper, scissors

The balance runs on a triangle of three families of mods, so no single kit
wins every match:

```
        RECON  (satellite, recon drone, comms uplink)
        /    \
   beats      is beaten by
      /          \
 DEFENSE  <--beats--  JAMMING
 (orbiter, missile    (jammer drone,
  defense)             signal jam)
```

- **Recon beats defense.** Information lets you aim around a defense: the
  satellite's solutions account for an enemy's Gravity Orbiter wells, and a
  recon drone reveals where the Missile Defense's radius sits.
- **Defense beats jamming.** Jammers are physical, flying things. Missile
  Defense shoots drones down, and an orbiter's wells drag them off station.
- **Jamming beats recon.** A jammer blinds satellites and drones in its radius,
  putting Jammed on their owner.

Cross-cutting counters:
- **Flak is anti-air.** Its proximity burst is the general answer to anything
  deployed in the sky: satellites, drones and orbiter wells.
- **Breacher and digging** answer ground-mounted mods.

Rule of thumb: every mod we add should name what it beats and what beats it.
If it beats everything, it's a perk number, not a mod.

## Mod roster

| Mod | Family | Status | Notes |
| --- | --- | --- | --- |
| Survey Satellite (L1–3) | Recon | Built as an armory item; becoming a deployable, destructible mod (#10) | Voronoi patch with aim labels; L2+ includes wind |
| Gravity Orbiter (L1–3) | Defense | In progress (#10) | L3 is two wells orbiting each other around you (three-body); scrambles shots rather than blocking them |
| Missile Defense | Defense | Idea | Intercepts the first enemy shell entering a radius; a few charges per round |
| Recon drone | Recon | Idea | Flies to a spot and hovers for N turns; reveals fog and applies Spotted; can be shot down |
| Jammer drone | Jamming | Idea | Hovers over an enemy and applies Jammed to its recon; Defense's prey |
| Comms uplink ("satcom") | Recon (support) | Idea | Buffs your other mods (Uplinked); could share recon with an ally in team play |
| Signal jam pulse | Jamming (ability) | Idea | A one-shot area pulse from your tank, on a cooldown |

## Story hooks (open)

The battle attributes are part of the setting: crews fighting over cratered
fields and floating isles with salvaged orbital gear. Recon, jamming and
defense are the three schools of that gear. To be written as the world takes
shape.

## Open questions

- Does deploying a mod cost your turn, or is it a free action before you fire?
- Can a mod be repaired or recharged, and is that a perk or a shop item?
- Teams: do buffs like Uplinked share across allies?
- How many statuses can one tank show before the marks get cluttered? A cap
  and a priority order are needed.
