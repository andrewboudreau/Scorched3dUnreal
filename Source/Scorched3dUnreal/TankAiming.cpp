#include "TankAiming.h"

FVector TankAiming::MuzzleDirection(double YawDeg, double ElevationDeg)
{
    const double Yaw  = FMath::DegreesToRadians(YawDeg);
    const double Elev = FMath::DegreesToRadians(ElevationDeg);
    const double CosE = FMath::Cos(Elev);

    // Horizontal component rotated by yaw, vertical component from elevation.
    return FVector(
        CosE * FMath::Cos(Yaw),
        CosE * FMath::Sin(Yaw),
        FMath::Sin(Elev)).GetSafeNormal();
}
