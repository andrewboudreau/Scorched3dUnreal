#include "FlyCameraPawn.h"
#include "Camera/CameraComponent.h"
#include "GameFramework/FloatingPawnMovement.h"
#include "GameFramework/PlayerController.h"
#include "Engine/LocalPlayer.h"
#include "Engine/World.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "InputAction.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "InputActionValue.h"
#include "RocketProjectile.h"

AFlyCameraPawn::AFlyCameraPawn()
{
    PrimaryActorTick.bCanEverTick = false;
    AutoPossessPlayer = EAutoReceiveInput::Player0; // controllable even if placed manually

    Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
    RootComponent = Camera;

    Movement = CreateDefaultSubobject<UFloatingPawnMovement>(TEXT("Movement"));
    Movement->UpdatedComponent = Camera;
    Movement->MaxSpeed = MoveSpeed;
    Movement->Acceleration = 8000.0f;
    Movement->Deceleration = 8000.0f;

    // Pawn turns with the controller; the camera (root) follows, so "forward" tracks look.
    bUseControllerRotationYaw = true;
    bUseControllerRotationPitch = true;
    bUseControllerRotationRoll = false;

    RocketClass = ARocketProjectile::StaticClass();
}

void AFlyCameraPawn::BuildInput()
{
    if (MoveAction) return; // already built

    MappingContext = NewObject<UInputMappingContext>(this);

    MoveAction = NewObject<UInputAction>(this);
    MoveAction->ValueType = EInputActionValueType::Axis2D;
    LookAction = NewObject<UInputAction>(this);
    LookAction->ValueType = EInputActionValueType::Axis2D;
    VerticalAction = NewObject<UInputAction>(this);
    VerticalAction->ValueType = EInputActionValueType::Axis1D;
    FireAction = NewObject<UInputAction>(this);
    FireAction->ValueType = EInputActionValueType::Boolean;

    // --- Move (Axis2D): X = forward (W/S), Y = right (A/D) ---
    MappingContext->MapKey(MoveAction, EKeys::W); // +X
    {
        FEnhancedActionKeyMapping& M = MappingContext->MapKey(MoveAction, EKeys::S);
        M.Modifiers.Add(NewObject<UInputModifierNegate>(this)); // -X
    }
    {
        FEnhancedActionKeyMapping& M = MappingContext->MapKey(MoveAction, EKeys::D);
        UInputModifierSwizzleAxis* Swiz = NewObject<UInputModifierSwizzleAxis>(this);
        Swiz->Order = EInputAxisSwizzle::YXZ; // route the key's value onto Y => +Y (right)
        M.Modifiers.Add(Swiz);
    }
    {
        FEnhancedActionKeyMapping& M = MappingContext->MapKey(MoveAction, EKeys::A);
        UInputModifierSwizzleAxis* Swiz = NewObject<UInputModifierSwizzleAxis>(this);
        Swiz->Order = EInputAxisSwizzle::YXZ;
        M.Modifiers.Add(Swiz);                                  // value onto Y
        M.Modifiers.Add(NewObject<UInputModifierNegate>(this)); // then negate => -Y (left)
    }

    // --- Look (Axis2D): mouse delta (X=yaw, Y=pitch) ---
    MappingContext->MapKey(LookAction, EKeys::Mouse2D);

    // --- Vertical (Axis1D): E up (+1), Q down (-1) ---
    MappingContext->MapKey(VerticalAction, EKeys::E);
    {
        FEnhancedActionKeyMapping& M = MappingContext->MapKey(VerticalAction, EKeys::Q);
        M.Modifiers.Add(NewObject<UInputModifierNegate>(this));
    }

    // --- Fire (Boolean): left mouse button ---
    MappingContext->MapKey(FireAction, EKeys::LeftMouseButton);
}

void AFlyCameraPawn::BeginPlay()
{
    Super::BeginPlay();
    if (Movement)
    {
        Movement->MaxSpeed = MoveSpeed; // honor an editor-tuned MoveSpeed at runtime
    }
    BuildInput();

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

void AFlyCameraPawn::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
    Super::SetupPlayerInputComponent(PlayerInputComponent);
    BuildInput();

    if (UEnhancedInputComponent* EIC = Cast<UEnhancedInputComponent>(PlayerInputComponent))
    {
        EIC->BindAction(MoveAction, ETriggerEvent::Triggered, this, &AFlyCameraPawn::OnMove);
        EIC->BindAction(LookAction, ETriggerEvent::Triggered, this, &AFlyCameraPawn::OnLook);
        EIC->BindAction(VerticalAction, ETriggerEvent::Triggered, this, &AFlyCameraPawn::OnVertical);
        EIC->BindAction(FireAction, ETriggerEvent::Started, this, &AFlyCameraPawn::OnFire);
    }
}

void AFlyCameraPawn::OnMove(const FInputActionValue& Value)
{
    const FVector2D Axis = Value.Get<FVector2D>();
    AddMovementInput(GetActorForwardVector(), Axis.X);
    AddMovementInput(GetActorRightVector(), Axis.Y);
}

void AFlyCameraPawn::OnLook(const FInputActionValue& Value)
{
    const FVector2D Axis = Value.Get<FVector2D>();
    AddControllerYawInput(Axis.X * LookSensitivity);
    AddControllerPitchInput(-Axis.Y * LookSensitivity); // mouse-up looks up
}

void AFlyCameraPawn::OnVertical(const FInputActionValue& Value)
{
    AddMovementInput(FVector::UpVector, Value.Get<float>());
}

void AFlyCameraPawn::OnFire(const FInputActionValue& /*Value*/)
{
    UWorld* World = GetWorld();
    if (!World || !RocketClass || !Camera) return;

    const FVector Forward = Camera->GetForwardVector();
    const FVector SpawnLoc = Camera->GetComponentLocation() + Forward * 150.0f;
    const FRotator SpawnRot = Camera->GetComponentRotation();

    FActorSpawnParameters Params;
    Params.Owner = this;
    Params.Instigator = GetInstigator();
    Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

    ARocketProjectile* Rocket = World->SpawnActor<ARocketProjectile>(
        RocketClass, SpawnLoc, SpawnRot, Params);
    if (Rocket)
    {
        Rocket->Launch(Forward, LaunchSpeed);
    }
}
