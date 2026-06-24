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
