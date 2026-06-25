# Weapons

> **Status: seed.** Not yet started in our codebase — this captures the legacy design we
> intend to mine. Add notes/questions in the panel.

## Purpose

Scorched3D's weapon *system design* is one of the things worth porting: a data-driven,
**composable** tree where complex weapons are built by nesting simple parts. We want to
keep that design and re-express it the Unreal way (data assets + components), not the C++
class explosion.

## Scorched3D approach

- **`Accessory`** (`common/weapons/Accessory.h:39`) is the buyable item — name, price,
  arms level, model — wrapping a single root `AccessoryPart *accessoryAction_`.
- **`AccessoryPart`** (`common/weapons/AccessoryPart.h:40`) is the polymorphic base;
  concrete types include Weapon / Parachute / Shield / AutoDefense / Battery. A
  name→prototype registry (`AccessoryMetaRegistration`) instantiates a part by the `type`
  attribute in XML — this is what makes the system composable.
- **`Weapon : AccessoryPart`** (`common/weapons/Weapon.h:95`) adds `fire()` /
  `fireWeapon()`. There are ~100 concrete weapon parts (`WeaponExplosion`, `WeaponMirv`,
  `WeaponProjectile`, `WeaponMulti`, `WeaponRoller`, …) that **nest other weapons** to
  compose behavior.
- **Definitions are XML data**, not code:
  `data/globalmods/none/data/accessories.xml` (and the `apoc` mod). Nesting is literal —
  e.g. `WeaponSelectPosition` → `aimedweapon WeaponMoveTank` → … (`accessories.xml:36-41`).

## Our approach

_TODO (Phase 2+)._ Likely a `UPrimaryDataAsset` per weapon composing reusable
"effect part" objects (explosion, MIRV split, roller, projectile spawn), driving a single
runtime `FireWeapon` that recurses the tree — mirroring `AccessoryPart` composition with
Unreal data assets instead of an XML+RTTI registry.

## Side-by-side

| Concept | Scorched3D | Ours (Unreal) |
| --- | --- | --- |
| Definition format | XML (`accessories.xml`) | _TBD — data assets_ |
| Composition | Nested `AccessoryPart` tree via type registry | _TBD — nested data-asset parts_ |
| Behavior dispatch | Virtual `fireWeapon()` per part | _TBD_ |
| Economy/buying | `Accessory` price + arms level | _TBD_ |

## Status

Not started. Design intent only (keep the composable model, replace the XML/RTTI plumbing).

## Open questions

- Data assets vs. a lightweight JSON/DataTable for weapon definitions?
- How much of the ~100-part taxonomy do we actually need for v1 vs. a handful
  (explosion, MIRV, roller, projectile)?
