# Fly-and-Shoot Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A free-fly sandbox where you roam a large procedurally-hilly terrain and left-click to lob gravity-arced rockets that blow real sine-bowl craters.

**Architecture:** All gameplay is tracked C++ in the `Scorched3dUnreal` module. A code-driven `ASandboxGameMode` spawns the hilly terrain and lighting at `BeginPlay`, so launching from any empty map works. Terrain hills are layered Perlin noise added to the existing heightfield; the existing `CarveCrater` carves into them unchanged. Input uses Enhanced Input created at runtime in C++ (no binary input assets).

**Tech Stack:** Unreal Engine 5.8 C++; GeometryFramework/GeometryScript (`UDynamicMeshComponent`); `UFloatingPawnMovement`, `UProjectileMovementComponent`, `UCameraComponent`; Enhanced Input; UE Automation tests (headless).

## Global Constraints

- **Engine:** UE 5.8 at `D:/Games/EpicGames/UE_5.8`. Build target `Scorched3dUnrealEditor Win64 Development`.
- **Editor MUST be closed when building** (Live Coding blocks full builds: "Unable to build while Live Coding is active").
- **Build command (run from repo root):**
  `& "D:/Games/EpicGames/UE_5.8/Engine/Build/BatchFiles/Build.bat" Scorched3dUnrealEditor Win64 Development -Project="C:/Users/andre/source/repos/Scorched3dUnreal/Scorched3dUnreal.uproject" -WaitMutex`
  Success = `Result: Succeeded`.
- **Headless test command (editor closed):**
  `& "D:/Games/EpicGames/UE_5.8/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" "C:/Users/andre/source/repos/Scorched3dUnreal/Scorched3dUnreal.uproject" -ExecCmds="Automation RunTests <TestName>; Quit" -unattended -nopause -nosplash -log`
  Success = `Result={Success}` and process exit 0.
- **`HillAmplitude` defaults to 0.0** (flat) so existing M0 tests (`Scorched.CraterCarve.RealDepression`, `Scorched.CraterMath.DepthProfile`) stay green. Only the sandbox sets it > 0.
- **No new Content/asset dependencies.** Meshes use engine `BasicShapes` (`/Engine/BasicShapes/Sphere.Sphere`); explosion FX is procedural (`DrawDebugSphere` + radial impulse). Sound is optional and defaults to null.
- **New files** go in `Source/Scorched3dUnreal/` (gameplay) and `Source/Scorched3dUnreal/Tests/` (tests), matching the existing layout.
- Automation test naming convention: `Scorched.<Area>.<Case>` (matches `Scorched.CraterMath.DepthProfile`).
- Tasks 3–5 (pawn, rocket, gamemode) are **UE gameplay classes that cannot be unit-tested headlessly** — their per-task gate is "build succeeds (`Result: Succeeded`) + code review"; gameplay behavior is validated together in Task 6's in-engine acceptance checklist.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `Source/Scorched3dUnreal/TerrainHeight.h/.cpp` | Pure layered-Perlin height function | 1 |
| `Source/Scorched3dUnreal/Tests/TerrainHeightTest.cpp` | Headless test for the height function | 1 |
| `Source/Scorched3dUnreal/CraterTerrainActor.h/.cpp` | Add hill props + displace verts in `RegenerateGround` | 2 |
| `Source/Scorched3dUnreal/Tests/CraterCarveTest.cpp` | Add carve-into-hills test case | 2 |
| `Source/Scorched3dUnreal/RocketProjectile.h/.cpp` | Gravity-arc rocket; carves terrain on impact | 3 |
| `Source/Scorched3dUnreal/FlyCameraPawn.h/.cpp` | Free-fly pawn; Enhanced Input; fires rockets | 4 |
| `Source/Scorched3dUnreal/SandboxGameMode.h/.cpp` | Spawns terrain + lighting; sets default pawn | 5 |
| `Source/Scorched3dUnreal/Scorched3dUnreal.Build.cs` | Add `EnhancedInput` module | 6 |
| `Config/DefaultEngine.ini` | Default GameMode + map → sandbox | 6 |

---

## Task 1: TerrainHeight pure helper

**Files:**
- Create: `Source/Scorched3dUnreal/TerrainHeight.h`
- Create: `Source/Scorched3dUnreal/TerrainHeight.cpp`
- Test: `Source/Scorched3dUnreal/Tests/TerrainHeightTest.cpp`

**Interfaces:**
- Consumes: nothing (leaf helper, mirrors `CraterMath`).
- Produces:
  - `struct TerrainHeight::FParams { double Amplitude=0.0; double Frequency=0.0005; int32 Octaves=4; int32 Seed=0; };`
  - `double TerrainHeight::HeightAt(double X, double Y, const FParams& Params);` — returns a height in cm in `[-Amplitude, +Amplitude]`; returns `0.0` when `Amplitude<=0` or `Octaves<=0`; deterministic for a fixed `(X,Y,Params)`.

- [ ] **Step 1: Write the failing test**

Create `Source/Scorched3dUnreal/Tests/TerrainHeightTest.cpp`:

```cpp
#include "Misc/AutomationTest.h"
#include "../TerrainHeight.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTerrainHeightTest, "Scorched.TerrainHeight.Profile",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTerrainHeightTest::RunTest(const FString& Parameters)
{
    // Amplitude 0 => perfectly flat everywhere (preserves M0 flat-terrain tests).
    {
        TerrainHeight::FParams Flat; // Amplitude defaults to 0
        TestEqual(TEXT("flat at origin"), TerrainHeight::HeightAt(0.0, 0.0, Flat), 0.0, 1e-9);
        TestEqual(TEXT("flat off origin"), TerrainHeight::HeightAt(1234.0, -987.0, Flat), 0.0, 1e-9);
    }

    TerrainHeight::FParams P;
    P.Amplitude = 1000.0;
    P.Frequency = 0.0008;
    P.Octaves   = 4;
    P.Seed      = 3;

    // Deterministic: same input -> same output.
    TestEqual(TEXT("deterministic"),
        TerrainHeight::HeightAt(2500.0, -1500.0, P),
        TerrainHeight::HeightAt(2500.0, -1500.0, P), 1e-9);

    // Bounded by amplitude.
    double MinH =  1.0e18, MaxH = -1.0e18;
    for (int32 ix = -20; ix <= 20; ++ix)
    {
        for (int32 iy = -20; iy <= 20; ++iy)
        {
            const double H = TerrainHeight::HeightAt(ix * 500.0, iy * 500.0, P);
            TestTrue(TEXT("within +/- amplitude"), H >= -P.Amplitude - 1e-6 && H <= P.Amplitude + 1e-6);
            MinH = FMath::Min(MinH, H);
            MaxH = FMath::Max(MaxH, H);
        }
    }

    // Varied: the field is not constant (real hills).
    TestTrue(FString::Printf(TEXT("terrain varies (range=%.1f)"), MaxH - MinH), (MaxH - MinH) > 100.0);

    // Different seed -> different field at a sample point.
    TerrainHeight::FParams P2 = P; P2.Seed = 99;
    TestTrue(TEXT("seed changes field"),
        !FMath::IsNearlyEqual(TerrainHeight::HeightAt(2500.0, -1500.0, P),
                              TerrainHeight::HeightAt(2500.0, -1500.0, P2), 1e-3));

    AddInfo(FString::Printf(TEXT("range over 41x41 grid: min=%.1f max=%.1f"), MinH, MaxH));
    return true;
}
```

- [ ] **Step 2: Write the header**

Create `Source/Scorched3dUnreal/TerrainHeight.h`:

```cpp
#pragma once

#include "CoreMinimal.h"

namespace TerrainHeight
{
    // Procedural terrain parameters. Amplitude<=0 yields a flat field.
    struct FParams
    {
        double Amplitude = 0.0;     // peak hill height (cm); 0 => flat
        double Frequency = 0.0005;  // base spatial frequency (1/cm); smaller = broader hills
        int32  Octaves   = 4;       // number of noise layers
        int32  Seed      = 0;       // offsets the noise field
    };

    // Layered Perlin-noise height (cm) at local plane coords (X,Y).
    // Deterministic; result is in [-Amplitude, +Amplitude].
    double HeightAt(double X, double Y, const FParams& Params);
}
```

- [ ] **Step 3: Write the implementation**

Create `Source/Scorched3dUnreal/TerrainHeight.cpp`:

```cpp
#include "TerrainHeight.h"

double TerrainHeight::HeightAt(double X, double Y, const FParams& Params)
{
    if (Params.Amplitude <= 0.0 || Params.Octaves <= 0)
    {
        return 0.0;
    }

    // Seed shifts the sample position so different seeds give different fields.
    const double SeedOffset = static_cast<double>(Params.Seed) * 1013.0;

    double Sum     = 0.0; // accumulated noise
    double AmpSum  = 0.0; // sum of per-octave weights, for normalization
    double Freq    = Params.Frequency;
    double Weight  = 1.0;

    for (int32 i = 0; i < Params.Octaves; ++i)
    {
        const FVector2D SamplePoint(
            (X + SeedOffset) * Freq,
            (Y + SeedOffset) * Freq);
        // FMath::PerlinNoise2D returns roughly [-1, 1].
        Sum    += Weight * static_cast<double>(FMath::PerlinNoise2D(SamplePoint));
        AmpSum += Weight;
        Freq   *= 2.0;   // each octave doubles frequency (finer detail)
        Weight *= 0.5;   // and halves contribution
    }

    const double Normalized = (AmpSum > 0.0) ? (Sum / AmpSum) : 0.0; // in [-1, 1]
    return Normalized * Params.Amplitude;
}
```

- [ ] **Step 4: Build, then run the test**

Close the editor. Build:
```
& "D:/Games/EpicGames/UE_5.8/Engine/Build/BatchFiles/Build.bat" Scorched3dUnrealEditor Win64 Development -Project="C:/Users/andre/source/repos/Scorched3dUnreal/Scorched3dUnreal.uproject" -WaitMutex
```
Expected: `Result: Succeeded`.

Run the test:
```
& "D:/Games/EpicGames/UE_5.8/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" "C:/Users/andre/source/repos/Scorched3dUnreal/Scorched3dUnreal.uproject" -ExecCmds="Automation RunTests Scorched.TerrainHeight; Quit" -unattended -nopause -nosplash -log
```
Expected: `Result={Success}`, exit 0.

- [ ] **Step 5: Commit**

```
git add Source/Scorched3dUnreal/TerrainHeight.h Source/Scorched3dUnreal/TerrainHeight.cpp Source/Scorched3dUnreal/Tests/TerrainHeightTest.cpp
git commit -m "feat: add TerrainHeight layered-perlin helper (headless tested)"
```

---

## Task 2: Procedural hills in the terrain actor

**Files:**
- Modify: `Source/Scorched3dUnreal/CraterTerrainActor.h` (add 4 UPROPERTYs in the public section)
- Modify: `Source/Scorched3dUnreal/CraterTerrainActor.cpp` (`RegenerateGround` displaces verts; new include)
- Test: `Source/Scorched3dUnreal/Tests/CraterCarveTest.cpp` (add a second test)

**Interfaces:**
- Consumes: `TerrainHeight::HeightAt`, `TerrainHeight::FParams` (Task 1).
- Produces: public fields on `ACraterTerrainActor` — `float HillAmplitude` (default `0.0f`), `float HillFrequency` (default `0.0005f`), `int32 HillOctaves` (default `4`), `int32 HillSeed` (default `0`). Behavior: when `HillAmplitude>0`, `RegenerateGround()` raises the surface by `TerrainHeight::HeightAt`. `CarveCrater` is unchanged.

- [ ] **Step 1: Add hill properties to the header**

In `Source/Scorched3dUnreal/CraterTerrainActor.h`, after the `GridResolution` UPROPERTY (line 19), add:

```cpp
    /** Peak procedural hill height in cm. 0 = flat (default; keeps M0 tests valid). */
    UPROPERTY(EditAnywhere, Category = "Terrain|Hills") float HillAmplitude = 0.0f;

    /** Base noise frequency (1/cm). Smaller = broader hills. */
    UPROPERTY(EditAnywhere, Category = "Terrain|Hills") float HillFrequency = 0.0005f;

    /** Number of noise octaves layered into the terrain. */
    UPROPERTY(EditAnywhere, Category = "Terrain|Hills") int32 HillOctaves = 4;

    /** Seed offset for the hill noise field. */
    UPROPERTY(EditAnywhere, Category = "Terrain|Hills") int32 HillSeed = 0;
```

- [ ] **Step 2: Write the failing test (carve into hills)**

In `Source/Scorched3dUnreal/Tests/CraterCarveTest.cpp`, append a second test after `FCraterCarveTest` (end of file, before/after is fine — keep both):

```cpp
// Carving into a HILLY heightfield still produces a real local depression and never
// raises any vertex above its pre-carve height (no lid), and leaves far terrain untouched.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FCraterCarveIntoHillsTest, "Scorched.CraterCarve.IntoHills",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FCraterCarveIntoHillsTest::RunTest(const FString& Parameters)
{
    using namespace UE::Geometry;

    UWorld* World = UWorld::CreateWorld(EWorldType::Editor, /*bInformEngineOfWorld*/ false);
    if (!TestNotNull(TEXT("created world"), World)) return false;
    FWorldContext& WorldContext = GEngine->CreateNewWorldContext(EWorldType::Editor);
    WorldContext.SetCurrentWorld(World);

    ACraterTerrainActor* Actor = World->SpawnActor<ACraterTerrainActor>();
    if (TestNotNull(TEXT("spawned ACraterTerrainActor"), Actor))
    {
        Actor->HillAmplitude = 500.0f;
        Actor->HillFrequency = 0.001f;
        Actor->HillOctaves   = 4;
        Actor->HillSeed      = 1;
        Actor->RegenerateGround();

        UDynamicMesh* DM = Actor->GetDynamicMeshComponent()->GetDynamicMesh();
        TestNotNull(TEXT("ground dynamic mesh"), DM);
        if (DM)
        {
            // Snapshot pre-carve heights per vertex id.
            TMap<int32, double> PreZ;
            double PreMaxAll = -1.0e9, PreCenterMin = 1.0e9;
            {
                const FDynamicMesh3& Mesh = DM->GetMeshRef();
                for (int32 Vid : Mesh.VertexIndicesItr())
                {
                    const FVector3d V = Mesh.GetVertex(Vid);
                    PreZ.Add(Vid, V.Z);
                    PreMaxAll = FMath::Max(PreMaxAll, V.Z);
                    if (V.X * V.X + V.Y * V.Y < 120.0 * 120.0)
                        PreCenterMin = FMath::Min(PreCenterMin, V.Z);
                }
            }

            // Terrain actually has relief (hills were applied).
            TestTrue(TEXT("hills produced relief"), PreMaxAll > 50.0);

            const float Radius = 300.0f;
            Actor->CarveCrater(Actor->GetActorLocation(), Radius);

            const FDynamicMesh3& Mesh = DM->GetMeshRef();
            double PostCenterMin = 1.0e9;
            bool   bAnythingRaised = false;
            bool   bFarChanged = false;
            for (int32 Vid : Mesh.VertexIndicesItr())
            {
                const FVector3d V = Mesh.GetVertex(Vid);
                const double Before = PreZ.FindRef(Vid);
                if (V.Z > Before + 1e-3) bAnythingRaised = true;          // carve must only LOWER
                if (V.X * V.X + V.Y * V.Y < 120.0 * 120.0)
                    PostCenterMin = FMath::Min(PostCenterMin, V.Z);
                if (V.X * V.X + V.Y * V.Y > 600.0 * 600.0 &&
                    FMath::Abs(V.Z - Before) > 1e-3) bFarChanged = true;  // far terrain untouched
            }

            TestFalse(TEXT("no vertex raised above its pre-carve height (no lid)"), bAnythingRaised);
            TestFalse(TEXT("far terrain untouched"), bFarChanged);
            TestTrue(FString::Printf(TEXT("center dropped (pre min=%.1f, post min=%.1f, expect >200 drop)"),
                PreCenterMin, PostCenterMin), (PreCenterMin - PostCenterMin) > 200.0);

            AddInfo(FString::Printf(TEXT("PreMaxAll=%.1f PreCenterMin=%.1f PostCenterMin=%.1f"),
                PreMaxAll, PreCenterMin, PostCenterMin));
        }
    }

    GEngine->DestroyWorldContext(World);
    World->DestroyWorld(/*bBroadcastWorldDestroyedEvent*/ false);
    return true;
}
```

- [ ] **Step 3: Run the new test to verify it FAILS**

Build first (editor closed), then:
```
& "D:/Games/EpicGames/UE_5.8/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" "C:/Users/andre/source/repos/Scorched3dUnreal/Scorched3dUnreal.uproject" -ExecCmds="Automation RunTests Scorched.CraterCarve.IntoHills; Quit" -unattended -nopause -nosplash -log
```
Expected: FAIL — "hills produced relief" fails because `RegenerateGround` does not yet apply hills (surface still flat at Z=0, `PreMaxAll==0`).

> Note: if the build fails at this step because the test references hill fields, that's expected only if Step 1 was skipped — Step 1 adds the fields, so the build should succeed and the *test* should fail on the assertion.

- [ ] **Step 4: Apply hills in `RegenerateGround`**

In `Source/Scorched3dUnreal/CraterTerrainActor.cpp`, add the include near the top (after line 6 `#include "CraterMath.h"`):

```cpp
#include "TerrainHeight.h"
```

Then in `RegenerateGround()`, between the `AppendRectangleXY(...)` call (ends line 61) and the `RecomputeNormals` call (line 63-64), insert:

```cpp
    // Displace the flat grid into procedural hills (layered Perlin). Skipped entirely
    // when HillAmplitude<=0, so the surface stays flat at Z=0 (preserves M0 tests).
    if (HillAmplitude > 0.0f)
    {
        TerrainHeight::FParams HP;
        HP.Amplitude = HillAmplitude;
        HP.Frequency = HillFrequency;
        HP.Octaves   = HillOctaves;
        HP.Seed      = HillSeed;

        Mesh->EditMesh([&](UE::Geometry::FDynamicMesh3& EditMesh)
        {
            for (const int32 Vid : EditMesh.VertexIndicesItr())
            {
                FVector3d V = EditMesh.GetVertex(Vid);
                V.Z += TerrainHeight::HeightAt(V.X, V.Y, HP);
                EditMesh.SetVertex(Vid, V);
            }
        });
    }
```

- [ ] **Step 5: Run the new test to verify it PASSES, and confirm M0 tests still pass**

```
& "D:/Games/EpicGames/UE_5.8/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" "C:/Users/andre/source/repos/Scorched3dUnreal/Scorched3dUnreal.uproject" -ExecCmds="Automation RunTests Scorched.CraterCarve; Quit" -unattended -nopause -nosplash -log
```
Expected: both `Scorched.CraterCarve.RealDepression` (flat, default amplitude 0) and `Scorched.CraterCarve.IntoHills` report `Result={Success}`.

- [ ] **Step 6: Commit**

```
git add Source/Scorched3dUnreal/CraterTerrainActor.h Source/Scorched3dUnreal/CraterTerrainActor.cpp Source/Scorched3dUnreal/Tests/CraterCarveTest.cpp
git commit -m "feat: procedural hills in CraterTerrainActor (carve-into-hills tested)"
```

---

## Task 3: Rocket projectile

**Files:**
- Create: `Source/Scorched3dUnreal/RocketProjectile.h`
- Create: `Source/Scorched3dUnreal/RocketProjectile.cpp`

**Interfaces:**
- Consumes: `ACraterTerrainActor::CarveCrater(FVector, float)` (existing).
- Produces:
  - `class ARocketProjectile : public AActor` with `void Launch(const FVector& Direction, float Speed);`
  - Tunables (UPROPERTY): `float CraterRadius=400.0f`, `float ExplosionRadius=600.0f`, `float ExplosionImpulse=80000.0f`.
  - On impact: carves the hit terrain (or nearest `ACraterTerrainActor`), applies a radial impulse to nearby physics bodies, draws a debug flash, then destroys itself.

- [ ] **Step 1: Write the header**

Create `Source/Scorched3dUnreal/RocketProjectile.h`:

```cpp
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "RocketProjectile.generated.h"

class USphereComponent;
class UStaticMeshComponent;
class UProjectileMovementComponent;
class USoundBase;

UCLASS()
class SCORCHED3DUNREAL_API ARocketProjectile : public AActor
{
    GENERATED_BODY()

public:
    ARocketProjectile();

    /** Sine-bowl crater radius carved into terrain on impact (cm). */
    UPROPERTY(EditAnywhere, Category = "Rocket") float CraterRadius = 400.0f;

    /** Radius of the physics shove on impact (cm). */
    UPROPERTY(EditAnywhere, Category = "Rocket") float ExplosionRadius = 600.0f;

    /** Strength of the radial impulse applied to nearby physics bodies. */
    UPROPERTY(EditAnywhere, Category = "Rocket") float ExplosionImpulse = 80000.0f;

    /** Optional impact sound (defaults to none to avoid Content dependencies). */
    UPROPERTY(EditAnywhere, Category = "Rocket") USoundBase* ImpactSound = nullptr;

    /** Set the rocket's initial velocity = normalized Direction * Speed (cm/s). */
    void Launch(const FVector& Direction, float Speed);

protected:
    UPROPERTY(VisibleAnywhere, Category = "Rocket") USphereComponent* Collision;
    UPROPERTY(VisibleAnywhere, Category = "Rocket") UStaticMeshComponent* Mesh;
    UPROPERTY(VisibleAnywhere, Category = "Rocket") UProjectileMovementComponent* Movement;

    UFUNCTION()
    void OnHit(UPrimitiveComponent* HitComp, AActor* OtherActor,
        UPrimitiveComponent* OtherComp, FVector NormalImpulse, const FHitResult& Hit);

    void Explode(const FVector& Point, AActor* HitActor);
};
```

- [ ] **Step 2: Write the implementation**

Create `Source/Scorched3dUnreal/RocketProjectile.cpp`:

```cpp
#include "RocketProjectile.h"
#include "Components/SphereComponent.h"
#include "Components/StaticMeshComponent.h"
#include "GameFramework/ProjectileMovementComponent.h"
#include "UObject/ConstructorHelpers.h"
#include "Kismet/GameplayStatics.h"
#include "Engine/World.h"
#include "DrawDebugHelpers.h"
#include "CraterTerrainActor.h"

ARocketProjectile::ARocketProjectile()
{
    PrimaryActorTick.bCanEverTick = false;

    Collision = CreateDefaultSubobject<USphereComponent>(TEXT("Collision"));
    Collision->InitSphereRadius(20.0f);
    Collision->SetCollisionProfileName(TEXT("BlockAllDynamic"));
    Collision->SetNotifyRigidBodyCollision(true); // generate Hit events
    RootComponent = Collision;
    Collision->OnComponentHit.AddDynamic(this, &ARocketProjectile::OnHit);

    Mesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Mesh"));
    Mesh->SetupAttachment(Collision);
    Mesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    Mesh->SetRelativeScale3D(FVector(0.4f));
    static ConstructorHelpers::FObjectFinder<UStaticMesh> SphereMesh(
        TEXT("/Engine/BasicShapes/Sphere.Sphere"));
    if (SphereMesh.Succeeded())
    {
        Mesh->SetStaticMesh(SphereMesh.Object);
    }

    Movement = CreateDefaultSubobject<UProjectileMovementComponent>(TEXT("Movement"));
    Movement->UpdatedComponent = Collision;
    Movement->bRotationFollowsVelocity = true;
    Movement->bShouldBounce = false;
    Movement->ProjectileGravityScale = 1.0f;
    Movement->InitialSpeed = 0.0f; // set by Launch()
    Movement->MaxSpeed = 0.0f;     // 0 = uncapped

    InitialLifeSpan = 15.0f; // fail-safe if it never hits anything
}

void ARocketProjectile::Launch(const FVector& Direction, float Speed)
{
    if (Movement)
    {
        Movement->Velocity = Direction.GetSafeNormal() * Speed;
    }
}

void ARocketProjectile::OnHit(UPrimitiveComponent* /*HitComp*/, AActor* OtherActor,
    UPrimitiveComponent* /*OtherComp*/, FVector /*NormalImpulse*/, const FHitResult& Hit)
{
    const FVector Point = Hit.bBlockingHit ? Hit.ImpactPoint : GetActorLocation();
    Explode(Point, OtherActor);
    Destroy();
}

void ARocketProjectile::Explode(const FVector& Point, AActor* HitActor)
{
    UWorld* World = GetWorld();
    if (!World) return;

    // Carve the terrain we hit, else the first terrain actor in the world.
    ACraterTerrainActor* Terrain = Cast<ACraterTerrainActor>(HitActor);
    if (!Terrain)
    {
        TArray<AActor*> Found;
        UGameplayStatics::GetAllActorsOfClass(World, ACraterTerrainActor::StaticClass(), Found);
        if (Found.Num() > 0) Terrain = Cast<ACraterTerrainActor>(Found[0]);
    }
    if (Terrain)
    {
        Terrain->CarveCrater(Point, CraterRadius);
    }

    // Shove nearby physics bodies.
    TArray<FOverlapResult> Overlaps;
    FCollisionShape Shape = FCollisionShape::MakeSphere(ExplosionRadius);
    World->OverlapMultiByObjectType(Overlaps, Point, FQuat::Identity,
        FCollisionObjectQueryParams(ECC_PhysicsBody), Shape);
    for (const FOverlapResult& O : Overlaps)
    {
        if (UPrimitiveComponent* Prim = O.GetComponent())
        {
            if (Prim->IsSimulatingPhysics())
            {
                Prim->AddRadialImpulse(Point, ExplosionRadius, ExplosionImpulse,
                    ERadialImpulseFalloff::RIF_Linear, /*bVelChange*/ true);
            }
        }
    }

    // Cheap procedural flash (no Content needed) + optional sound.
    DrawDebugSphere(World, Point, ExplosionRadius, 16, FColor::Orange, /*persistent*/ false, /*life*/ 1.0f);
    if (ImpactSound)
    {
        UGameplayStatics::PlaySoundAtLocation(World, ImpactSound, Point);
    }
}
```

- [ ] **Step 3: Build to verify it compiles**

Editor closed:
```
& "D:/Games/EpicGames/UE_5.8/Engine/Build/BatchFiles/Build.bat" Scorched3dUnrealEditor Win64 Development -Project="C:/Users/andre/source/repos/Scorched3dUnreal/Scorched3dUnreal.uproject" -WaitMutex
```
Expected: `Result: Succeeded`. (No headless test — this is a physics/spawn actor; behavior is validated in Task 6.)

- [ ] **Step 4: Commit**

```
git add Source/Scorched3dUnreal/RocketProjectile.h Source/Scorched3dUnreal/RocketProjectile.cpp
git commit -m "feat: ARocketProjectile — gravity arc that carves terrain on impact"
```

---

## Task 4: Free-fly camera pawn with Enhanced Input

**Files:**
- Create: `Source/Scorched3dUnreal/FlyCameraPawn.h`
- Create: `Source/Scorched3dUnreal/FlyCameraPawn.cpp`

> Requires the `EnhancedInput` module on the include path. It is an engine plugin enabled by default in 5.8 (the project's `DefaultInput.ini` already sets `DefaultInputComponentClass=/Script/EnhancedInput.EnhancedInputComponent`), but the `Build.cs` module dependency is added in Task 6. **If this task is built before Task 6, the Enhanced Input includes will not resolve** — either do Task 6's `Build.cs` edit first, or accept that this task's build check happens after Task 6. Recommended: apply the one-line `Build.cs` change from Task 6 Step 1 now if building this task in isolation.

**Interfaces:**
- Consumes: `ARocketProjectile::Launch` and `ARocketProjectile` class (Task 3).
- Produces:
  - `class AFlyCameraPawn : public APawn` (spawnable as a default pawn).
  - Tunables: `float MoveSpeed=3000.0f`, `float LookSensitivity=1.0f`, `float LaunchSpeed=8000.0f`, `TSubclassOf<ARocketProjectile> RocketClass` (defaults to `ARocketProjectile::StaticClass()`).
  - Controls: WASD move, mouse look, E/Q up/down, LMB fire.

- [ ] **Step 1: Write the header**

Create `Source/Scorched3dUnreal/FlyCameraPawn.h`:

```cpp
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "Templates/SubclassOf.h"
#include "FlyCameraPawn.generated.h"

class UCameraComponent;
class UFloatingPawnMovement;
class UInputMappingContext;
class UInputAction;
class ARocketProjectile;
struct FInputActionValue;

UCLASS()
class SCORCHED3DUNREAL_API AFlyCameraPawn : public APawn
{
    GENERATED_BODY()

public:
    AFlyCameraPawn();

    UPROPERTY(EditAnywhere, Category = "Fly") float MoveSpeed = 3000.0f;       // cm/s
    UPROPERTY(EditAnywhere, Category = "Fly") float LookSensitivity = 1.0f;
    UPROPERTY(EditAnywhere, Category = "Rocket") float LaunchSpeed = 8000.0f;   // cm/s
    UPROPERTY(EditAnywhere, Category = "Rocket") TSubclassOf<ARocketProjectile> RocketClass;

protected:
    virtual void BeginPlay() override;
    virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;

    UPROPERTY(VisibleAnywhere, Category = "Fly") UCameraComponent* Camera;
    UPROPERTY(VisibleAnywhere, Category = "Fly") UFloatingPawnMovement* Movement;

    UPROPERTY() UInputMappingContext* MappingContext;
    UPROPERTY() UInputAction* MoveAction;
    UPROPERTY() UInputAction* LookAction;
    UPROPERTY() UInputAction* VerticalAction;
    UPROPERTY() UInputAction* FireAction;

    void BuildInput();                          // create actions + mapping context (idempotent)
    void OnMove(const FInputActionValue& Value);
    void OnLook(const FInputActionValue& Value);
    void OnVertical(const FInputActionValue& Value);
    void OnFire(const FInputActionValue& Value);
};
```

- [ ] **Step 2: Write the implementation**

Create `Source/Scorched3dUnreal/FlyCameraPawn.cpp`:

```cpp
#include "FlyCameraPawn.h"
#include "Camera/CameraComponent.h"
#include "GameFramework/FloatingPawnMovement.h"
#include "GameFramework/PlayerController.h"
#include "Engine/LocalPlayer.h"
#include "Engine/World.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "InputAction.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "InputActionValue.h"
#include "RocketProjectile.h"

AFlyCameraPawn::AFlyCameraPawn()
{
    PrimaryActorTick.bCanEverTick = false;
    AutoPossessPlayer = EAutoReceiveInput::Player0; // controllable even if placed manually

    Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
    RootComponent = Camera;

    Movement = CreateDefaultSubobject<UFloatingPawnMovement>(TEXT("Movement"));
    Movement->UpdatedComponent = Camera;
    Movement->MaxSpeed = MoveSpeed;
    Movement->Acceleration = 8000.0f;
    Movement->Deceleration = 8000.0f;

    // Pawn turns with the controller; the camera (root) follows, so "forward" tracks look.
    bUseControllerRotationYaw = true;
    bUseControllerRotationPitch = true;
    bUseControllerRotationRoll = false;

    RocketClass = ARocketProjectile::StaticClass();
}

void AFlyCameraPawn::BuildInput()
{
    if (MoveAction) return; // already built

    MappingContext = NewObject<UInputMappingContext>(this);

    MoveAction = NewObject<UInputAction>(this);
    MoveAction->ValueType = EInputActionValueType::Axis2D;
    LookAction = NewObject<UInputAction>(this);
    LookAction->ValueType = EInputActionValueType::Axis2D;
    VerticalAction = NewObject<UInputAction>(this);
    VerticalAction->ValueType = EInputActionValueType::Axis1D;
    FireAction = NewObject<UInputAction>(this);
    FireAction->ValueType = EInputActionValueType::Boolean;

    // --- Move (Axis2D): X = forward (W/S), Y = right (A/D) ---
    MappingContext->MapKey(MoveAction, EKeys::W); // +X
    {
        FEnhancedActionKeyMapping& M = MappingContext->MapKey(MoveAction, EKeys::S);
        M.Modifiers.Add(NewObject<UInputModifierNegate>(this)); // -X
    }
    {
        FEnhancedActionKeyMapping& M = MappingContext->MapKey(MoveAction, EKeys::D);
        UInputModifierSwizzleAxis* Swiz = NewObject<UInputModifierSwizzleAxis>(this);
        Swiz->Order = EInputAxisSwizzle::YXZ; // route the key's value onto Y => +Y (right)
        M.Modifiers.Add(Swiz);
    }
    {
        FEnhancedActionKeyMapping& M = MappingContext->MapKey(MoveAction, EKeys::A);
        UInputModifierSwizzleAxis* Swiz = NewObject<UInputModifierSwizzleAxis>(this);
        Swiz->Order = EInputAxisSwizzle::YXZ;
        M.Modifiers.Add(Swiz);                                  // value onto Y
        M.Modifiers.Add(NewObject<UInputModifierNegate>(this)); // then negate => -Y (left)
    }

    // --- Look (Axis2D): mouse delta (X=yaw, Y=pitch) ---
    MappingContext->MapKey(LookAction, EKeys::Mouse2D);

    // --- Vertical (Axis1D): E up (+1), Q down (-1) ---
    MappingContext->MapKey(VerticalAction, EKeys::E);
    {
        FEnhancedActionKeyMapping& M = MappingContext->MapKey(VerticalAction, EKeys::Q);
        M.Modifiers.Add(NewObject<UInputModifierNegate>(this));
    }

    // --- Fire (Boolean): left mouse button ---
    MappingContext->MapKey(FireAction, EKeys::LeftMouseButton);
}

void AFlyCameraPawn::BeginPlay()
{
    Super::BeginPlay();
    BuildInput();

    if (APlayerController* PC = Cast<APlayerController>(GetController()))
    {
        if (ULocalPlayer* LP = PC->GetLocalPlayer())
        {
            if (UEnhancedInputLocalPlayerSubsystem* Sub =
                    ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(LP))
            {
                Sub->AddMappingContext(MappingContext, /*Priority*/ 0);
            }
        }
        PC->bShowMouseCursor = false;
    }
}

void AFlyCameraPawn::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
    Super::SetupPlayerInputComponent(PlayerInputComponent);
    BuildInput();

    if (UEnhancedInputComponent* EIC = Cast<UEnhancedInputComponent>(PlayerInputComponent))
    {
        EIC->BindAction(MoveAction, ETriggerEvent::Triggered, this, &AFlyCameraPawn::OnMove);
        EIC->BindAction(LookAction, ETriggerEvent::Triggered, this, &AFlyCameraPawn::OnLook);
        EIC->BindAction(VerticalAction, ETriggerEvent::Triggered, this, &AFlyCameraPawn::OnVertical);
        EIC->BindAction(FireAction, ETriggerEvent::Started, this, &AFlyCameraPawn::OnFire);
    }
}

void AFlyCameraPawn::OnMove(const FInputActionValue& Value)
{
    const FVector2D Axis = Value.Get<FVector2D>();
    AddMovementInput(GetActorForwardVector(), Axis.X);
    AddMovementInput(GetActorRightVector(), Axis.Y);
}

void AFlyCameraPawn::OnLook(const FInputActionValue& Value)
{
    const FVector2D Axis = Value.Get<FVector2D>();
    AddControllerYawInput(Axis.X * LookSensitivity);
    AddControllerPitchInput(-Axis.Y * LookSensitivity); // mouse-up looks up
}

void AFlyCameraPawn::OnVertical(const FInputActionValue& Value)
{
    AddMovementInput(FVector::UpVector, Value.Get<float>());
}

void AFlyCameraPawn::OnFire(const FInputActionValue& /*Value*/)
{
    UWorld* World = GetWorld();
    if (!World || !RocketClass || !Camera) return;

    const FVector Forward = Camera->GetForwardVector();
    const FVector SpawnLoc = Camera->GetComponentLocation() + Forward * 150.0f;
    const FRotator SpawnRot = Camera->GetComponentRotation();

    FActorSpawnParameters Params;
    Params.Owner = this;
    Params.Instigator = GetInstigator();
    Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

    ARocketProjectile* Rocket = World->SpawnActor<ARocketProjectile>(
        RocketClass, SpawnLoc, SpawnRot, Params);
    if (Rocket)
    {
        Rocket->Launch(Forward, LaunchSpeed);
    }
}
```

- [ ] **Step 3: Build to verify it compiles**

(Apply Task 6 Step 1's `Build.cs` edit first if building in isolation — see the note above.)
```
& "D:/Games/EpicGames/UE_5.8/Engine/Build/BatchFiles/Build.bat" Scorched3dUnrealEditor Win64 Development -Project="C:/Users/andre/source/repos/Scorched3dUnreal/Scorched3dUnreal.uproject" -WaitMutex
```
Expected: `Result: Succeeded`.

- [ ] **Step 4: Commit**

```
git add Source/Scorched3dUnreal/FlyCameraPawn.h Source/Scorched3dUnreal/FlyCameraPawn.cpp
git commit -m "feat: AFlyCameraPawn — free-fly + runtime Enhanced Input + fire rockets"
```

---

## Task 5: Sandbox game mode (spawns terrain + lighting)

**Files:**
- Create: `Source/Scorched3dUnreal/SandboxGameMode.h`
- Create: `Source/Scorched3dUnreal/SandboxGameMode.cpp`

**Interfaces:**
- Consumes: `AFlyCameraPawn` (Task 4), `ACraterTerrainActor` + its public `GridExtent`/`GridResolution`/`HillAmplitude`/`HillFrequency`/`HillSeed` (Task 2).
- Produces: `class ASandboxGameMode : public AGameModeBase` with `DefaultPawnClass = AFlyCameraPawn`. On `BeginPlay` it idempotently spawns one hilly terrain + sun/sky/skylight/fog if absent, and lifts the player above the terrain.

- [ ] **Step 1: Write the header**

Create `Source/Scorched3dUnreal/SandboxGameMode.h`:

```cpp
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "SandboxGameMode.generated.h"

UCLASS()
class SCORCHED3DUNREAL_API ASandboxGameMode : public AGameModeBase
{
    GENERATED_BODY()

public:
    ASandboxGameMode();

    UPROPERTY(EditAnywhere, Category = "Sandbox") float TerrainExtent = 60000.0f;     // cm (600 m)
    UPROPERTY(EditAnywhere, Category = "Sandbox") int32 TerrainResolution = 256;
    UPROPERTY(EditAnywhere, Category = "Sandbox") float HillAmplitude = 3000.0f;       // cm (30 m)
    UPROPERTY(EditAnywhere, Category = "Sandbox") float HillFrequency = 0.0001f;
    UPROPERTY(EditAnywhere, Category = "Sandbox") int32 HillSeed = 7;

protected:
    virtual void BeginPlay() override;

    void EnsureTerrain();
    void EnsureLighting();
    void PlacePlayerAboveTerrain();
};
```

- [ ] **Step 2: Write the implementation**

Create `Source/Scorched3dUnreal/SandboxGameMode.cpp`:

```cpp
#include "SandboxGameMode.h"
#include "FlyCameraPawn.h"
#include "CraterTerrainActor.h"
#include "Kismet/GameplayStatics.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/Pawn.h"
#include "Engine/DirectionalLight.h"
#include "Components/DirectionalLightComponent.h"
#include "Engine/SkyLight.h"
#include "Components/SkyLightComponent.h"
#include "Engine/ExponentialHeightFog.h"
#include "Components/SkyAtmosphereComponent.h" // declares ASkyAtmosphere

ASandboxGameMode::ASandboxGameMode()
{
    DefaultPawnClass = AFlyCameraPawn::StaticClass();
}

void ASandboxGameMode::BeginPlay()
{
    Super::BeginPlay();
    EnsureLighting();
    EnsureTerrain();
    PlacePlayerAboveTerrain();
}

void ASandboxGameMode::EnsureTerrain()
{
    UWorld* World = GetWorld();
    if (!World) return;

    TArray<AActor*> Existing;
    UGameplayStatics::GetAllActorsOfClass(World, ACraterTerrainActor::StaticClass(), Existing);
    if (Existing.Num() > 0) return;

    // Deferred spawn so hill settings are applied BEFORE the actor's BeginPlay/RegenerateGround.
    const FTransform Xf = FTransform::Identity;
    ACraterTerrainActor* Terrain = World->SpawnActorDeferred<ACraterTerrainActor>(
        ACraterTerrainActor::StaticClass(), Xf);
    if (!Terrain) return;

    Terrain->GridExtent = TerrainExtent;
    Terrain->GridResolution = TerrainResolution;
    Terrain->HillAmplitude = HillAmplitude;
    Terrain->HillFrequency = HillFrequency;
    Terrain->HillSeed = HillSeed;

    UGameplayStatics::FinishSpawningActor(Terrain, Xf); // BeginPlay -> RegenerateGround with hills
}

void ASandboxGameMode::EnsureLighting()
{
    UWorld* World = GetWorld();
    if (!World) return;

    auto NoneOf = [World](UClass* Cls)
    {
        TArray<AActor*> Found;
        UGameplayStatics::GetAllActorsOfClass(World, Cls, Found);
        return Found.Num() == 0;
    };

    if (NoneOf(ADirectionalLight::StaticClass()))
    {
        const FRotator SunRot(-45.0f, -45.0f, 0.0f); // pitch down 45, yaw 45
        ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(
            ADirectionalLight::StaticClass(), FVector::ZeroVector, SunRot);
        if (Sun)
        {
            Sun->SetMobility(EComponentMobility::Movable);
            if (UDirectionalLightComponent* C = Cast<UDirectionalLightComponent>(Sun->GetLightComponent()))
            {
                C->SetIntensity(8.0f);
                C->SetAtmosphereSunLight(true); // drive the sky atmosphere
            }
        }
    }

    if (NoneOf(ASkyAtmosphere::StaticClass()))
    {
        World->SpawnActor<ASkyAtmosphere>(ASkyAtmosphere::StaticClass());
    }

    if (NoneOf(ASkyLight::StaticClass()))
    {
        ASkyLight* Sky = World->SpawnActor<ASkyLight>(ASkyLight::StaticClass());
        if (Sky)
        {
            Sky->SetMobility(EComponentMobility::Movable);
            if (USkyLightComponent* C = Sky->GetLightComponent())
            {
                C->SetRealTimeCaptureEnabled(true); // capture the atmosphere for ambient light
                C->RecaptureSky();
            }
        }
    }

    if (NoneOf(AExponentialHeightFog::StaticClass()))
    {
        World->SpawnActor<AExponentialHeightFog>(AExponentialHeightFog::StaticClass());
    }
}

void ASandboxGameMode::PlacePlayerAboveTerrain()
{
    UWorld* World = GetWorld();
    if (!World) return;

    APlayerController* PC = UGameplayStatics::GetPlayerController(World, 0);
    if (!PC) return;
    APawn* P = PC->GetPawn();
    if (!P) return;

    // Lift above the hills and look toward the center.
    const FVector Loc(-0.5f * TerrainExtent, 0.0f, HillAmplitude + 6000.0f);
    P->SetActorLocation(Loc);
    const FRotator LookAtCenter = (FVector::ZeroVector - Loc).Rotation();
    PC->SetControlRotation(LookAtCenter);
}
```

- [ ] **Step 3: Build to verify it compiles**

```
& "D:/Games/EpicGames/UE_5.8/Engine/Build/BatchFiles/Build.bat" Scorched3dUnrealEditor Win64 Development -Project="C:/Users/andre/source/repos/Scorched3dUnreal/Scorched3dUnreal.uproject" -WaitMutex
```
Expected: `Result: Succeeded`.

- [ ] **Step 4: Commit**

```
git add Source/Scorched3dUnreal/SandboxGameMode.h Source/Scorched3dUnreal/SandboxGameMode.cpp
git commit -m "feat: ASandboxGameMode — spawns hilly terrain + sky/sun/fog, fly pawn default"
```

---

## Task 6: Wiring + full build + in-engine acceptance

**Files:**
- Modify: `Source/Scorched3dUnreal/Scorched3dUnreal.Build.cs` (add `EnhancedInput`)
- Modify: `Config/DefaultEngine.ini` (default GameMode + map)

**Interfaces:**
- Consumes: `ASandboxGameMode` (Task 5).
- Produces: `EnhancedInput` available to the module; pressing Play launches the sandbox.

- [ ] **Step 1: Add EnhancedInput to Build.cs**

In `Source/Scorched3dUnreal/Scorched3dUnreal.Build.cs`, change the dependency list (lines 9–13) to include `"EnhancedInput"`:

```csharp
        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core", "CoreUObject", "Engine", "InputCore", "EnhancedInput",
            "GeometryCore", "DynamicMesh", "GeometryFramework", "GeometryScriptingCore"
        });
```

- [ ] **Step 2: Point the default GameMode + map at the sandbox**

In `Config/DefaultEngine.ini`, under `[/Script/EngineSettings.GameMapsSettings]`, change `EditorStartupMap`, `GameDefaultMap`, and `GlobalDefaultGameMode` to:

```ini
EditorStartupMap=/Game/EmptyWorld/EmptyWorld.EmptyWorld
GameDefaultMap=/Game/EmptyWorld/EmptyWorld.EmptyWorld
GlobalDefaultGameMode=/Script/Scorched3dUnreal.SandboxGameMode
```

(Replaces the Third Person template defaults. `EmptyWorld.umap` exists locally under the untracked `Content/`; the GameMode builds the world from C++ regardless. If `EmptyWorld` is absent, any empty level with this GameMode works.)

- [ ] **Step 3: Full build + full headless test sweep**

Editor closed. Build:
```
& "D:/Games/EpicGames/UE_5.8/Engine/Build/BatchFiles/Build.bat" Scorched3dUnrealEditor Win64 Development -Project="C:/Users/andre/source/repos/Scorched3dUnreal/Scorched3dUnreal.uproject" -WaitMutex
```
Expected: `Result: Succeeded`.

Run all project tests to confirm no regressions:
```
& "D:/Games/EpicGames/UE_5.8/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" "C:/Users/andre/source/repos/Scorched3dUnreal/Scorched3dUnreal.uproject" -ExecCmds="Automation RunTests Scorched; Quit" -unattended -nopause -nosplash -log
```
Expected: `Scorched.CraterMath.DepthProfile`, `Scorched.TerrainHeight.Profile`, `Scorched.CraterCarve.RealDepression`, `Scorched.CraterCarve.IntoHills` all `Result={Success}`.

- [ ] **Step 4: In-engine acceptance (manual)**

Open the project in the editor and press **Play** (or **Alt+P**). Confirm the acceptance criteria:

1. You spawn above a large, **hilly** terrain under a lit sky (sun + fog).
2. **WASD** moves relative to where you look; **mouse** looks around; **E/Q** rise/descend.
3. **Left-click** lobs a rocket that **arcs** under gravity.
4. Where the rocket lands, a **crater** carves into the terrain (and a brief orange debug sphere flashes).
5. Firing into a hillside carves the slope; nothing pops up a "lid".

If movement axes feel inverted (e.g., mouse pitch or A/D direction), adjust the sign in the corresponding `On*` handler or the Negate/Swizzle modifier in `BuildInput()` and rebuild.

- [ ] **Step 5: Commit**

```
git add Source/Scorched3dUnreal/Scorched3dUnreal.Build.cs Config/DefaultEngine.ini
git commit -m "chore: wire EnhancedInput module + default to SandboxGameMode/EmptyWorld"
```

---

## Self-Review

**Spec coverage:**
- Procedural rolling hills → Task 1 (`TerrainHeight`) + Task 2 (integration). ✅
- Default amplitude 0 preserves M0 tests → Task 2 (header default + flat path) + Task 6 Step 3 regression sweep. ✅
- Free-fly pawn + Enhanced Input (runtime) + WASD/mouse/Q-E/scroll/LMB → Task 4. *(Note: scroll-to-change-speed from the spec is **not** implemented to keep input minimal; `MaxSpeed` is a fixed tunable. Documented as a deliberate cut — flag for the user.)*
- Rocket (gravity arc) + carve-on-impact + simple FX → Task 3. ✅
- Code-driven GameMode spawns terrain + sun/sky/skylight/fog, places player → Task 5. ✅
- EnhancedInput module + DefaultEngine.ini default GameMode/map → Task 6. ✅
- Headless tests (TerrainHeight; carve-into-hills; M0 stays green) + in-engine acceptance → Tasks 1, 2, 6. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output. ✅

**Type consistency:** `TerrainHeight::FParams`/`HeightAt` signatures match across Tasks 1–2. `ACraterTerrainActor` hill fields (`HillAmplitude`/`HillFrequency`/`HillOctaves`/`HillSeed`) are public and used identically in Tasks 2 and 5. `ARocketProjectile::Launch(const FVector&, float)` defined in Task 3, called in Task 4. `AFlyCameraPawn` referenced as `DefaultPawnClass` in Task 5. `EInputAxisSwizzle::YXZ`, `UInputModifierNegate`, `UInputModifierSwizzleAxis`, `EInputActionValueType::{Axis1D,Axis2D,Boolean}`, `UInputMappingContext::MapKey` → `FEnhancedActionKeyMapping&` with `.Modifiers` — all verified against UE 5.8 engine source. ✅

**One known deviation to confirm with the user:** mouse-wheel speed control was dropped (fixed `MoveSpeed` instead). Easy to add later as a `Speed` Axis1D action bound to `EKeys::MouseWheelAxis` adjusting `Movement->MaxSpeed`.
