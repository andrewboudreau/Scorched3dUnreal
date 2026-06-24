using UnrealBuildTool;
using System.Collections.Generic;

public class Scorched3dUnrealTarget : TargetRules
{
    public Scorched3dUnrealTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Game;
        DefaultBuildSettings = BuildSettingsVersion.V5;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        ExtraModuleNames.Add("Scorched3dUnreal");
    }
}
