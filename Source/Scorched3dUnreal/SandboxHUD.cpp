#include "SandboxHUD.h"
#include "TankPawn.h"
#include "GameFramework/PlayerController.h"
#include "Engine/Canvas.h"

void ASandboxHUD::DrawHUD()
{
    Super::DrawHUD();
    if (!Canvas) return;

    APlayerController* PC = GetOwningPlayerController();
    ATankPawn* Tank = PC ? Cast<ATankPawn>(PC->GetPawn()) : nullptr;
    if (!Tank) return;

    const float X = 40.0f;
    float Y = Canvas->SizeY - 140.0f;

    const FString AngleStr = FString::Printf(TEXT("Elevation: %.0f deg"), Tank->GetBarrelElevation());
    const FString YawStr   = FString::Printf(TEXT("Turret:    %.0f deg"), Tank->GetTurretYaw());
    const FString PowerStr = FString::Printf(TEXT("Power:     %.0f"),     Tank->GetPower());

    DrawText(AngleStr, FLinearColor::White, X, Y);            Y += 22.0f;
    DrawText(YawStr,   FLinearColor::White, X, Y);            Y += 22.0f;
    DrawText(PowerStr, FLinearColor::White, X, Y);            Y += 26.0f;

    // Power bar.
    const float BarW = 240.0f, BarH = 16.0f;
    DrawRect(FLinearColor(0.1f, 0.1f, 0.1f, 0.6f), X, Y, BarW, BarH);
    DrawRect(FLinearColor(1.0f, 0.55f, 0.0f, 0.9f), X, Y, BarW * Tank->GetPowerFraction(), BarH);
}
