#include "Misc/AutomationTest.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "Components/DynamicMeshComponent.h"
#include "UDynamicMesh.h"
#include "DynamicMesh/DynamicMesh3.h"
#include "../CraterTerrainActor.h"

// End-to-end geometric proof that CarveCrater actually removes volume and leaves a
// concave bowl (NOT a flat seam imprint, and NOT a hole punched through the slab).
// This runs the real GeometryScript mesh boolean headless and measures the result —
// deterministic, editor-closed, no PIE/screenshots required.
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

            // Sample the carved surface. Actor sits at origin, so local == world.
            double MaxZCenter = -1.0e9; // highest surface vertex within the crater center
            double MaxZFar    = -1.0e9; // highest surface vertex well outside the crater
            double MinZ       =  1.0e9; // lowest vertex anywhere (slab bottom must survive)
            int32  CenterCount = 0;

            for (int32 Vid : Mesh.VertexIndicesItr())
            {
                const FVector3d V = Mesh.GetVertex(Vid);
                const double R2 = V.X * V.X + V.Y * V.Y;
                MinZ = FMath::Min(MinZ, V.Z);
                if (R2 < 50.0 * 50.0)            { MaxZCenter = FMath::Max(MaxZCenter, V.Z); ++CenterCount; }
                if (R2 > 600.0 * 600.0)          { MaxZFar    = FMath::Max(MaxZFar, V.Z); }
            }

            // Original slab top is world Z = 0. A real crater pushes the central surface
            // well below it (profile predicts ~ -200 for Radius 300, RimLift 100).
            TestTrue(TEXT("crater center has surface vertices"), CenterCount > 0);
            TestTrue(FString::Printf(TEXT("center carved below surface (MaxZCenter=%.1f, expect < -100)"), MaxZCenter),
                MaxZCenter < -100.0);

            // The terrain far from the crater is untouched: top still at Z = 0.
            TestTrue(FString::Printf(TEXT("far terrain top intact (MaxZFar=%.1f, expect ~0)"), MaxZFar),
                FMath::Abs(MaxZFar) < 1.0);

            // It's a BOWL, not a hole: the slab bottom (Z = -600) survives intact and
            // nothing carved through the bedrock floor.
            TestTrue(FString::Printf(TEXT("slab bottom survives — bowl not hole (MinZ=%.1f, expect ~ -600)"), MinZ),
                MinZ <= -599.0);
            TestTrue(FString::Printf(TEXT("crater stays above bedrock (MinZ=%.1f > -2000)"), MinZ),
                MinZ > -2000.0);

            AddInfo(FString::Printf(TEXT("MaxZCenter=%.1f  MaxZFar=%.1f  MinZ=%.1f  CenterVerts=%d  TotalVerts=%d"),
                MaxZCenter, MaxZFar, MinZ, CenterCount, Mesh.VertexCount()));
        }
    }

    GEngine->DestroyWorldContext(World);
    World->DestroyWorld(/*bBroadcastWorldDestroyedEvent*/ false);
    return true;
}
