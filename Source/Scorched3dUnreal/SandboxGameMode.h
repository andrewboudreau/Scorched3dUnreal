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

    UPROPERTY(EditAnywhere, Category = "Sandbox") float TerrainExtent = 100000.0f;    // cm (1 km)
    UPROPERTY(EditAnywhere, Category = "Sandbox") int32 TerrainResolution = 334;       // ~3 m cells
    UPROPERTY(EditAnywhere, Category = "Sandbox") float HillAmplitude = 5000.0f;       // cm (50 m)
    UPROPERTY(EditAnywhere, Category = "Sandbox") float HillFrequency = 0.00006f;
    UPROPERTY(EditAnywhere, Category = "Sandbox") int32 HillSeed = 7;

protected:
    virtual void BeginPlay() override;

    void EnsureTerrain();
    void EnsureLighting();
    void PlaceTankOnTerrain();
};
