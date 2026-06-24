# Terrain-Crater Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that we can carve a sine-bowl crater into a `UDynamicMesh` ground at runtime and have its collision rebuild so dropped objects settle into it.

**Architecture:** Add a C++ game module to the (currently Blueprint-only) UE 5.8 project. A single `ACraterTerrainActor` (subclass of `ADynamicMeshActor`) generates a flat grid ground mesh, then on demand builds a watertight "bowl plug" tool mesh whose vertical profile follows the legacy Scorched3D sine falloff and boolean-subtracts it via GeometryScript. The pure depth math lives in a tiny testable `CraterMath` unit. Click-to-carve input + a dropped physics cube provide visual + collision verification in PIE.

**Tech Stack:** Unreal Engine 5.8, C++; plugins/modules `GeometryFramework` (`UDynamicMeshComponent`, `ADynamicMeshActor`), `GeometryScriptingCore` (mesh primitive + boolean function libraries, `UDynamicMesh`), `GeometryCore`/`DynamicMesh` (`FDynamicMesh3`). Unreal Automation framework for the math unit test. Unreal MCP gateway (`http://localhost:8000/mcp`) for screenshot evidence.

## Global Constraints

- **Engine:** Unreal Engine 5.8 (`.uproject` pins `EngineAssociation: 5.8`). Do not change the engine version.
- **Module name:** `Scorched3dUnreal` (primary game module, matches project + `.uproject` name).
- **No paid dependencies** — first-party GeometryScript only (dossier §4).
- **C++-first:** gameplay logic in C++ exposed via `UFUNCTION(BlueprintCallable)`; no Blueprint-only logic (dossier §3).
- **Crater profile (port verbatim from `.tmp/scorched3d-legacy/scorched/src/common/landscapemap/DeformLandscape.cpp:67-68`):** `depth(dist) = sin((radius - dist)/radius · π/2) · radius · depthScale`, for `0 ≤ dist < radius`; `0` otherwise. Max depth (center) = `radius · depthScale`; depth at rim = `0`.
- **Bedrock floor:** craters must not carve below `BedrockZ` (legacy `lowestHeight` clamp, `DeformLandscape.cpp:202-219`).
- **Build toolchain prerequisite:** Visual Studio 2022 (Desktop C++ / game-dev workload) or Rider must be installed to compile. Confirm before Task 1.
- **Units:** world units are centimeters (Unreal default). Distances/radii in cm.

---

### Task 1: C++ game module scaffolding + empty terrain actor

Convert the Blueprint-only project to C++ by adding a primary game module and a minimal `ACraterTerrainActor` that compiles and can be placed in a level. No crater logic yet.

**Files:**
- Create: `Source/Scorched3dUnreal.Target.cs`
- Create: `Source/Scorched3dUnrealEditor.Target.cs`
- Create: `Source/Scorched3dUnreal/Scorched3dUnreal.Build.cs`
- Create: `Source/Scorched3dUnreal/Scorched3dUnreal.cpp`
- Create: `Source/Scorched3dUnreal/Scorched3dUnreal.h`
- Create: `Source/Scorched3dUnreal/CraterTerrainActor.h`
- Create: `Source/Scorched3dUnreal/CraterTerrainActor.cpp`
- Modify: `Scorched3dUnreal.uproject` (add a `Modules` array)

**Interfaces:**
- Consumes: nothing.
- Produces: module `Scorched3dUnreal`; class `ACraterTerrainActor : public ADynamicMeshActor` with no public methods yet beyond the constructor.

- [ ] **Step 1: Create the game target** — `Source/Scorched3dUnreal.Target.cs`

```csharp
using UnrealBuildTool;
using System.Collections.Generic;

public class Scorched3dUnrealTarget : TargetRules
{
    public Scorched3dUnrealTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Game;
        DefaultBuildSettings = BuildSettingsVersion.V5;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        ExtraModuleNames.Add("Scorched3dUnreal");
    }
}
```

- [ ] **Step 2: Create the editor target** — `Source/Scorched3dUnrealEditor.Target.cs`

```csharp
using UnrealBuildTool;
using System.Collections.Generic;

public class Scorched3dUnrealEditorTarget : TargetRules
{
    public Scorched3dUnrealEditorTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Editor;
        DefaultBuildSettings = BuildSettingsVersion.V5;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        ExtraModuleNames.Add("Scorched3dUnreal");
    }
}
```

- [ ] **Step 3: Create the module build rules** — `Source/Scorched3dUnreal/Scorched3dUnreal.Build.cs`

```csharp
using UnrealBuildTool;

public class Scorched3dUnreal : ModuleRules
{
    public Scorched3dUnreal(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core", "CoreUObject", "Engine", "InputCore",
            "GeometryCore", "DynamicMesh", "GeometryFramework", "GeometryScriptingCore"
        });
    }
}
```

- [ ] **Step 4: Create the module header** — `Source/Scorched3dUnreal/Scorched3dUnreal.h`

```cpp
#pragma once

#include "CoreMinimal.h"
```

- [ ] **Step 5: Create the module implementation** — `Source/Scorched3dUnreal/Scorched3dUnreal.cpp`

```cpp
#include "Scorched3dUnreal.h"
#include "Modules/ModuleManager.h"

IMPLEMENT_PRIMARY_GAME_MODULE(FDefaultGameModuleImpl, Scorched3dUnreal, "Scorched3dUnreal");
```

- [ ] **Step 6: Create the actor header** — `Source/Scorched3dUnreal/CraterTerrainActor.h`

```cpp
#pragma once

#include "CoreMinimal.h"
#include "DynamicMeshActor.h"
#include "CraterTerrainActor.generated.h"

/**
 * Runtime-destructible ground spike. Generates a flat DynamicMesh grid and
 * boolean-subtracts sine-profile crater bowls into it at runtime.
 */
UCLASS()
class SCORCHED3DUNREAL_API ACraterTerrainActor : public ADynamicMeshActor
{
    GENERATED_BODY()

public:
    ACraterTerrainActor();
};
```

- [ ] **Step 7: Create the actor implementation** — `Source/Scorched3dUnreal/CraterTerrainActor.cpp`

```cpp
#include "CraterTerrainActor.h"

ACraterTerrainActor::ACraterTerrainActor()
{
    PrimaryActorTick.bCanEverTick = false;
}
```

- [ ] **Step 8: Register the module in the uproject** — `Scorched3dUnreal.uproject`

Add a top-level `"Modules"` array (sibling of `"Plugins"`), keeping the existing `FileVersion`, `EngineAssociation`, and `Plugins`:

```json
	"Modules": [
		{
			"Name": "Scorched3dUnreal",
			"Type": "Runtime",
			"LoadingPhase": "Default"
		}
	],
```

- [ ] **Step 9: Generate project files and build**

Run (PowerShell, adjust UE path if engine is not at `D:/Games/EpicGames/UE_5.8`):

```powershell
& "D:/Games/EpicGames/UE_5.8/Engine/Build/BatchFiles/Build.bat" Scorched3dUnrealEditor Win64 Development -Project="$PWD/Scorched3dUnreal.uproject" -WaitMutex
```

Expected: `Build succeeded.` (first build also generates `Binaries/` and `Intermediate/`, both git-ignored).
If the engine path differs, find it via the `.uproject` association or the Epic Games launcher install location.

- [ ] **Step 10: Verify the editor loads the module**

Open the project in the UE 5.8 editor. In the Place Actors panel, search "Crater" — `ACraterTerrainActor` should appear (proves the module compiled and loaded). Close the editor.

- [ ] **Step 11: Commit**

```bash
git add Source Scorched3dUnreal.uproject
git commit -m "feat: add Scorched3dUnreal C++ module + empty CraterTerrainActor"
```

---

### Task 2: Crater depth math (`CraterMath`) — pure + unit-tested

Port the legacy sine falloff as a pure, testable function. This is the one piece with a real automated test cycle; everything downstream reuses it.

**Files:**
- Create: `Source/Scorched3dUnreal/CraterMath.h`
- Create: `Source/Scorched3dUnreal/CraterMath.cpp`
- Create: `Source/Scorched3dUnreal/Tests/CraterMathTest.cpp`

**Interfaces:**
- Consumes: nothing.
- Produces: `namespace CraterMath { double DepthAt(double Dist, double Radius, double DepthScale); }` — returns downward crater depth (≥ 0) at radial distance `Dist`. `DepthAt(0, R, S) = R*S`; `DepthAt(d≥R, R, S) = 0`.

- [ ] **Step 1: Write the failing test** — `Source/Scorched3dUnreal/Tests/CraterMathTest.cpp`

```cpp
#include "Misc/AutomationTest.h"
#include "CraterMath.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FCraterMathTest, "Scorched.CraterMath.DepthProfile",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FCraterMathTest::RunTest(const FString& Parameters)
{
    const double R = 100.0;

    // Center is deepest: depth == radius * depthScale.
    TestEqual(TEXT("center depth"), CraterMath::DepthAt(0.0, R, 1.0), 100.0, 1e-3);

    // Rim and beyond are flat (zero depth).
    TestEqual(TEXT("rim depth"), CraterMath::DepthAt(100.0, R, 1.0), 0.0, 1e-6);
    TestEqual(TEXT("outside depth"), CraterMath::DepthAt(150.0, R, 1.0), 0.0, 1e-6);

    // Legacy profile at half radius: sin(0.5 * PI/2) * R == sin(PI/4) * 100.
    TestEqual(TEXT("half-radius depth"), CraterMath::DepthAt(50.0, R, 1.0),
        FMath::Sin(UE_DOUBLE_PI / 4.0) * 100.0, 1e-3);

    // DepthScale scales linearly.
    TestEqual(TEXT("scaled center depth"), CraterMath::DepthAt(0.0, R, 0.5), 50.0, 1e-3);

    // Monotonic decreasing from center to rim.
    double Prev = CraterMath::DepthAt(0.0, R, 1.0);
    for (double d = 10.0; d <= 100.0; d += 10.0)
    {
        const double Cur = CraterMath::DepthAt(d, R, 1.0);
        TestTrue(FString::Printf(TEXT("monotonic at %.0f"), d), Cur <= Prev);
        Prev = Cur;
    }

    // Degenerate radius never crashes / returns zero.
    TestEqual(TEXT("zero radius"), CraterMath::DepthAt(0.0, 0.0, 1.0), 0.0, 1e-6);

    return true;
}
```

- [ ] **Step 2: Create a stub so the test compiles but fails** — `Source/Scorched3dUnreal/CraterMath.h`

```cpp
#pragma once

#include "CoreMinimal.h"

namespace CraterMath
{
    // Legacy DeformLandscape.cpp:67-68 sine-smoothed radial falloff.
    // Returns downward crater depth (>= 0) at radial distance Dist for a crater
    // of the given Radius. depth(0) = Radius*DepthScale; depth(>=Radius) = 0.
    double DepthAt(double Dist, double Radius, double DepthScale);
}
```

`Source/Scorched3dUnreal/CraterMath.cpp`:

```cpp
#include "CraterMath.h"

double CraterMath::DepthAt(double /*Dist*/, double /*Radius*/, double /*DepthScale*/)
{
    return 0.0; // stub — intentionally wrong
}
```

- [ ] **Step 3: Build, then run the test to verify it fails**

Build the editor target (same command as Task 1 Step 9), then run:

```powershell
& "D:/Games/EpicGames/UE_5.8/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" "$PWD/Scorched3dUnreal.uproject" -ExecCmds="Automation RunTests Scorched.CraterMath; Quit" -unattended -nopause -nosplash -log
```

Expected: test runs and FAILS (`center depth` expected 100, got 0). Look for `Test Failed` / `1 test(s) failed` in the log tail.

- [ ] **Step 4: Implement the real profile** — replace the body in `Source/Scorched3dUnreal/CraterMath.cpp`

```cpp
#include "CraterMath.h"

double CraterMath::DepthAt(double Dist, double Radius, double DepthScale)
{
    if (Radius <= 0.0) return 0.0;
    if (Dist < 0.0) Dist = 0.0;
    if (Dist >= Radius) return 0.0;

    // Legacy: explosionDepth = sin((radius - dist)/radius * PI/2) * radius; then * depthScale.
    const double DistToRadius = Radius - Dist;
    return FMath::Sin((DistToRadius / Radius) * (UE_DOUBLE_PI / 2.0)) * Radius * DepthScale;
}
```

- [ ] **Step 5: Build, then run the test to verify it passes**

Build, then re-run the command from Step 3.
Expected: `Scorched.CraterMath.DepthProfile` PASSES (`0 test(s) failed`).

- [ ] **Step 6: Commit**

```bash
git add Source/Scorched3dUnreal/CraterMath.h Source/Scorched3dUnreal/CraterMath.cpp Source/Scorched3dUnreal/Tests/CraterMathTest.cpp
git commit -m "feat: port legacy sine crater depth profile (CraterMath) with unit test"
```

---

### Task 3: Generate the flat ground mesh + collision

Make `ACraterTerrainActor` build a flat grid `UDynamicMesh` at `BeginPlay` and enable complex-as-simple collision so objects can rest on it.

**Files:**
- Modify: `Source/Scorched3dUnreal/CraterTerrainActor.h`
- Modify: `Source/Scorched3dUnreal/CraterTerrainActor.cpp`

**Interfaces:**
- Consumes: `ADynamicMeshActor::GetDynamicMeshComponent()` and `GetDynamicMesh()` from `GeometryFramework`.
- Produces: tunables `GridExtent` (float cm), `GridResolution` (int32 cells/side), `DepthScale` (float), `BedrockZ` (float cm); protected `void RegenerateGround();`.

- [ ] **Step 1: Add properties and declarations** — replace `Source/Scorched3dUnreal/CraterTerrainActor.h` body of the class

```cpp
#pragma once

#include "CoreMinimal.h"
#include "DynamicMeshActor.h"
#include "CraterTerrainActor.generated.h"

UCLASS()
class SCORCHED3DUNREAL_API ACraterTerrainActor : public ADynamicMeshActor
{
    GENERATED_BODY()

public:
    ACraterTerrainActor();

    /** Side length of the square ground patch, in cm. */
    UPROPERTY(EditAnywhere, Category = "Terrain") float GridExtent = 5000.0f;

    /** Number of quads per side. Higher = smoother craters, more cost. */
    UPROPERTY(EditAnywhere, Category = "Terrain") int32 GridResolution = 64;

    /** Scales crater depth (legacy depthScale). Max depth = Radius * DepthScale. */
    UPROPERTY(EditAnywhere, Category = "Crater") float DepthScale = 1.0f;

    /** Craters cannot carve below this world Z (cm) — the bedrock floor. */
    UPROPERTY(EditAnywhere, Category = "Crater") float BedrockZ = -2000.0f;

protected:
    virtual void BeginPlay() override;

    /** (Re)builds the flat ground mesh and refreshes collision. */
    void RegenerateGround();
};
```

- [ ] **Step 2: Implement ground generation** — replace `Source/Scorched3dUnreal/CraterTerrainActor.cpp`

```cpp
#include "CraterTerrainActor.h"
#include "Components/DynamicMeshComponent.h"
#include "UDynamicMesh.h"
#include "GeometryScript/MeshPrimitiveFunctions.h"

ACraterTerrainActor::ACraterTerrainActor()
{
    PrimaryActorTick.bCanEverTick = false;
}

void ACraterTerrainActor::BeginPlay()
{
    Super::BeginPlay();
    RegenerateGround();
}

void ACraterTerrainActor::RegenerateGround()
{
    UDynamicMesh* Mesh = GetDynamicMesh();
    if (!Mesh) return;

    Mesh->Reset();

    FGeometryScriptPrimitiveOptions Options;
    const FTransform Local = FTransform::Identity;

    // Flat rectangle in the XY plane, centered on the actor, subdivided into a grid.
    UGeometryScriptLibrary_MeshPrimitiveFunctions::AppendRectangle(
        Mesh, Options, Local,
        GridExtent, GridExtent,
        GridResolution, GridResolution);

    // Complex-as-simple so the carved surface is collidable at runtime.
    UDynamicMeshComponent* Comp = GetDynamicMeshComponent();
    Comp->SetComplexAsSimpleCollisionEnabled(true, /*bImmediateUpdate*/ true);
    Comp->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
    Comp->UpdateCollision(/*bRebuildOverlaps*/ true);
}
```

> **Signature check (do this first):** open `Engine/Plugins/Runtime/GeometryScripting/Source/GeometryScriptingCore/Public/GeometryScript/MeshPrimitiveFunctions.h` in the installed 5.8 engine and confirm `AppendRectangle`'s parameter order (`StepsWidth`/`StepsHeight` are the last two int args). Confirm `UDynamicMeshComponent::SetComplexAsSimpleCollisionEnabled` / `UpdateCollision` signatures in `Engine/Plugins/Runtime/GeometryProcessing/.../Components/DynamicMeshComponent.h`. Adjust the call if names differ in 5.8.

- [ ] **Step 3: Build**

Build the editor target (Task 1 Step 9 command). Expected: `Build succeeded.`

- [ ] **Step 4: Verify visually in PIE**

Open the editor, place an `ACraterTerrainActor` in an empty level at the origin, add a Directional Light + Player Start above it, Play. Expected: a flat 50 m square surface is visible. (Collision is verified in Task 5.) Save nothing yet.

- [ ] **Step 5: Commit**

```bash
git add Source/Scorched3dUnreal/CraterTerrainActor.h Source/Scorched3dUnreal/CraterTerrainActor.cpp
git commit -m "feat: generate flat DynamicMesh ground with runtime collision"
```

---

### Task 4: Build the sine bowl tool mesh + carve via boolean subtract

Add `CarveCrater`: build a watertight bowl-plug `FDynamicMesh3` whose profile uses `CraterMath::DepthAt`, clamp to bedrock, boolean-subtract it, and rebuild collision.

**Files:**
- Modify: `Source/Scorched3dUnreal/CraterTerrainActor.h`
- Modify: `Source/Scorched3dUnreal/CraterTerrainActor.cpp`

**Interfaces:**
- Consumes: `CraterMath::DepthAt` (Task 2); `RegenerateGround` collision pattern (Task 3); `UGeometryScriptLibrary_MeshBooleanFunctions::ApplyMeshBoolean` (GeometryScriptingCore).
- Produces: `UFUNCTION(BlueprintCallable) void CarveCrater(FVector WorldCenter, float Radius);`.

- [ ] **Step 1: Declare the API and the tool-builder** — add to `ACraterTerrainActor` (public + protected) in `CraterTerrainActor.h`

Public (after the constructor):

```cpp
    /** Carve a sine-profile crater of the given Radius (cm) centered at WorldCenter. */
    UFUNCTION(BlueprintCallable, Category = "Crater")
    void CarveCrater(FVector WorldCenter, float Radius);
```

Protected (after `RegenerateGround`):

```cpp
    /**
     * Builds a watertight "bowl plug" solid around the local origin: a flat top
     * cap at +Radius, a vertical side wall, and a bowl underside following the
     * legacy sine profile down to -MaxDepth at center. Subtracting it from the
     * ground yields the crater. Caller owns nothing — fills the passed UDynamicMesh.
     */
    void BuildCraterToolMesh(UDynamicMesh* ToolMesh, float Radius, float MaxDepth);
```

- [ ] **Step 2: Add includes and the tool-mesh builder** — in `CraterTerrainActor.cpp`, extend the include block and append the function

Add to includes:

```cpp
#include "CraterMath.h"
#include "GeometryScript/MeshBooleanFunctions.h"
#include "DynamicMesh/DynamicMesh3.h"

using namespace UE::Geometry;
```

Append:

```cpp
void ACraterTerrainActor::BuildCraterToolMesh(UDynamicMesh* ToolMesh, float Radius, float MaxDepth)
{
    constexpr int32 NumRings = 24;     // radial subdivisions of the bowl
    constexpr int32 NumSeg = 32;       // angular subdivisions
    const double TopZ = Radius;        // top cap well above the ground surface

    FDynamicMesh3 Mesh;

    // --- Vertices -----------------------------------------------------------
    // Ring r=0 collapses to a single bottom-center vertex; rings 1..NumRings are
    // full circles. Index helper for a (ring, seg) bowl vertex:
    auto BowlIdx = [&](int32 Ring, int32 Seg) -> int32
    {
        return 1 + (Ring - 1) * NumSeg + (Seg % NumSeg); // +1 for the center vertex at index 0
    };

    // 0: bottom center
    Mesh.AppendVertex(FVector3d(0.0, 0.0, -MaxDepth));

    for (int32 Ring = 1; Ring <= NumRings; ++Ring)
    {
        const double Rad = (double(Ring) / NumRings) * Radius;
        const double Depth = FMath::Min(CraterMath::DepthAt(Rad, Radius, DepthScale), (double)MaxDepth);
        for (int32 Seg = 0; Seg < NumSeg; ++Seg)
        {
            const double Ang = (2.0 * UE_DOUBLE_PI * Seg) / NumSeg;
            Mesh.AppendVertex(FVector3d(Rad * FMath::Cos(Ang), Rad * FMath::Sin(Ang), -Depth));
        }
    }

    // Top rim ring (radius, z=TopZ) and top center.
    const int32 TopRingStart = 1 + NumRings * NumSeg;
    for (int32 Seg = 0; Seg < NumSeg; ++Seg)
    {
        const double Ang = (2.0 * UE_DOUBLE_PI * Seg) / NumSeg;
        Mesh.AppendVertex(FVector3d(Radius * FMath::Cos(Ang), Radius * FMath::Sin(Ang), TopZ));
    }
    const int32 TopCenter = Mesh.AppendVertex(FVector3d(0.0, 0.0, TopZ));
    auto TopIdx = [&](int32 Seg) -> int32 { return TopRingStart + (Seg % NumSeg); };

    // --- Triangles ----------------------------------------------------------
    // Bowl underside. Winding chosen so normals point DOWN/out (away from solid).
    for (int32 Seg = 0; Seg < NumSeg; ++Seg)
    {
        // innermost fan around bottom center
        Mesh.AppendTriangle(0, BowlIdx(1, Seg + 1), BowlIdx(1, Seg));
    }
    for (int32 Ring = 1; Ring < NumRings; ++Ring)
    {
        for (int32 Seg = 0; Seg < NumSeg; ++Seg)
        {
            const int32 A = BowlIdx(Ring, Seg);
            const int32 B = BowlIdx(Ring, Seg + 1);
            const int32 C = BowlIdx(Ring + 1, Seg + 1);
            const int32 D = BowlIdx(Ring + 1, Seg);
            Mesh.AppendTriangle(A, C, B);
            Mesh.AppendTriangle(A, D, C);
        }
    }

    // Side wall: bowl outer rim (Ring=NumRings, z=-0..) up to top rim (z=TopZ).
    for (int32 Seg = 0; Seg < NumSeg; ++Seg)
    {
        const int32 BL = BowlIdx(NumRings, Seg);
        const int32 BR = BowlIdx(NumRings, Seg + 1);
        const int32 TL = TopIdx(Seg);
        const int32 TR = TopIdx(Seg + 1);
        Mesh.AppendTriangle(BL, TR, BR);
        Mesh.AppendTriangle(BL, TL, TR);
    }

    // Top cap fan (normals up).
    for (int32 Seg = 0; Seg < NumSeg; ++Seg)
    {
        Mesh.AppendTriangle(TopCenter, TopIdx(Seg), TopIdx(Seg + 1));
    }

    ToolMesh->SetMesh(MoveTemp(Mesh));
}
```

> **Note on the outer bowl rim:** at `Ring=NumRings` the radius is `Radius` and `DepthAt(Radius,…)=0`, so those vertices sit at `z=0` (the ground surface) — the side wall therefore rises from the surface to `TopZ`, giving a closed solid. Good.

- [ ] **Step 3: Implement `CarveCrater`** — append to `CraterTerrainActor.cpp`

```cpp
void ACraterTerrainActor::CarveCrater(FVector WorldCenter, float Radius)
{
    UDynamicMesh* Ground = GetDynamicMesh();
    if (!Ground || Radius <= 0.0f) return;

    // Bedrock clamp: limit depth so the crater bottom never goes below BedrockZ.
    const float MaxByProfile = Radius * DepthScale;
    const float MaxByBedrock = WorldCenter.Z - BedrockZ;
    const float MaxDepth = FMath::Min(MaxByProfile, MaxByBedrock);
    if (MaxDepth <= 0.0f) return; // already at/below bedrock here

    // Build the tool around its local origin (top cap above z=0, bowl below).
    UDynamicMesh* Tool = NewObject<UDynamicMesh>(this);
    BuildCraterToolMesh(Tool, Radius, MaxDepth);

    // Place the tool so its z=0 rim sits at WorldCenter; subtract from ground.
    const FTransform GroundXf = GetActorTransform();
    const FTransform ToolXf(FQuat::Identity, WorldCenter);

    FGeometryScriptMeshBooleanOptions BoolOptions;
    UGeometryScriptLibrary_MeshBooleanFunctions::ApplyMeshBoolean(
        Ground, GroundXf,
        Tool, ToolXf,
        EGeometryScriptBooleanOperation::Subtract,
        BoolOptions);

    // Rebuild collision against the new surface.
    UDynamicMeshComponent* Comp = GetDynamicMeshComponent();
    Comp->UpdateCollision(/*bRebuildOverlaps*/ true);
}
```

> **Signature check (do this first):** confirm `ApplyMeshBoolean` parameters and `EGeometryScriptBooleanOperation::Subtract` in `GeometryScript/MeshBooleanFunctions.h` (5.8). The boolean writes the result back into `Ground` in the ground actor's local space.

- [ ] **Step 4: Build**

Build the editor target. Expected: `Build succeeded.`

- [ ] **Step 5: Verify a crater appears (temporary self-carve)**

Interactive input arrives in Task 5, so verify this task standalone with a temporary call: in `BeginPlay`, immediately after `RegenerateGround()`, add `CarveCrater(GetActorLocation(), 300.0f);`. Build, place an `ACraterTerrainActor` at origin + Directional Light + Player Start, and Play.

Expected: a smooth, round, sine-bowl depression ~3 m wide in the center of the ground; no jagged rim; no geometry below `BedrockZ`.

Then **remove** the temporary `CarveCrater(...)` line and rebuild before committing (BeginPlay should only call `RegenerateGround()`).

- [ ] **Step 6: Commit**

```bash
git add Source/Scorched3dUnreal/CraterTerrainActor.h Source/Scorched3dUnreal/CraterTerrainActor.cpp
git commit -m "feat: carve sine-bowl craters via GeometryScript boolean subtract"
```

---

### Task 5: Click-to-carve input, physics-cube collision proof, test level + verification

Wire interactive carving and prove collision rebuilds by dropping a physics cube into a crater. Assemble the test level and capture screenshot evidence.

**Files:**
- Modify: `Source/Scorched3dUnreal/CraterTerrainActor.h`
- Modify: `Source/Scorched3dUnreal/CraterTerrainActor.cpp`
- Create: `Config/DefaultInput.ini` action mapping (modify existing file)
- Create (in-editor, via MCP or by hand): a test map `Content/Spike/Lvl_CraterSpike.umap`

**Interfaces:**
- Consumes: `CarveCrater` (Task 4).
- Produces: an input-bound carve (left mouse → line trace → `CarveCrater`) and a spawned physics cube on each carve.

- [ ] **Step 1: Enable input + line-trace carve on the actor** — add to `CraterTerrainActor.h`

Add to `protected`:

```cpp
    virtual void NotifyActorOnClicked(FKey ButtonPressed = EKeys::LeftMouseButton) override;

    /** Trace from the camera through the cursor and carve where it hits this ground. */
    void CarveAtCursor();

    /** Drop a physics cube above WorldPoint to visually confirm collision. */
    void SpawnProbeCube(FVector WorldPoint);

    UPROPERTY(EditAnywhere, Category = "Crater") float CarveRadius = 300.0f;
```

- [ ] **Step 2: Implement cursor carve + probe cube** — add includes and methods to `CraterTerrainActor.cpp`

Add to includes:

```cpp
#include "Kismet/GameplayStatics.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMeshActor.h"
#include "UObject/ConstructorHelpers.h"
```

In the constructor body, enable click events:

```cpp
    // (inside ACraterTerrainActor::ACraterTerrainActor())
    // Allow this actor to receive mouse-click notifications in PIE.
```

Append methods:

```cpp
void ACraterTerrainActor::NotifyActorOnClicked(FKey ButtonPressed)
{
    Super::NotifyActorOnClicked(ButtonPressed);
    CarveAtCursor();
}

void ACraterTerrainActor::CarveAtCursor()
{
    APlayerController* PC = UGameplayStatics::GetPlayerController(this, 0);
    if (!PC) return;

    FHitResult Hit;
    if (PC->GetHitResultUnderCursor(ECC_Visibility, /*bTraceComplex*/ true, Hit) &&
        Hit.GetActor() == this)
    {
        CarveCrater(Hit.ImpactPoint, CarveRadius);
        SpawnProbeCube(Hit.ImpactPoint);
    }
}

void ACraterTerrainActor::SpawnProbeCube(FVector WorldPoint)
{
    UStaticMesh* Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
    if (!Cube) return;

    FActorSpawnParameters Params;
    Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
    AStaticMeshActor* Probe = GetWorld()->SpawnActor<AStaticMeshActor>(
        AStaticMeshActor::StaticClass(),
        FTransform(WorldPoint + FVector(0, 0, 600.0)), Params);
    if (!Probe) return;

    Probe->SetMobility(EComponentMobility::Movable);
    UStaticMeshComponent* SM = Probe->GetStaticMeshComponent();
    SM->SetStaticMesh(Cube);
    SM->SetWorldScale3D(FVector(1.5f));
    SM->SetSimulatePhysics(true);
    SM->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
}
```

> **Note:** `GetHitResultUnderCursor` requires the cursor to be shown. The test level's GameMode/PlayerController should have `bShowMouseCursor = true` and click events enabled. Simplest: in the level Blueprint or a one-line PlayerController setting, set `Enable Click Events` + `Show Mouse Cursor`. Alternatively bind a key in Step 3.

- [ ] **Step 3: Add a fallback key binding** — modify `Config/DefaultInput.ini`

Add under `[/Script/Engine.InputSettings]` (so carving works even without click events):

```ini
+ActionMappings=(ActionName="CarveCrater",bShift=False,bCtrl=False,bAlt=False,bCmd=False,Key=SpaceBar)
```

(The Space key triggers a carve at the cursor — bind it from the PlayerController to `CarveAtCursor` during level setup, or rely on click events from Step 1.)

- [ ] **Step 4: Build**

Build the editor target. Expected: `Build succeeded.`

- [ ] **Step 5: Assemble the test level**

Create `Content/Spike/Lvl_CraterSpike.umap` (via the Unreal MCP gateway or by hand) containing:
- One `ACraterTerrainActor` at the origin.
- A `Directional Light` and a `Sky Light` (so the surface and craters are readable).
- A `Player Start` ~1500 cm above the ground.
- Default `GameMode` with `bShowMouseCursor = true` and `bEnableClickEvents = true` on the PlayerController (a minimal C++ or BP PlayerController, or set in the World Settings/level BP).

Set this as the editor + game default map in `Config/DefaultEngine.ini` if convenient (optional for the spike).

- [ ] **Step 6: Verify — carve + collision in PIE**

Play the level. Click (or press Space) on the ground in several spots. Confirm:
1. A sine-bowl crater appears at each click point (mesh deforms).
2. A physics cube drops and **settles inside the crater** (collision rebuilt — the core proof).
3. Clicking the same deep spot repeatedly does not carve below `BedrockZ`.

Capture PIE screenshots via the Unreal MCP gateway (viewport screenshot tool) showing a crater with a cube resting in it. Save as evidence under `docs/superpowers/` or attach to the spike summary.

- [ ] **Step 7: Commit**

```bash
git add Source/Scorched3dUnreal/CraterTerrainActor.h Source/Scorched3dUnreal/CraterTerrainActor.cpp Config/DefaultInput.ini Content/Spike
git commit -m "feat: click-to-carve + physics-cube collision proof + test level"
```

- [ ] **Step 8: Record the spike result**

Append a short "Phase 1 spike result" note to `README.md` (and/or `docs/01-porting-research.md` §4): whether GeometryScript runtime booleans proved out for craters + collision, with a screenshot link. This closes the spike and informs the Phase 2 go/no-go on terrain tech.

```bash
git add README.md docs/01-porting-research.md
git commit -m "docs: record Phase 1 terrain-crater spike result"
```

---

## Notes for the implementer

- **Engine path:** commands assume `D:/Games/EpicGames/UE_5.8`. The dossier confirms the engine is installed there; if not, locate it via the Epic launcher and substitute.
- **GeometryScript signatures:** UE 5.8 GeometryScript is stabilising; the two flagged "signature check" steps (Task 3 Step 2, Task 4 Steps 2-3) exist because exact parameter lists can shift between point releases. Confirm against the installed headers before building — these are quick header reads, not redesigns.
- **Boolean robustness:** if `ApplyMeshBoolean` produces holes at very shallow `MaxDepth` (bedrock-clamped near-flat tool), increase `NumRings`/`NumSeg` or skip carving when `MaxDepth` is below a small epsilon (already guarded by `MaxDepth <= 0`).
- **Out of scope (deferred per spec §7):** perf-at-scale (50-100 craters), dirt settling, projectile/gameplay integration. Do not add them here.
