using UnrealBuildTool;

public class Scorched3dUnreal : ModuleRules
{
    public Scorched3dUnreal(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core", "CoreUObject", "Engine", "InputCore",
            "GeometryCore", "DynamicMesh", "GeometryFramework", "GeometryScriptingCore"
        });
    }
}
