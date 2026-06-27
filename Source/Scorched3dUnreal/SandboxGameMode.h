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
