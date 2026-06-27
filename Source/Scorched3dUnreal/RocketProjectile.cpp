#include "RocketProjectile.h"
#include "Components/SphereComponent.h"
#include "Components/StaticMeshComponent.h"
#include "GameFramework/ProjectileMovementComponent.h"
#include "UObject/ConstructorHelpers.h"
#include "Kismet/GameplayStatics.h"
#include "Engine/World.h"
#include "Engine/OverlapResult.h"
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
    const FVector Point = Hit.bBlockingHit ? FVector(Hit.ImpactPoint) : GetActorLocation();
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
