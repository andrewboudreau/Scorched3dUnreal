#pragma once

#include "CoreMinimal.h"

namespace CraterMath
{
    // Legacy DeformLandscape.cpp:67-68 sine-smoothed radial falloff.
    // Returns downward crater depth (>= 0) at radial distance Dist for a crater
    // of the given Radius. depth(0) = Radius*DepthScale; depth(>=Radius) = 0.
    double DepthAt(double Dist, double Radius, double DepthScale);
}
