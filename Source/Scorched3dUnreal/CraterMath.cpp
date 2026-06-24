#include "CraterMath.h"

double CraterMath::DepthAt(double Dist, double Radius, double DepthScale)
{
    if (Radius <= 0.0) return 0.0;
    if (Dist < 0.0) Dist = 0.0;
    if (Dist >= Radius) return 0.0;

    // Legacy: explosionDepth = sin((radius - dist)/radius * PI/2) * radius; then * depthScale.
    const double DistToRadius = Radius - Dist;
    return FMath::Sin((DistToRadius / Radius) * (UE_DOUBLE_PI / 2.0)) * Radius * DepthScale;
}
