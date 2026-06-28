#include "TankPawn.h"
#include "Components/StaticMeshComponent.h"
#include "GameFramework/SpringArmComponent.h"
#include "Camera/CameraComponent.h"
#include "GameFramework/PlayerController.h"
#include "Engine/LocalPlayer.h"
#include "Engine/World.h"
#include "UObject/ConstructorHelpers.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "InputAction.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "InputActionValue.h"
#include "TankAiming.h"
#include "RocketProjectile.h"

ATankPawn::ATankPawn()
{
    PrimaryActorTick.bCanEverTick = false;
    AutoPossessPlayer = EAutoReceiveInput::Player0;

    // Hull (box) is the root. Engine Cube is a 100cm cube centered at origin.
    Hull = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Hull"));
    RootComponent = Hull;
    Hull->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    Hull->SetRelativeScale3D(FVector(4.0f, 2.5f, 1.0f)); // 400 x 250 x 100 cm
    {
        static ConstructorHelpers::FObjectFinder<UStaticMesh> CubeMesh(TEXT("/Engine/BasicShapes/Cube.Cube"));
        if (CubeMesh.Succeeded()) Hull->SetStaticMesh(CubeMesh.Object);
    }

    // Turret (squat cylinder) sits on top of the hull and yaws.
    Turret = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Turret"));
    Turret->SetupAttachment(Hull);
    Turret->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    // Hull half-height in world cm = 50 (cube) * 1.0 (scale) = 50; relative to hull (which is
    // scaled), use unscaled-local offset of 0.5 so it rests on the hull top.
    Turret->SetRelativeLocation(FVector(0.0f, 0.0f, 0.5f));
    Turret->SetRelativeScale3D(FVector(0.4f, 0.4f, 0.25f)); // de-scales the hull scaling; tweak in-engine
    {
        static ConstructorHelpers::FObjectFinder<UStaticMesh> CylMesh(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
        if (CylMesh.Succeeded()) Turret->SetStaticMesh(CylMesh.Object);
    }

    // Barrel (thin long cylinder) attached to the turret, pointing forward (+X) and pitching up.
    // Engine Cylinder is aligned to Z; rotate -90 about Y so its long axis lies along +X.
    Barrel = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Barrel"));
    Barrel->SetupAttachment(Turret);
    Barrel->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    Barrel->SetRelativeRotation(FRotator(-90.0f, 0.0f, 0.0f)); // long axis -> +X
    Barrel->SetRelativeScale3D(FVector(0.15f, 0.15f, 1.5f));   // thin and long; tweak in-engine
    {
        static ConstructorHelpers::FObjectFinder<UStaticMesh> CylMesh(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
        if (CylMesh.Succeeded()) Barrel->SetStaticMesh(CylMesh.Object);
    }

    // Muzzle marker at the barrel tip — spawn point for shells (cosmetic placement only;
    // the FIRE DIRECTION comes from TankAiming math in the actor frame, not this transform).
    Muzzle = CreateDefaultSubobject<USceneComponent>(TEXT("Muzzle"));
    Muzzle->SetupAttachment(Hull);
    Muzzle->SetRelativeLocation(FVector(300.0f, 0.0f, 80.0f)); // out front, above hull; tweak in-engine

    // Orbit camera.
    SpringArm = CreateDefaultSubobject<USpringArmComponent>(TEXT("SpringArm"));
    SpringArm->SetupAttachment(Hull);
    SpringArm->TargetArmLength = 1200.0f;
    SpringArm->bUsePawnControlRotation = true; // mouse look orbits the arm
    SpringArm->bDoCollisionTest = true;        // don't clip through terrain
    SpringArm->SetRelativeLocation(FVector(0.0f, 0.0f, 150.0f));

    Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
    Camera->SetupAttachment(SpringArm);

    // Hull stays put; only the camera (via control rotation on the spring arm) orbits.
    bUseControllerRotationYaw = false;
    bUseControllerRotationPitch = false;
    bUseControllerRotationRoll = false;

    ShellClass = ARocketProjectile::StaticClass();
}

void ATankPawn::BuildInput()
{
    if (TurretAction) return; // already built

    MappingContext = NewObject<UInputMappingContext>(this);

    auto MakeAxis1D = [this]() -> UInputAction*
    {
        UInputAction* A = NewObject<UInputAction>(this);
        A->ValueType = EInputActionValueType::Axis1D;
        return A;
    };

    TurretAction    = MakeAxis1D();
    ElevationAction = MakeAxis1D();
    PowerAction     = MakeAxis1D();
    ZoomAction      = MakeAxis1D();

    LookAction = NewObject<UInputAction>(this);
    LookAction->ValueType = EInputActionValueType::Axis2D;

    FireAction = NewObject<UInputAction>(this);
    FireAction->ValueType = EInputActionValueType::Boolean;

    // Turret: D = +1 (right), A = -1 (left).
    MappingContext->MapKey(TurretAction, EKeys::D);
    {
        FEnhancedActionKeyMapping& M = MappingContext->MapKey(TurretAction, EKeys::A);
        M.Modifiers.Add(NewObject<UInputModifierNegate>(this));
    }

    // Elevation: W = +1 (raise), S = -1 (lower).
    MappingContext->MapKey(ElevationAction, EKeys::W);
    {
        FEnhancedActionKeyMapping& M = MappingContext->MapKey(ElevationAction, EKeys::S);
        M.Modifiers.Add(NewObject<UInputModifierNegate>(this));
    }

    // Power: E = +1 (more), Q = -1 (less).
    MappingContext->MapKey(PowerAction, EKeys::E);
    {
        FEnhancedActionKeyMapping& M = MappingContext->MapKey(PowerAction, EKeys::Q);
        M.Modifiers.Add(NewObject<UInputModifierNegate>(this));
    }

    // Look: mouse delta orbits the camera.
    MappingContext->MapKey(LookAction, EKeys::Mouse2D);

    // Zoom: mouse wheel.
    MappingContext->MapKey(ZoomAction, EKeys::MouseWheelAxis);

    // Fire: spacebar.
    MappingContext->MapKey(FireAction, EKeys::SpaceBar);
}

void ATankPawn::BeginPlay()
{
    Super::BeginPlay();
    BuildInput();
    ApplyAimToMesh();

    if (APlayerController* PC = Cast<APlayerController>(GetController()))
    {
        if (ULocalPlayer* LP = PC->GetLocalPlayer())
        {
            if (UEnhancedInputLocalPlayerSubsystem* Sub =
                    ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(LP))
            {
                Sub->AddMappingContext(MappingContext, /*Priority*/ 0);
            }
        }
        PC->bShowMouseCursor = false;
    }
}

void ATankPawn::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
    Super::SetupPlayerInputComponent(PlayerInputComponent);
    BuildInput();

    if (UEnhancedInputComponent* EIC = Cast<UEnhancedInputComponent>(PlayerInputComponent))
    {
        EIC->BindAction(TurretAction,    ETriggerEvent::Triggered, this, &ATankPawn::OnTurret);
        EIC->BindAction(ElevationAction, ETriggerEvent::Triggered, this, &ATankPawn::OnElevation);
        EIC->BindAction(PowerAction,     ETriggerEvent::Triggered, this, &ATankPawn::OnPower);
        EIC->BindAction(LookAction,      ETriggerEvent::Triggered, this, &ATankPawn::OnLook);
        EIC->BindAction(ZoomAction,      ETriggerEvent::Triggered, this, &ATankPawn::OnZoom);
        EIC->BindAction(FireAction,      ETriggerEvent::Started,   this, &ATankPawn::OnFire);
    }
}

void ATankPawn::OnTurret(const FInputActionValue& Value)
{
    const float Dt = GetWorld() ? GetWorld()->GetDeltaSeconds() : 0.0f;
    TurretYaw += Value.Get<float>() * TurretSpeed * Dt;
    ApplyAimToMesh();
}

void ATankPawn::OnElevation(const FInputActionValue& Value)
{
    const float Dt = GetWorld() ? GetWorld()->GetDeltaSeconds() : 0.0f;
    BarrelElevation = FMath::Clamp(
        BarrelElevation + Value.Get<float>() * ElevationSpeed * Dt, MinElevation, MaxElevation);
    ApplyAimToMesh();
}

void ATankPawn::OnPower(const FInputActionValue& Value)
{
    const float Dt = GetWorld() ? GetWorld()->GetDeltaSeconds() : 0.0f;
    Power = FMath::Clamp(Power + Value.Get<float>() * PowerSpeed * Dt, MinPower, MaxPower);
}

void ATankPawn::OnLook(const FInputActionValue& Value)
{
    const FVector2D Axis = Value.Get<FVector2D>();
    AddControllerYawInput(Axis.X * LookSensitivity);
    AddControllerPitchInput(-Axis.Y * LookSensitivity);
}

void ATankPawn::OnZoom(const FInputActionValue& Value)
{
    if (SpringArm)
    {
        SpringArm->TargetArmLength = FMath::Clamp(
            SpringArm->TargetArmLength - Value.Get<float>() * 100.0f, 400.0f, 4000.0f);
    }
}

void ATankPawn::ApplyAimToMesh()
{
    if (Turret) Turret->SetRelativeRotation(FRotator(0.0f, TurretYaw, 0.0f));
    if (Barrel)
    {
        // Base -90 pitch aligns the cylinder to +X; subtract elevation so it tilts upward.
        Barrel->SetRelativeRotation(FRotator(-90.0f + BarrelElevation, 0.0f, 0.0f));
    }
}

void ATankPawn::OnFire(const FInputActionValue& /*Value*/)
{
    UWorld* World = GetWorld();
    if (!World || !ShellClass) return;

    // Authoritative aim: local-frame direction from tested math, rotated into world space.
    const FVector LocalDir = TankAiming::MuzzleDirection(TurretYaw, BarrelElevation);
    const FVector WorldDir = GetActorTransform().TransformVectorNoScale(LocalDir).GetSafeNormal();
    const FVector SpawnLoc = Muzzle ? Muzzle->GetComponentLocation()
                                    : GetActorLocation() + WorldDir * 300.0f;

    FActorSpawnParameters Params;
    Params.Owner = this;
    Params.Instigator = GetInstigator();
    Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

    ARocketProjectile* Shell = World->SpawnActor<ARocketProjectile>(
        ShellClass, SpawnLoc, WorldDir.Rotation(), Params);
    if (Shell)
    {
        Shell->Launch(WorldDir, Power);
    }
}
