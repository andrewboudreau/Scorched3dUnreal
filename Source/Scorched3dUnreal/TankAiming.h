#pragma once

#include "CoreMinimal.h"

namespace TankAiming
{
    // Unit aim direction in the tank's LOCAL frame for a turret yaw and barrel elevation
    // (both in degrees). Yaw rotates around +Z (0 => +X forward, +90 => +Y).
    // Elevation tilts up from horizontal (0 => horizontal, 90 => straight up +Z).
    FVector MuzzleDirection(double YawDeg, double ElevationDeg);
}
