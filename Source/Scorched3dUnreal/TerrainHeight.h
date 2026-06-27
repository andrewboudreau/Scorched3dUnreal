#pragma once

#include "CoreMinimal.h"

namespace TerrainHeight
{
    // Procedural terrain parameters. Amplitude<=0 yields a flat field.
    struct FParams
    {
        double Amplitude = 0.0;     // peak hill height (cm); 0 => flat
        double Frequency = 0.0005;  // base spatial frequency (1/cm); smaller = broader hills
        int32  Octaves   = 4;       // number of noise layers
        int32  Seed      = 0;       // offsets the noise field
    };

    // Layered Perlin-noise height (cm) at local plane coords (X,Y).
    // Deterministic; result is in [-Amplitude, +Amplitude].
    double HeightAt(double X, double Y, const FParams& Params);
}
