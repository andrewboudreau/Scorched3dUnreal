#include "Misc/AutomationTest.h"
#include "../CraterMath.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FCraterMathTest, "Scorched.CraterMath.DepthProfile",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FCraterMathTest::RunTest(const FString& Parameters)
{
    const double R = 100.0;

    // Center is deepest: depth == radius * depthScale.
    TestEqual(TEXT("center depth"), CraterMath::DepthAt(0.0, R, 1.0), 100.0, 1e-3);

    // Rim and beyond are flat (zero depth).
    TestEqual(TEXT("rim depth"), CraterMath::DepthAt(100.0, R, 1.0), 0.0, 1e-6);
    TestEqual(TEXT("outside depth"), CraterMath::DepthAt(150.0, R, 1.0), 0.0, 1e-6);

    // Legacy profile at half radius: sin(0.5 * PI/2) * R == sin(PI/4) * 100.
    TestEqual(TEXT("half-radius depth"), CraterMath::DepthAt(50.0, R, 1.0),
        FMath::Sin(UE_DOUBLE_PI / 4.0) * 100.0, 1e-3);

    // DepthScale scales linearly.
    TestEqual(TEXT("scaled center depth"), CraterMath::DepthAt(0.0, R, 0.5), 50.0, 1e-3);

    // Monotonic decreasing from center to rim.
    double Prev = CraterMath::DepthAt(0.0, R, 1.0);
    for (double d = 10.0; d <= 100.0; d += 10.0)
    {
        const double Cur = CraterMath::DepthAt(d, R, 1.0);
        TestTrue(FString::Printf(TEXT("monotonic at %.0f"), d), Cur <= Prev);
        Prev = Cur;
    }

    // Degenerate radius never crashes / returns zero.
    TestEqual(TEXT("zero radius"), CraterMath::DepthAt(0.0, 0.0, 1.0), 0.0, 1e-6);

    return true;
}
