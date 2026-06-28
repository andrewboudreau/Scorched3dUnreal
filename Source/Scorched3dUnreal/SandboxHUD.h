#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "SandboxHUD.generated.h"

UCLASS()
class SCORCHED3DUNREAL_API ASandboxHUD : public AHUD
{
    GENERATED_BODY()

public:
    virtual void DrawHUD() override;
};
