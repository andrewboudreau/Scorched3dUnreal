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
