#include "CraterTerrainActor.h"
#include "Components/DynamicMeshComponent.h"
#include "UDynamicMesh.h"
#include "GeometryScript/MeshPrimitiveFunctions.h"
#include "CraterMath.h"
#include "GeometryScript/MeshBooleanFunctions.h"
#include "DynamicMesh/DynamicMesh3.h"
#include "Kismet/GameplayStatics.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMeshActor.h"

using namespace UE::Geometry;

ACraterTerrainActor::ACraterTerrainActor()
{
    PrimaryActorTick.bCanEverTick = false;
}

void ACraterTerrainActor::BeginPlay()
{
    Super::BeginPlay();
    RegenerateGround();
    if (bDemoCarveOnBeginPlay)
    {
        RunDemoCarve();
    }
}

void ACraterTerrainActor::RunDemoCarve()
{
    const FVector Base = GetActorLocation();
    const float Spacing = CarveRadius * 2.5f;
    const float StartX = -0.5f * Spacing * (DemoCraterCount - 1);
    for (int32 i = 0; i < DemoCraterCount; ++i)
    {
        const FVector Center = Base + FVector(StartX + i * Spacing, 0.0f, 0.0f);
        CarveCrater(Center, CarveRadius);
        SpawnProbeCube(Center);
    }
}

void ACraterTerrainActor::RegenerateGround()
{
    UDynamicMeshComponent* Comp = GetDynamicMeshComponent();
    if (!Comp) return;

    UDynamicMesh* Mesh = Comp->GetDynamicMesh();
    if (!Mesh) return;

    Mesh->Reset();

    FGeometryScriptPrimitiveOptions Options;

    // Closed box slab instead of a single-sided plane: subtracting the crater bowl
    // leaves a real concave crater the probe cube can rest in (a plane just gets a
    // hole punched clean through). AppendBox (UE 5.8) signature, MeshPrimitiveFunctions.h:168-179:
    //   AppendBox(Mesh, Options, Transform, DimX, DimY, DimZ, StepsX, StepsY, StepsZ, Origin=Base)
    // Origin=Base builds the box spanning [0, DimZ] up from the transform origin, so we
    // translate the transform to Z = -SlabThickness, putting the TOP face at local Z = 0
    // (where the crater tool's rim sits). StepsZ=1; top/bottom faces get GridResolution
    // subdivisions so craters carve smoothly.
    const FTransform SlabXf(FQuat::Identity, FVector(0.0f, 0.0f, -SlabThickness));
    UGeometryScriptLibrary_MeshPrimitiveFunctions::AppendBox(
        Mesh, Options, SlabXf,
        GridExtent, GridExtent, SlabThickness,
        GridResolution, GridResolution, /*StepsZ*/ 1,
        EGeometryScriptPrimitiveOriginMode::Base);

    // Complex-as-simple so the carved surface is collidable at runtime.
    // bImmediateUpdate=false defers the rebuild so we do a single explicit UpdateCollision below,
    // avoiding a double full rebuild (SetComplexAsSimpleCollisionEnabled(true,true) calls UpdateCollision internally).
    Comp->SetComplexAsSimpleCollisionEnabled(true, /*bImmediateUpdate*/ false);
    Comp->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
    Comp->UpdateCollision(/*bOnlyIfPending*/ false);
}

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
            Mesh.AppendTriangle(A, B, C);
            Mesh.AppendTriangle(A, C, D);
        }
    }

    // Side wall: bowl outer rim (Ring=NumRings, z=-0..) up to top rim (z=TopZ).
    for (int32 Seg = 0; Seg < NumSeg; ++Seg)
    {
        const int32 BL = BowlIdx(NumRings, Seg);
        const int32 BR = BowlIdx(NumRings, Seg + 1);
        const int32 TL = TopIdx(Seg);
        const int32 TR = TopIdx(Seg + 1);
        Mesh.AppendTriangle(BL, BR, TR);
        Mesh.AppendTriangle(BL, TR, TL);
    }

    // Top cap fan (normals up).
    for (int32 Seg = 0; Seg < NumSeg; ++Seg)
    {
        Mesh.AppendTriangle(TopCenter, TopIdx(Seg), TopIdx(Seg + 1));
    }

    ToolMesh->SetMesh(MoveTemp(Mesh));
}

void ACraterTerrainActor::CarveCrater(FVector WorldCenter, float Radius)
{
    UDynamicMesh* Ground = GetDynamicMeshComponent()->GetDynamicMesh();
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
    GetDynamicMeshComponent()->UpdateCollision(/*bOnlyIfPending*/ false);
}

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
        FTransform(WorldPoint + FVector(0, 0, 600.0f)), Params);
    if (!Probe) return;

    Probe->SetMobility(EComponentMobility::Movable);
    UStaticMeshComponent* SM = Probe->GetStaticMeshComponent();
    SM->SetStaticMesh(Cube);
    SM->SetWorldScale3D(FVector(1.5f));
    SM->SetSimulatePhysics(true);
    SM->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
}
