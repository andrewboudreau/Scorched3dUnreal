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
    UDynamicMeshComponent* Comp = GetDynamicMeshComponent();
    if (!Comp) return;

    UDynamicMesh* Mesh = Comp->GetDynamicMesh();
    if (!Mesh) return;

    Mesh->Reset();

    FGeometryScriptPrimitiveOptions Options;
    const FTransform Local = FTransform::Identity;

    // Flat rectangle in the XY plane, centered on the actor, subdivided into a grid.
    // NOTE: In UE 5.8 the function is AppendRectangleXY (renamed from AppendRectangle).
    // StepsWidth/StepsHeight are the last two int args before the optional Debug param.
    UGeometryScriptLibrary_MeshPrimitiveFunctions::AppendRectangleXY(
        Mesh, Options, Local,
        GridExtent, GridExtent,
        GridResolution, GridResolution);

    // Complex-as-simple so the carved surface is collidable at runtime.
    // bImmediateUpdate=false defers the rebuild so we do a single explicit UpdateCollision below,
    // avoiding a double full rebuild (SetComplexAsSimpleCollisionEnabled(true,true) calls UpdateCollision internally).
    Comp->SetComplexAsSimpleCollisionEnabled(true, /*bImmediateUpdate*/ false);
    Comp->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
    Comp->UpdateCollision(/*bOnlyIfPending*/ false);
}
