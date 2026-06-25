#include "Misc/AutomationTest.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "Components/DynamicMeshComponent.h"
#include "UDynamicMesh.h"
#include "DynamicMesh/DynamicMesh3.h"
#include "../CraterTerrainActor.h"

// End-to-end geometric proof that CarveCrater deforms the heightfield into a real
// concave bowl: the center surface drops by the full sine depth, the terrain outside
// the radius is untouched, and nothing is ever raised above the original surface (a
// single-valued heightfield cannot produce a "lid"). Runs the real deformation
// headless — deterministic, editor-closed, no PIE/screenshots required.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FCraterCarveTest, "Scorched.CraterCarve.RealDepression",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FCraterCarveTest::RunTest(const FString& Parameters)
{
    using namespace UE::Geometry;

    // Spin up a throwaway editor world to host the actor.
    UWorld* World = UWorld::CreateWorld(EWorldType::Editor, /*bInformEngineOfWorld*/ false);
    if (!TestNotNull(TEXT("created world"), World)) return false;
    FWorldContext& WorldContext = GEngine->CreateNewWorldContext(EWorldType::Editor);
    WorldContext.SetCurrentWorld(World);

    ACraterTerrainActor* Actor = World->SpawnActor<ACraterTerrainActor>();
    TestNotNull(TEXT("spawned ACraterTerrainActor"), Actor);

    if (Actor)
    {
        const float Radius = 300.0f;

        Actor->RegenerateGround();
        Actor->CarveCrater(Actor->GetActorLocation(), Radius);

        UDynamicMesh* DM = Actor->GetDynamicMeshComponent()->GetDynamicMesh();
        TestNotNull(TEXT("ground dynamic mesh"), DM);

        if (DM)
        {
            const FDynamicMesh3& Mesh = DM->GetMeshRef();

            // Sample the deformed heightfield. Actor sits at origin, so local == world.
            // The grid (AppendRectangleXY, GridResolution=64) has an even vertex count
            // per side, so there is NO vertex exactly at (0,0): the innermost ring sits
            // at ~56 cm from center, where DepthAt(56,300,1) ~= 287. So the central
            // window must be wider than one cell, and the deepest point is ~ -287, not -300.
            double MaxZCenter = -1.0e9; // highest vertex near the crater center
            double MaxZFar    = -1.0e9; // highest vertex well outside the crater
            double MaxZAll    = -1.0e9; // highest vertex anywhere (must not exceed 0 -> no lid)
            double MinZ       =  1.0e9; // lowest vertex (the crater bottom)
            int32  CenterCount = 0;

            for (int32 Vid : Mesh.VertexIndicesItr())
            {
                const FVector3d V = Mesh.GetVertex(Vid);
                const double R2 = V.X * V.X + V.Y * V.Y;
                MinZ    = FMath::Min(MinZ, V.Z);
                MaxZAll = FMath::Max(MaxZAll, V.Z);
                if (R2 < 80.0 * 80.0)   { MaxZCenter = FMath::Max(MaxZCenter, V.Z); ++CenterCount; }
                if (R2 > 600.0 * 600.0) { MaxZFar    = FMath::Max(MaxZFar, V.Z); }
            }

            // The center region drops by nearly the full sine depth (~ -287 at the
            // innermost ring for Radius 300).
            TestTrue(TEXT("crater center has surface vertices"), CenterCount > 0);
            TestTrue(FString::Printf(TEXT("center carved deep (MaxZCenter=%.1f, expect < -250)"), MaxZCenter),
                MaxZCenter < -250.0);

            // The terrain far from the crater is untouched: still at Z = 0.
            TestTrue(FString::Printf(TEXT("far terrain intact (MaxZFar=%.1f, expect ~0)"), MaxZFar),
                FMath::Abs(MaxZFar) < 1.0);

            // No "lid": carving only LOWERS a single-valued surface, so nothing is ever
            // raised above the original Z = 0. This is the property the boolean lacked.
            TestTrue(FString::Printf(TEXT("nothing raised above surface — no lid (MaxZAll=%.1f, expect <= 0)"), MaxZAll),
                MaxZAll <= 1.0);

            // The deepest point approaches the full sine depth (-300) and stays above bedrock.
            TestTrue(FString::Printf(TEXT("crater bottom near full sine depth (MinZ=%.1f, expect -270..-301)"), MinZ),
                MinZ < -270.0 && MinZ > -301.0);
            TestTrue(FString::Printf(TEXT("crater stays above bedrock (MinZ=%.1f > -2000)"), MinZ),
                MinZ > -2000.0);

            AddInfo(FString::Printf(TEXT("MaxZCenter=%.1f  MaxZFar=%.1f  MaxZAll=%.1f  MinZ=%.1f  CenterVerts=%d  TotalVerts=%d"),
                MaxZCenter, MaxZFar, MaxZAll, MinZ, CenterCount, Mesh.VertexCount()));
        }
    }

    GEngine->DestroyWorldContext(World);
    World->DestroyWorld(/*bBroadcastWorldDestroyedEvent*/ false);
    return true;
}
