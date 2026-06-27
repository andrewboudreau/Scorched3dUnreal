#include "SandboxGameMode.h"
#include "FlyCameraPawn.h"
#include "CraterTerrainActor.h"
#include "Kismet/GameplayStatics.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/Pawn.h"
#include "Engine/DirectionalLight.h"
#include "Components/DirectionalLightComponent.h"
#include "Engine/SkyLight.h"
#include "Components/SkyLightComponent.h"
#include "Engine/ExponentialHeightFog.h"
#include "Components/SkyAtmosphereComponent.h" // declares ASkyAtmosphere

ASandboxGameMode::ASandboxGameMode()
{
    DefaultPawnClass = AFlyCameraPawn::StaticClass();
}

void ASandboxGameMode::BeginPlay()
{
    Super::BeginPlay();
    EnsureLighting();
    EnsureTerrain();
    PlacePlayerAboveTerrain();
}

void ASandboxGameMode::EnsureTerrain()
{
    UWorld* World = GetWorld();
    if (!World) return;

    TArray<AActor*> Existing;
    UGameplayStatics::GetAllActorsOfClass(World, ACraterTerrainActor::StaticClass(), Existing);
    if (Existing.Num() > 0) return;

    // Deferred spawn so hill settings are applied BEFORE the actor's BeginPlay/RegenerateGround.
    const FTransform Xf = FTransform::Identity;
    ACraterTerrainActor* Terrain = World->SpawnActorDeferred<ACraterTerrainActor>(
        ACraterTerrainActor::StaticClass(), Xf);
    if (!Terrain) return;

    Terrain->GridExtent = TerrainExtent;
    Terrain->GridResolution = TerrainResolution;
    Terrain->HillAmplitude = HillAmplitude;
    Terrain->HillFrequency = HillFrequency;
    Terrain->HillSeed = HillSeed;

    UGameplayStatics::FinishSpawningActor(Terrain, Xf); // BeginPlay -> RegenerateGround with hills
}

void ASandboxGameMode::EnsureLighting()
{
    UWorld* World = GetWorld();
    if (!World) return;

    auto NoneOf = [World](UClass* Cls)
    {
        TArray<AActor*> Found;
        UGameplayStatics::GetAllActorsOfClass(World, Cls, Found);
        return Found.Num() == 0;
    };

    if (NoneOf(ADirectionalLight::StaticClass()))
    {
        const FRotator SunRot(-45.0f, -45.0f, 0.0f); // pitch down 45, yaw 45
        ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(
            ADirectionalLight::StaticClass(), FVector::ZeroVector, SunRot);
        if (Sun)
        {
            Sun->SetMobility(EComponentMobility::Movable);
            if (UDirectionalLightComponent* C = Cast<UDirectionalLightComponent>(Sun->GetLightComponent()))
            {
                C->SetIntensity(8.0f);
                C->SetAtmosphereSunLight(true); // drive the sky atmosphere
            }
        }
    }

    if (NoneOf(ASkyAtmosphere::StaticClass()))
    {
        World->SpawnActor<ASkyAtmosphere>(ASkyAtmosphere::StaticClass());
    }

    if (NoneOf(ASkyLight::StaticClass()))
    {
        ASkyLight* Sky = World->SpawnActor<ASkyLight>(ASkyLight::StaticClass());
        if (Sky)
        {
            // ASkyLight derives from AInfo, not ALight — SetMobility lives on the component.
            if (USkyLightComponent* C = Sky->GetLightComponent())
            {
                C->SetMobility(EComponentMobility::Movable);
                C->SetRealTimeCaptureEnabled(true); // capture the atmosphere for ambient light
                C->RecaptureSky();
            }
        }
    }

    if (NoneOf(AExponentialHeightFog::StaticClass()))
    {
        World->SpawnActor<AExponentialHeightFog>(AExponentialHeightFog::StaticClass());
    }
}

void ASandboxGameMode::PlacePlayerAboveTerrain()
{
    UWorld* World = GetWorld();
    if (!World) return;

    APlayerController* PC = UGameplayStatics::GetPlayerController(World, 0);
    if (!PC) return;
    APawn* P = PC->GetPawn();
    if (!P) return;

    // Lift above the hills and look toward the center.
    const FVector Loc(-0.5f * TerrainExtent, 0.0f, HillAmplitude + 6000.0f);
    P->SetActorLocation(Loc);
    const FRotator LookAtCenter = (FVector::ZeroVector - Loc).Rotation();
    PC->SetControlRotation(LookAtCenter);
}
