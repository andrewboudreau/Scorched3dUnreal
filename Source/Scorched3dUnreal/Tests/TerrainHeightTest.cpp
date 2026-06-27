#include "Misc/AutomationTest.h"
#include "../TerrainHeight.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTerrainHeightTest, "Scorched.TerrainHeight.Profile",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTerrainHeightTest::RunTest(const FString& Parameters)
{
    // Amplitude 0 => perfectly flat everywhere (preserves M0 flat-terrain tests).
    {
        TerrainHeight::FParams Flat; // Amplitude defaults to 0
        TestEqual(TEXT("flat at origin"), TerrainHeight::HeightAt(0.0, 0.0, Flat), 0.0, 1e-9);
        TestEqual(TEXT("flat off origin"), TerrainHeight::HeightAt(1234.0, -987.0, Flat), 0.0, 1e-9);
    }

    TerrainHeight::FParams P;
    P.Amplitude = 1000.0;
    P.Frequency = 0.0008;
    P.Octaves   = 4;
    P.Seed      = 3;

    // Deterministic: same input -> same output.
    TestEqual(TEXT("deterministic"),
        TerrainHeight::HeightAt(2500.0, -1500.0, P),
        TerrainHeight::HeightAt(2500.0, -1500.0, P), 1e-9);

    // Bounded by amplitude.
    double MinH =  1.0e18, MaxH = -1.0e18;
    for (int32 ix = -20; ix <= 20; ++ix)
    {
        for (int32 iy = -20; iy <= 20; ++iy)
        {
            const double H = TerrainHeight::HeightAt(ix * 500.0, iy * 500.0, P);
            TestTrue(TEXT("within +/- amplitude"), H >= -P.Amplitude - 1e-6 && H <= P.Amplitude + 1e-6);
            MinH = FMath::Min(MinH, H);
            MaxH = FMath::Max(MaxH, H);
        }
    }

    // Varied: the field is not constant (real hills).
    TestTrue(FString::Printf(TEXT("terrain varies (range=%.1f)"), MaxH - MinH), (MaxH - MinH) > 100.0);

    // Different seed -> different field at a sample point.
    TerrainHeight::FParams P2 = P; P2.Seed = 99;
    TestTrue(TEXT("seed changes field"),
        !FMath::IsNearlyEqual(TerrainHeight::HeightAt(2500.0, -1500.0, P),
                              TerrainHeight::HeightAt(2500.0, -1500.0, P2), 1e-3));

    AddInfo(FString::Printf(TEXT("range over 41x41 grid: min=%.1f max=%.1f"), MinH, MaxH));
    return true;
}
