#include "CraterTerrainActor.h"
#include "Components/DynamicMeshComponent.h"
#include "UDynamicMesh.h"
#include "GeometryScript/MeshPrimitiveFunctions.h"
#include "GeometryScript/MeshNormalsFunctions.h"
#include "CraterMath.h"
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

    // A flat heightfield grid at local Z=0, centered on the actor. Craters are carved
    // by displacing this surface's vertices downward (the legacy DeformLandscape model),
    // not by boolean-subtracting a solid — so a single-sided surface is all we need, and
    // the surface is single-valued (one height per cell), which makes a "lid" impossible.
    UGeometryScriptLibrary_MeshPrimitiveFunctions::AppendRectangleXY(
        Mesh, Options, FTransform::Identity,
        GridExtent, GridExtent,
        GridResolution, GridResolution);

    FGeometryScriptCalculateNormalsOptions NormalOptions;
    UGeometryScriptLibrary_MeshNormalsFunctions::RecomputeNormals(Mesh, NormalOptions);

    // Complex-as-simple so the deformed surface is collidable at runtime.
    // bImmediateUpdate=false defers the rebuild so we do a single explicit UpdateCollision below,
    // avoiding a double full rebuild (SetComplexAsSimpleCollisionEnabled(true,true) calls UpdateCollision internally).
    Comp->SetComplexAsSimpleCollisionEnabled(true, /*bImmediateUpdate*/ false);
    Comp->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
    Comp->UpdateCollision(/*bOnlyIfPending*/ false);
}

void ACraterTerrainActor::CarveCrater(FVector WorldCenter, float Radius)
{
    UDynamicMesh* Ground = GetDynamicMeshComponent()->GetDynamicMesh();
    if (!Ground || Radius <= 0.0f) return;

    // Heightfield deformation — a direct port of the legacy DeformLandscape model
    // (DeformLandscape.cpp:186-233): lower each surface vertex within Radius by the
    // sine falloff (CraterMath::DepthAt), clamped to the bedrock floor. The surface
    // stays single-valued, so there is no lid and no coplanar-boolean degeneracy.
    const FTransform Xf = GetActorTransform();
    const FVector LocalCenter = Xf.InverseTransformPosition(WorldCenter);
    const double LocalBedrockZ =
        Xf.InverseTransformPosition(FVector(WorldCenter.X, WorldCenter.Y, BedrockZ)).Z;
    const double R = Radius;
    const double Scale = DepthScale;

    Ground->EditMesh([&](UE::Geometry::FDynamicMesh3& EditMesh)
    {
        for (const int32 Vid : EditMesh.VertexIndicesItr())
        {
            FVector3d V = EditMesh.GetVertex(Vid);
            const double Dist = FMath::Sqrt(
                FMath::Square(V.X - LocalCenter.X) + FMath::Square(V.Y - LocalCenter.Y));
            const double Drop = CraterMath::DepthAt(Dist, R, Scale); // 0 outside Radius
            if (Drop <= 0.0) continue;
            V.Z = FMath::Max(V.Z - Drop, LocalBedrockZ);
            EditMesh.SetVertex(Vid, V);
        }
    });

    // Recompute normals so shading follows the new surface, then rebuild collision.
    FGeometryScriptCalculateNormalsOptions NormalOptions;
    UGeometryScriptLibrary_MeshNormalsFunctions::RecomputeNormals(Ground, NormalOptions);
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
