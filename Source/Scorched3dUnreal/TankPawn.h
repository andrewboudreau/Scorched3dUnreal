#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "Templates/SubclassOf.h"
#include "TankPawn.generated.h"

class UStaticMeshComponent;
class USpringArmComponent;
class UCameraComponent;
class USceneComponent;
class UInputMappingContext;
class UInputAction;
class ARocketProjectile;
struct FInputActionValue;

UCLASS()
class SCORCHED3DUNREAL_API ATankPawn : public APawn
{
    GENERATED_BODY()

public:
    ATankPawn();

    // --- Tunables ---
    UPROPERTY(EditAnywhere, Category = "Tank|Aim") float TurretSpeed = 60.0f;     // deg/s
    UPROPERTY(EditAnywhere, Category = "Tank|Aim") float ElevationSpeed = 40.0f;  // deg/s
    UPROPERTY(EditAnywhere, Category = "Tank|Aim") float MinElevation = 0.0f;     // deg
    UPROPERTY(EditAnywhere, Category = "Tank|Aim") float MaxElevation = 85.0f;    // deg
    UPROPERTY(EditAnywhere, Category = "Tank|Power") float PowerSpeed = 4000.0f;  // cm/s per s
    UPROPERTY(EditAnywhere, Category = "Tank|Power") float MinPower = 3000.0f;    // cm/s
    UPROPERTY(EditAnywhere, Category = "Tank|Power") float MaxPower = 15000.0f;   // cm/s
    UPROPERTY(EditAnywhere, Category = "Tank|Look") float LookSensitivity = 1.0f;
    UPROPERTY(EditAnywhere, Category = "Tank|Fire") TSubclassOf<ARocketProjectile> ShellClass;

    // --- HUD getters ---
    float GetTurretYaw() const { return TurretYaw; }
    float GetBarrelElevation() const { return BarrelElevation; }
    float GetPower() const { return Power; }
    float GetPowerFraction() const
    {
        return (MaxPower > MinPower) ? (Power - MinPower) / (MaxPower - MinPower) : 0.0f;
    }

protected:
    virtual void BeginPlay() override;
    virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;

    // --- Visual rig (engine primitives; swap for a Fab mesh later) ---
    UPROPERTY(VisibleAnywhere, Category = "Tank") UStaticMeshComponent* Hull;
    UPROPERTY(VisibleAnywhere, Category = "Tank") UStaticMeshComponent* Turret;
    UPROPERTY(VisibleAnywhere, Category = "Tank") UStaticMeshComponent* Barrel;
    UPROPERTY(VisibleAnywhere, Category = "Tank") USceneComponent* Muzzle;
    UPROPERTY(VisibleAnywhere, Category = "Tank") USpringArmComponent* SpringArm;
    UPROPERTY(VisibleAnywhere, Category = "Tank") UCameraComponent* Camera;

    // --- Input ---
    UPROPERTY(Transient) UInputMappingContext* MappingContext;
    UPROPERTY(Transient) UInputAction* TurretAction;
    UPROPERTY(Transient) UInputAction* ElevationAction;
    UPROPERTY(Transient) UInputAction* PowerAction;
    UPROPERTY(Transient) UInputAction* FireAction;
    UPROPERTY(Transient) UInputAction* LookAction;
    UPROPERTY(Transient) UInputAction* ZoomAction;

    // --- Aim state ---
    float TurretYaw = 0.0f;        // deg
    float BarrelElevation = 30.0f; // deg
    float Power = 8000.0f;         // cm/s

    void BuildInput(); // create actions + mapping context (idempotent)
    void OnTurret(const FInputActionValue& Value);
    void OnElevation(const FInputActionValue& Value);
    void OnPower(const FInputActionValue& Value);
    void OnLook(const FInputActionValue& Value);
    void OnZoom(const FInputActionValue& Value);
    void OnFire(const FInputActionValue& Value);

    void ApplyAimToMesh(); // push TurretYaw/BarrelElevation onto the cosmetic components
};
