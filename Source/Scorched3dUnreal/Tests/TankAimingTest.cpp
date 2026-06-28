#include "Misc/AutomationTest.h"
#include "../TankAiming.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTankAimingTest, "Scorched.TankAiming.MuzzleDirection",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTankAimingTest::RunTest(const FString& Parameters)
{
    // Yaw 0, elevation 0 => straight forward (+X).
    {
        const FVector D = TankAiming::MuzzleDirection(0.0, 0.0);
        TestTrue(TEXT("0/0 is +X forward"), D.Equals(FVector(1, 0, 0), 1e-4));
    }
    // Yaw +90, elevation 0 => +Y (turret rotated left/right in plane).
    {
        const FVector D = TankAiming::MuzzleDirection(90.0, 0.0);
        TestTrue(TEXT("90/0 is +Y"), D.Equals(FVector(0, 1, 0), 1e-4));
    }
    // Yaw 0, elevation 90 => straight up (+Z).
    {
        const FVector D = TankAiming::MuzzleDirection(0.0, 90.0);
        TestTrue(TEXT("0/90 is +Z"), D.Equals(FVector(0, 0, 1), 1e-4));
    }
    // Yaw 0, elevation 45 => 45 degrees up in the XZ plane.
    {
        const FVector D = TankAiming::MuzzleDirection(0.0, 45.0);
        const double H = FMath::Sqrt(0.5);
        TestTrue(TEXT("0/45 is (.707,0,.707)"), D.Equals(FVector(H, 0, H), 1e-4));
    }
    // Always unit length.
    {
        const FVector D = TankAiming::MuzzleDirection(37.0, 23.0);
        TestEqual(TEXT("unit length"), D.Size(), 1.0, 1e-4);
    }
    return true;
}
