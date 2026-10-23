# Base AI Template - Project Summary

## Overview

A third-person character controller template with camera-relative movement, physics-based locomotion, and animation integration. Features a modular, component-based architecture with a rule-based state machine for character states.

The template uses a **two-entity hierarchy** — a CharacterRootEntity and a CharacterSimulatedEntity — that separates logical character state from physics simulation, enabling runtime hot-swapping of the simulated body.

## Scene (`space.hstf`)

- **StartingWorld** - Scene root entity
- **Floor** - 120x120 unit white plane with static box collision at origin (spans ±60m). Sized to cover a large play area so the player and NPCs stay grounded when gameplay ranges far from the origin — e.g. distance-gated spawns or chase/patrol over distance. Gameplay that reaches beyond ±60m must enlarge this floor's `localScale` further (its `ColliderBoxPlatformComponent` scales with it), or the player falls through the world.
- **SpawnPoint** - Player spawn location at (0, 0.315, 0)
- **Directional Light** - Scene lighting at (0, 10, 0)
- **Camera** - Third-person camera with ThirdPersonCamera script. Auto-follows behind the player for one-thumb play; right stick/mouse still control yaw/pitch as a manual override that re-engages auto-follow after a delay. Includes collision avoidance and angle-space smoothing. Set `autoFollowEnabled` to false to restore right-stick/mouse-only control.

## Player Template (`Templates/PlayerCharacter.hstf`)

The player is a fully-featured character controller with modular components for movement, physics, animation, and state management, split across two entities.

### Entity Hierarchy

```
PlayerCharacter (CharacterRootEntity)
├── SimulatedBody (CharacterSimulatedEntity)
│   └── Collider — Capsule collider (radius: 0.3, height: 1.2)
└── Visuals — Character mesh with AnimatorComponent and animation clips
```

### CharacterRootEntity (`PlayerCharacter`)

The root entity that other systems refer to as "the character". Owns the root transform. All gameplay-logic and high-level controller components live here.

| Component / Script | Purpose |
|--------------------|---------|
| `BasePlayerComponent` | Marks entity as client-owned player |
| `CharacterUpdateManager` | Orchestrates all subsystems in correct update order; supports runtime hot-swap of the simulated body via `swapSimulatedEntity()` |
| `CharacterStateMachine` | Rule-based state machine (Movement, Jumping, Dashing) |
| `MovementAbility` | Camera-relative movement with acceleration curves, air control, and slide mechanics |
| `JumpAbility` | Jump physics with impulse, coyote time, jump buffering, and cooldown |
| `DashAbility` | Dash ability with directional dash |
| `AnimationController` | Drives animator graph variables (`FrontSpeed`, `IsGrounded`, `IsJumping`, `MovementDirectionYaw`); references Visuals entity for `AnimatorComponent` |
| `PlayerActionController` | Input handler with dead zone filtering |

### CharacterSimulatedEntity (`SimulatedBody`)

The entity that runs the character's physics simulation, normally a child of the CharacterRootEntity. All physics-related components live here to keep physics self-contained and hot-swappable.

| Component / Script | Purpose |
|--------------------|---------|
| `CharacterSimulationController` | Toggles all simulation components (`WorldsGroundInfoComponent`, `CharacterForceControllerBase`, `PhysicsBodyComponent`) as a unit via `setActive()`; monitors its `enabled` property each frame so it can be toggled from the editor UI; used by `CharacterUpdateManager` for auto-discovery and body swapping |
| `PhysicsBodyComponent` | Physics simulation (mass: 10, locked rotation) |
| `KinematicCharacterComponent` | Kinematic character controller (height: 1.75, step offset: 0.5, slope limit: 45°) |
| `CharacterForceControllerBase` | Abstract force controller base (one concrete subclass is active at a time) |
| `KinematicForceController` | Kinematic physics forces (gravity, friction, collision response via KCC move-delta) |
| `DynamicForceController` | Rigid-body physics forces via `PhysicsBodyComponent` (for simulation-style characters) |
| `WorldsGroundInfoComponent` | Ground detection via raycast with sphere-cast fallback |

### Visuals Entity

- Character mesh with `AnimatorComponent`
- Rotated 180° on Y-axis for proper orientation

**Animation Clips (12 total):**
- Idle
- Walk: Fwd, Back, Left, Right
- Run: Fwd, Back, Left, Right
- Jump: Start, Loop, Land

## Key Architecture Concepts

### ICharacterInitializable Interface

All character sub-systems implement `ICharacterInitializable`, which provides:

```typescript
initialize(characterRootEntity: Entity, characterSimulatedEntity: Entity): void
```

This two-entity initialization pattern lets each sub-system acquire its dependencies from the correct entity:
- **From CharacterRootEntity**: `TransformComponent`, `MovementAbility`, `JumpAbility`, `DashAbility`, `CharacterStateMachine`, `AnimationController`
- **From CharacterSimulatedEntity**: `CharacterForceControllerBase`, `WorldsGroundInfoComponent`, `PhysicsBodyComponent`, `CharacterControllerBase` (KCC), colliders

### Runtime Body Swapping

`CharacterUpdateManager.swapSimulatedEntity()` allows hot-swapping the simulated body at runtime. This enables the character to change its physics shape, motion model, or behavior dynamically (e.g., switching from a humanoid to a ball).

The swap flow:
1. Deactivates the previous force controller and ground info (`enabled = false`)
2. Acquires new sub-system references from the new simulated entity
3. Re-initializes all sub-systems via `ICharacterInitializable.initialize()`
4. Activates the new force controller and ground info (`enabled = true`)

If no `characterSimulatedEntity` is explicitly set, `CharacterUpdateManager` auto-discovers it by searching children for a `CharacterSimulationController`. It selects the first child whose `CharacterSimulationController` is enabled, disables all other children's controllers, and falls back to `this.entity` (root) if no enabled controller is found.

### Transform Synchronization

Because the simulated entity is a child, the force controller syncs transforms after physics:
- `CharacterForceControllerBase.syncCharacterTransform()` copies the simulated entity's world position back to the root entity, then re-writes it to the simulated entity (to avoid parent–child offset drift).
- `KinematicForceController` also syncs rotation; `DynamicForceController` leaves rotation to the physics engine.

### Force Controller Selection

Only one force controller should be active at a time on the simulated entity:

| Controller | Use Case | Physics Model |
|-----------|----------|---------------|
| `KinematicForceController` | Standard character control (predictable, responsive) | Fakes physics via manual integration + KCC `addMoveDelta` |
| `DynamicForceController` | Simulation-style (rolling, tumbling, bouncing) | Delegates to `PhysicsBodyComponent` rigid-body dynamics |

## Key Systems

### Update Order (`CharacterUpdateManager.onWorldUpdate`)

Each frame, subsystems are updated in this order:
1. `WorldsGroundInfoComponent.update()` — ground detection
2. `CharacterForceControllerBase.update(dt)` — physics integration
3. `CharacterStateMachine.update(dt)` — state transitions & ability updates
4. `AnimationController.update()` — sync animation graph variables
5. Registered callbacks

### Input System
- Uses `IInputProvider` interface for input abstraction
- Dead zone processing with configurable thresholds

**⚠️ Input UI Not Implemented:** Movement works via joystick/mouse, but **Jump and Dash abilities have no input UI** — HUD buttons need to be added before players can trigger them.

### Movement Features
- Camera-relative movement (forward input = camera's forward direction)
- Smooth acceleration/deceleration curves
- Air control with configurable multiplier
- Slide direction lock mechanics
- Runtime speed multiplier support
- Force-based input mode (for dynamic characters)

### State Machine
- States: `Movement`, `Jumping`, `Dashing`
- Priority-ordered transition rules
- Context-aware (ground state, time in state)
- Extensible with custom states and rules

### Ground Detection (`WorldsGroundInfoComponent`)
- Two-phase detection: raycast first, sphere-cast fallback
- Configurable slope limit, grounded threshold, cast distance
- Provides `isGrounded`, `isGroundHit`, `groundDistance`, `lastGoodGroundHit`
- Can be enabled/disabled for body swapping

## Key Files

**Core Scripts:**
- `scripts/ThirdPersonCamera.ts` - Third-person camera with auto-follow for one-thumb play (right stick/mouse manual override, collision, angle-space smoothing)
- `scripts/controllers/CharacterStateMachine.ts` - State machine (Movement, Jumping, Dashing)
- `scripts/controllers/PlayerActionController.ts` - Input handling
- `scripts/controllers/AnimationController.ts` - Animation driver
- `scripts/controllers/ICharacterInitializable.ts` - Two-entity initialization interface

**Component Scripts:**
- `scripts/components/update/CharacterUpdateManager.ts` - Update orchestration & body swapping
- `scripts/components/ability/MovementAbility.ts` - Movement logic with acceleration, air control, slide mechanics
- `scripts/components/ability/JumpAbility.ts` - Jump ability with coyote time, buffering, cooldown
- `scripts/components/ability/DashAbility.ts` - Dash ability
- `scripts/controllers/CharacterForceControllerBase.ts` - Abstract force controller base class
- `scripts/controllers/KinematicForceController.ts` - Kinematic physics forces
- `scripts/controllers/DynamicForceController.ts` - Rigid-body physics forces
- `scripts/components/physics/CharacterSimulationController.ts` - Simulation activation toggle for the CharacterSimulatedEntity
- `scripts/components/physics/WorldsGroundInfoComponent.ts` - Ground detection

**Utilities:**
- `scripts/utils/AccelerationCurve.ts` - Smooth acceleration
- `scripts/utils/DeadZone.ts` - Input dead zone processing
- `scripts/utils/InputBuffer.ts` - Input buffering
- `scripts/utils/GraceTimer.ts` - Coyote time grace period
- `scripts/utils/Cooldown.ts` - Cooldown timer

## Additional Templates

Primitive templates available in `Templates/Primitives/`:
- Cone, Cube, Cylinder, Disc, Plane, Prism, Pyramid, Sphere, Torus, Wedge
