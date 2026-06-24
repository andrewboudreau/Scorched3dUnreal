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

    /** Carve a sine-profile crater of the given Radius (cm) centered at WorldCenter. */
    UFUNCTION(BlueprintCallable, Category = "Crater")
    void CarveCrater(FVector WorldCenter, float Radius);

protected:
    virtual void BeginPlay() override;

    virtual void NotifyActorOnClicked(FKey ButtonPressed = EKeys::LeftMouseButton) override;

    UPROPERTY(EditAnywhere, Category = "Crater") float CarveRadius = 300.0f;

    /** Trace from the camera through the cursor and carve where it hits this ground. */
    void CarveAtCursor();

    /** Drop a physics cube above WorldPoint to visually confirm collision. */
    void SpawnProbeCube(FVector WorldPoint);

    /** (Re)builds the flat ground mesh and refreshes collision. */
    void RegenerateGround();

    /**
     * Builds a watertight "bowl plug" solid around the local origin: a flat top
     * cap at +Radius, a vertical side wall, and a bowl underside following the
     * legacy sine profile down to -MaxDepth at center. Subtracting it from the
     * ground yields the crater. Caller owns nothing — fills the passed UDynamicMesh.
     */
    void BuildCraterToolMesh(UDynamicMesh* ToolMesh, float Radius, float MaxDepth);
};
