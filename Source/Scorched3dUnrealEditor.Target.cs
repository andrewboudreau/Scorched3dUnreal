using UnrealBuildTool;
using System.Collections.Generic;

public class Scorched3dUnrealEditorTarget : TargetRules
{
    public Scorched3dUnrealEditorTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Editor;
        DefaultBuildSettings = BuildSettingsVersion.V5;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        bOverrideBuildEnvironment = true;
        ExtraModuleNames.Add("Scorched3dUnreal");
    }
}
