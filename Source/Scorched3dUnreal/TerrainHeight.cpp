#include "TerrainHeight.h"

double TerrainHeight::HeightAt(double X, double Y, const FParams& Params)
{
    if (Params.Amplitude <= 0.0 || Params.Octaves <= 0)
    {
        return 0.0;
    }

    // Seed shifts the sample position so different seeds give different fields.
    const double SeedOffset = static_cast<double>(Params.Seed) * 1013.0;

    double Sum     = 0.0; // accumulated noise
    double AmpSum  = 0.0; // sum of per-octave weights, for normalization
    double Freq    = Params.Frequency;
    double Weight  = 1.0;

    for (int32 i = 0; i < Params.Octaves; ++i)
    {
        const FVector2D SamplePoint(
            (X + SeedOffset) * Freq,
            (Y + SeedOffset) * Freq);
        // FMath::PerlinNoise2D returns roughly [-1, 1].
        Sum    += Weight * static_cast<double>(FMath::PerlinNoise2D(SamplePoint));
        AmpSum += Weight;
        Freq   *= 2.0;   // each octave doubles frequency (finer detail)
        Weight *= 0.5;   // and halves contribution
    }

    const double Normalized = (AmpSum > 0.0) ? (Sum / AmpSum) : 0.0; // in [-1, 1]
    return Normalized * Params.Amplitude;
}
