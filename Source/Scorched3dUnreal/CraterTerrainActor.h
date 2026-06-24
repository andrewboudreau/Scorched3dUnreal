#pragma once

#include "CoreMinimal.h"
#include "DynamicMeshActor.h"
#include "CraterTerrainActor.generated.h"

/**
 * Runtime-destructible ground spike. Generates a flat DynamicMesh grid and
 * boolean-subtracts sine-profile crater bowls into it at runtime.
 */
UCLASS()
class SCORCHED3DUNREAL_API ACraterTerrainActor : public ADynamicMeshActor
{
    GENERATED_BODY()

public:
    ACraterTerrainActor();
};
