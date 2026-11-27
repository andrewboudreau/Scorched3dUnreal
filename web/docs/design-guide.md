# Craterfall game design guide

This is a living document: where the game is going and why. `README.md` covers
how it plays today. Ideas live here until they're built, and then the README
takes over. Backlog and work in progress are GitHub issues labelled
`craterfall`.

## Where it's going

Today Craterfall is a **playable sandbox**: a place to try weapons, mods and
rules quickly, with a match builder so the host can tick which weapons, perks
and round modifiers are in play, and query params to pin a test down.

The long-term goal is **roguelike player-versus-player battles**: short runs
where you pick upgrades between rounds and fight other people. Two game modes:

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
- **Roguelike runs.** A match is a short run. Between rounds you take skills,
  so two matches never play the same.

## What a tank carries

| Kind | What it is | Spent how | Examples |
| --- | --- | --- | --- |
| **Weapons** | Ammo, fired one shot at a time | Each shot uses a round | Shell, Flak, Breacher, Guided Missile, Roller |
| **Mods** | Equipment deployed onto the field or mounted on the tank. It has health and/or charges or a lifetime, can be shot down, and wears out. Gained and levelled through perks (the host can untick a mod's cards to turn it off; `?sat=` / `?orbiter=` hand everyone one for testing) | Deployed; then lost, destroyed or expired, and ready again on the owner's next turn | Survey Satellite, Gravity Orbiter, Missile Defense, drones |
| **Perks** | Ranks in the skill tree, bought with skill points between rounds. They change your numbers, unlock mods or level them up | Kept for the match | Heavy Rounds, Double Strike, Orbital Mechanic, Tighter Orbit |
| **Abilities** (idea) | Active powers on a cooldown, usually granted by a perk or a mod | Cooldown in turns | Signal jam pulse, emergency hop |

Mods are tracked in #10.

**Mods come from the skill tree.** Each mod is a branch: rank 1 gives the
mod, ranks 2 and 3 its levels. A new mod needs a free mod bay. The armory
does not sell mods (unless the host's Lab says so). The host can untick a
mod's ranks in the match builder to turn it off; `?sat=` and `?orbiter=` give
everyone one at a set level for testing.

**Deploying a mod uses your turn**: you don't fire that turn. In return the
mod persists. It carries over into the next round and stays until it is
destroyed or its battery runs out, counted in your turns. A deployed Survey
Satellite is a range finder you keep, so the turn is its price. That makes
the counters matter: shooting down a satellite costs its owner a turn as well
as the advantage it gave.

**A lost mod costs the redeploy turn.** Shot down or worn out, a new one is
ready on its owner's next turn (next volley), and putting it up takes that
turn. Losing it does not cost the rest of the round: a single Flak hit then
trades a turn for a turn (plus the shooter's pay, and a turn in which every
enemy shoots past no orbiter), rather than deciding the round, and the
mod you took stays part of how you play. A mod lost with its tank comes
back next round.

## How you get things (the run, round by round)

One rule each, so a player can say where anything came from:

| Kind | Where it comes from | Kept |
| --- | --- | --- |
| **Starting kit** | Every tank starts the match with it (see below) | Ammo until fired |
| **Weapons and gear** | Bought in the **armory** with money, after every round | Ammo until fired; gear for the next round |
| **Perks and mods** | The **skill tree**: a skill point after every round buys the next rank of any branch | The whole match |

In short: **skill points buy skills; money buys weapons and gear.** The tree
never sells ammo, and the armory never sells perks or mods.

### The skill tree

After every round each tank gets **one skill point** (`SKILL.perRound`,
`src/core/skills.js`). A point buys the **next rank of any branch**: start a
new branch, or go one deeper in one you have. Ranks go in order, so the
choice each round is wide (a little of everything) or deep (three points into
Sat Recon for a level 3 satellite by round 4). Points you don't spend carry
over, so you can save for two ranks at once.

| Branch | Ranks |
| --- | --- |
| Orbital Mechanic (mod) | Gravity Orbiter level 1, 2, 3 |
| Sat Recon (mod) | Survey Satellite level 1, 2, 3 |
| Smoke and Mirrors (mod) | Decoy Beacon level 1, 2, 3 |
| Close-In Gunner (mod) | Point Defense level 1, 2, 3 |
| *each new mod* | its levels 1 to 3 (made from the mod data) |
| Firepower | Heavy Charge, Wide Blast, Shrapnel |
| Hull | Reinforced Hull, Dug In, Field Repairs |
| Gunnery | Tracer Rounds, Heavy Rounds, Streamlined Shells, Double Strike (from round 3) |
| Supply | Haggler, Quartermaster, Bounty Hunter |
| Chassis | Long-Range Tanks, Shock Mounts |
| Mod Tuning | Long-Life Cells (needs a mod) |

A rank the match has off, or one that could do nothing (Streamlined Shells
with no Rain round possible), drops out and the next moves up. CPUs spend
every point at once: half the time deeper in a branch they started, otherwise
what they like.

**Mod bays.** A tank holds at most **two** mods. With two, the other mod
branches show "Both mod bays in use". That keeps each tank to a clear plan
(say, satellite plus decoy) and stops one tank stacking every defense.

### The between-rounds screen

Three steps, one screen, a stepper across the top (**Results · Skills ·
Armory**), so it reads as one stop rather than three pop-ups:

1. **Results**: who won the round, what everyone earned and why (damage, kill,
   survived, round win, stipend).
2. **Skills**: one card per branch: its ranks as a path (taken ones lit), the
   next rank and what it does, and a button (or why it is shut). Spend a
   point, or save it and go on. Skills come before the armory so Haggler and
   Quartermaster count in this visit's shopping.
3. **Armory**: sections, in this order: **Weapons** (Standard, then Advanced,
   the latter locked with "opens in round N" until it does) and **Gear**
   (Armor Plate, Fuel Can, Jump Jets). A **Your kit** strip at the top lists
   what you hold: ammo counts, mods with levels, perk tags, unspent points.

### Weapons: roles, tiers and prices

Every weapon names its **role** (one word on its card) and a **tier**:

- **Standard**: in the armory from the first visit (before round 2).
- **Advanced**: from the second visit on (before round 3). The big blasts and
  tricks you build towards.

| Weapon | Role | Tier | Per buy | Price | Notes |
| --- | --- | --- | --- | --- | --- |
| Shell | Damage | Kit | ∞ | free | 38 at the centre, 11 m |
| Rangefinder | Aim | Standard | 3 | $60 | five markers, no damage |
| Scout Missile | Recon | Standard | 2 | $50 | fog of war only |
| Mound | Terrain | Standard | 3 | $90 | cover, or bury a tank |
| Dirt Bomb | Terrain | Standard | 2 | $130 | buries tanks within ~18 m: costs them a turn |
| Guided Missile | Damage | Standard | 2 | $90 | steer for 3 s (not online) |
| Roller | Damage | Standard | 3 | $130 | finds tanks in hollows |
| Breacher | Damage | Standard | 3 | $180 | 70, 22 m |
| Flak | Anti-air | Standard | 2 | $200 | the answer to mods in the sky |
| Teleport | Move | Advanced | 2 | $120 | |
| Napalm | Area | Advanced | 2 | $100 | runs downhill, pools in hollows: up to 56 |
| Scatter | Damage | Advanced | 2 | $220 | five shells over a row |
| Thunderhead | Damage | Advanced | 1 | $200 | 95, 30 m: the big one |

Prices follow one yardstick: **a damage weapon costs $0.50 to $1.40 a shot
for each point a good shot deals** (blast damage, times the share of a
spread that lands, scaled by the blast's size). The game pays $2 a point, so
a shot that lands always pays for itself. Flak is priced as anti-air, and the
tools (aim, recon, terrain, move) by what they save. `test/economy.test.js`
holds the yardstick so a new weapon cannot drift.

**Starting kit:** Shell (unlimited), 1 Breacher, 1 Roller, 1 Mound,
2 Rangefinders, 1 Guided Missile (not online), 1 Jump Jet charge. Shown on
the first round's banner and in the guide.

**Pay:** $150 stipend every round, $80 for surviving it, $300 for winning it,
$2 a point of damage, $150 a kill, $60 for shooting down a mod. A typical
round earns $350 to $700.

### Mods and their levels

Each level adds something you can name, not only bigger numbers.

| Mod | Family | Level 1 | Level 2 | Level 3 |
| --- | --- | --- | --- | --- |
| Gravity Orbiter | Defense | one well bends enemy shells | stronger and faster | two wells: a three-body slingshot |
| Survey Satellite | Recon | aim labels, no wind | labels count wind, moons and orbiters | more labels |
| **Decoy Beacon** | Deception | Blink: fire it like a shot and your tank warps where it lands; a decoy of your tank stays where you were and fizzles after 20 damage | the decoy takes 35 and shows your hit points | when it fizzles it goes off: a 25-damage blast that hurts whoever is near |
| **Point Defense** | Defense | shoots down the first enemy shell coming down within 18 m, once a round | twice a round | 26 m, and it also stops a split shell's fragments |

The Decoy is the answer to being ranged: when an enemy has your distance
dialled in, blink and leave the decoy to eat the shot. CPUs aim at the decoy
some of the time (easy ones more often). It beats recon (the satellite's
labels and an enemy's aim history point at the decoy); a blast that catches
both still finds you. Point Defense beats single heavy shells; Scatter, Flak
bursts, Double Strike's second shell and Rollers get past it.

More mod ideas for later: a recon drone that reveals fog, a jammer drone
(jamming family), a shield bubble that soaks one blast, a repair drone, a
mine layer.

## Variants, the run and the boss (plan, #15)

The next layer of the roguelike: weapons that grow in two directions, a short
solo **run** across a small map of fights, and a **boss** at the end of it,
fought two against one. Built in stages, each playable on its own (see Build
order). Stages 1 and 2, the variants and the boss (in the sandbox), are built; the
run is still a plan.

### Weapon variants (built)

A **variant** is the same weapon doing its job a different way. It is picked
in the **skill tree**, so the rule stays whole: points decide how your weapons
behave, money buys the rounds. A variant applies to every round of that weapon
you hold or buy for the rest of the match.

Each variant weapon gets a branch with two ranks:

1. **A fork:** pick one of two variants. The other closes for the match.
2. **An upgrade** of the variant you picked: one named improvement.

The branch only shows when the weapon is in the match. Each rank costs a
point, like any other. The first five families (the README has the numbers):

| Weapon | Variant A | Variant B | Rank 2 (either) |
| --- | --- | --- | --- |
| Breacher | **Bunker Buster**: digs half as deep again and hits a buried or dug-in tank in full | **Splitter**: throws three bomblets outward on impact | 15% wider |
| Roller | **Seeker**: leans toward the nearest tank as it rolls | **Hopper**: hops once over a bump instead of stopping | rolls half as far again |
| Napalm | **Sticky**: burns 2 s longer, runs about half as far and lies deeper | **Flood**: more, thinner fuel that runs about half as far again, burns shorter | burns through rain and shallow water |
| Scatter | **Line**: five shells in a tight row along the aim | **Ring**: five shells round the aim point | a sixth shell |
| Thunderhead | **Deep Strike**: a deeper crater, more damage at the centre | **Airburst**: goes off 8 m up, no crater, damage by the distance across, hits through a Dirt Bomb dome | 15% wider |

Rules for a good variant:

- **A trade, never a straight upgrade.** Each one gives up something (reach,
  burn time, crater) for something else, and each passes the price yardstick
  in `test/economy.test.js` at its own damage.
- **Readable on a phone.** One line on the card; the armory and the weapon
  button show the variant's name ("Napalm · Sticky").
- **Data first.** A variant is a patch on the weapon in `weapons.js`
  (`variants: [{ id, name, desc, patch }]`): changed numbers and flags, with
  new behaviours (seeking, airburst, hopping) as named hooks in
  `ballistics.js` so the aim arc, the CPUs' `simulateShot` and the kill cam
  fly the same path. The game resolves a player's weapon as base plus patch.
- **CPUs** choose by personality (an aggressive CPU picks Splitter and Flood,
  a careful one Bunker Buster and Sticky).

How it is built: a variant pick is a perk id (`napalm:sticky`, `VARIANT_PERKS`
in `perks.js`), so it travels in snapshots and online like any other rank.
`game.weaponOf(player, id)` resolves the weapon (base, patch, then the
upgrade) for every shot, the CPUs' solver and the kill cam. The hooks are
`seekNudge`, `hopOver` and `burstNow` in `ballistics.js`, the `throw` impact
part (the Splitter's bomblets), the `ring` and `along` split shapes, and
Napalm's `params` (`napalmParams`), kept in the spill's ground op so a
rebuilt ground matches. Building it added one base rule: rain damps napalm
(65% damage), which Wet Burn ignores. The aim arc only draws the climb, which
no variant changes. Gunners and skirmishers count as aggressive, sappers and
spotters as careful, three times in four on the seeded dice.

**The skill screen grows**, so on a phone it has three tabs: **Weapons**
(the variant branches), **Mods**, and **Tank** (Firepower, Hull, Gunnery,
Supply, Chassis).

Upgrades stay in the tree; the armory still sells only ammo and gear. Paying
money for upgrades would blur the one rule a player can say aloud.

### The run

A solo mode beside the quick match: you against CPUs across a **short map of
fights**, kit carried from one to the next, ending in the boss. About 20 to 30
minutes.

**The map** is a few tiers of stops, two or three per tier, joined by paths;
from each stop you choose one of the next tier's. About seven stops from start
to boss, so a run has five or six fights and a choice at every step. Each stop
shows, before you pick it: the world, the edges, the time of day, a round
modifier, the foes (one to three CPUs and how hard), and the reward.

| Stop | What happens |
| --- | --- |
| **Fight** | A short match (one or two rounds) against one or two CPUs |
| **Elite** | A tougher CPU with a mod already up. A better reward |
| **Cache** | No fight: pick one of three (a skill rank, a crate of ammo, money) |
| **Depot** | No fight: the armory, and you may swap a variant |
| **Boss** | The last stop, two against one (below) |

**What carries:** money, ammo, skill ranks and variants, and mods with their
levels. **Health resets** each fight, since artillery swings and a carried
wound would decide the run before it got going. Instead you start with **two
spare hulls**: losing a fight costs one, and with none left the run ends.

**One point per fight won**, plus whatever a Cache gives. The same tree as
the quick match.

**Seeded like everything else.** The run has a seed; the map is generated
from it, and each stop's match seed comes from the run seed and the stop. A
run's state is a small record (seed, stop, kit, ranks, money, hulls) saved in
the browser, and later against the player id (stage 3 of Players and
accounts) so a run follows you to another device.

### The boss: two against one (built in the sandbox)

The last stop is you and an **ally** against a **boss tank**. The ally is a
CPU you choose from the tanks you beat on the way, so the run decides your
partner. Online later: two players against the boss, a co-op run.

The boss is a tank with a script, deterministic like the rest of the core (a
`boss` flag on the player, its moves chosen in `ai.js` by phase):

- **Big:** half as large again as a tank, with about 400 hp, on a raised
  platform at one end of a walled arena. As built: a walled meadow (hills
  at most Hilly), the **Bulwark** on a flat-topped fort 18 m over the ground
  round it, with two lower ledges a jet hop away (`core/boss.js`).
- **Phases** by health:
  1. **Full to 60%:** Scatter and Breacher, with Point Defense up.
  2. **60% to 25%:** puts up a Gravity Orbiter, jumps between ledges, and
     answers whoever hurt it most with a Dirt Bomb.
  3. **Under 25%:** fires twice a turn, and once a Thunderhead.
- **Telegraphs:** a turn before a big shot it marks its target on the field
  ("Thunderhead locked on Tester"), so the target has a turn to move, dig in
  or raise a mound. On a phone a warning you can act on beats a surprise.
- **A weak spot:** hits from above (Airburst, or a high lob onto its turret)
  do a quarter more, so the variants you picked can matter. As built, "from
  above" is an Airburst going off, or any shell or fragment coming down at
  least 60 degrees below the horizontal when it goes off.

Beating it ends the run with a summary: the route, the fights, the build.

### Build order

Each stage ships on its own:

1. **Variants** (built): the data, the fork rank in the tree, the five
   families, the skill screen's tabs, CPUs choosing.
2. **The boss in the sandbox** (built): Custom match > Match > Boss (and
   `?boss=1`), you and a CPU ally against it, so it can be played and tuned
   before the run exists. Teams came with it (a team per player; allies are
   never targeted and earn nothing for hitting each other).
3. **The run:** map generation, the map screen (touch first), the stops,
   spare hulls, saving.
4. **Polish:** map art, reward cards, the run summary, a balance pass.

Open: how long a run should be; whether the ally keeps its own skill ranks
from the fight you beat it in; co-op runs online.

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
| Survey Satellite (L1–3) | Recon | Built as a mod (#10): from perks (Sat Recon, then Sharper Optics), deployed 70 m over its owner, 20–30 hp, a 5–7 turn battery | Voronoi patch with aim labels; L2+ includes wind and enemy orbiters (recon beats defense). CPUs don't use it |
| Gravity Orbiter (L1–3) | Defense | Built (#10): from perks (Orbital Mechanic, then Tighter Orbit), 30–50 hp, lasts 6–8 turns | L3 is two wells orbiting each other around you (three-body); scrambles shots rather than blocking them. Owner's shells are exempt. CPUs misread it, more at higher levels |
| Point Defense (was Missile Defense) | Defense | Built: from perks (Close-In Gunner, then Twin Feeds), 25–35 hp, lasts 5–7 turns | Shoots down the first enemy shell coming down near you; charges refill each round; Flak and Rollers pass. CPUs answer it with Scatter, Flak and Rollers (see "Mods and their levels") |
| Decoy Beacon | Deception | Built: from perks (Smoke and Mirrors, then Hard Light), 20–35 hp, lasts the round at most | Blink away and leave a decoy that soaks a ranged shot; CPUs fall for it on the seeded rng (see "Mods and their levels"). At most two mods a tank (mod bays) |
| Recon drone | Recon | Idea | Flies to a spot and hovers for N turns; reveals fog and applies Spotted; can be shot down |
| Jammer drone | Jamming | Idea | Hovers over an enemy and applies Jammed to its recon; Defense's prey |
| Comms uplink ("satcom") | Recon (support) | Idea | Buffs your other mods (Uplinked); could share recon with an ally in team play |
| Signal jam pulse | Jamming (ability) | Idea | A one-shot area pulse from your tank, on a cooldown |

### Missile Defense: a sketch for the mods layer

It fits the layer as it stands (`core/mods.js`) without new machinery:

- Data: `{ id: 'defense', family: 'defense', hp, turns, charges: [1, 2, 2],
  radius: [18, 18, 24] }`. `charges` refills when it is refitted at round start.
- Each fixed step, `stepWorld` already walks the mods for wells and contact;
  Missile Defense would add a check: the first enemy shell inside `radius` of
  its owner, on the way down, is detonated in the air (as `struck`, so no
  crater) and spends a charge. Deterministic, so netplay needs nothing new.
- Counters: Flak bursts before it is in reach; a Double Strike's second shell
  gets through if there is one charge; a MIRV's children overwhelm it. It
  does not touch rollers or diggers on the ground.
- CPU: the solver cannot plan round it, so CPUs facing it should prefer Flak
  (anti-air) or the multi-shell weapons, as they already prefer Flak against
  an orbiter (`knownFoes` marks `shielded`).
- Against the orbiter: two defense mods at once would make a tank nearly
  untouchable; the skill tree may need to allow only one defense mod
  up at a time.

## Story hooks (open)

The battle attributes are part of the setting: crews fighting over cratered
fields and floating isles with salvaged orbital gear. Recon, jamming and
defense are the three schools of that gear. To be written as the world takes
shape.

## Open questions

- Can a mod be repaired or recharged, and is that a perk or a shop item?
- Teams: do buffs like Uplinked share across allies?
- How many statuses can one tank show before the marks get cluttered? A cap
  and a priority order are needed.
