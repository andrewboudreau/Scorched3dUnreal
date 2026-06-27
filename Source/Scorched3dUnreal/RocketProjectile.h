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
