# Physics Guide

## Purpose
The Physics module covers the low-level simulation layer: force controllers, ground detection, and the kinematic character controller. These parameters shape how the character interacts with the physical world — friction, gravity response, and slope handling.

## Design Intent
Physics parameters should be tuned conservatively. Small changes to friction or ground detection thresholds can have large effects on movement feel. Expose only the most impactful parameters.

## Module Keywords
physics, kinematic, force, friction, ground detection, slope, collision, simulation

## Behaviors
- KinematicForceController: manual force integration via KCC addMoveDelta
- DynamicForceController: rigid-body physics via PhysicsBodyComponent
- WorldsGroundInfoComponent: two-phase ground detection (raycast + sphere-cast fallback)
- CharacterSimulationController: toggles all simulation components as a unit

## UI Rules
Layout: browse_focused
Appearance: no

### Items

```yaml
- id: kinematic
  template: Templates/PlayerCharacter.hstf
  entity: KinematicCharacter
- id: ground_detection
  template: Templates/PlayerCharacter.hstf
  entity: KinematicCharacter
```

## Content Rules
- Kinematic: friction, restitution, force integration
- Ground Detection: cast distance, slope limit, grounded threshold

## Source Files
- `scripts/controllers/KinematicForceController.ts` -- staticFriction, dynamicFriction, restitution
- `scripts/components/physics/WorldsGroundInfoComponent.ts` -- castDistance, castRadius, slopeLimit, groundedThreshold
- `scripts/components/physics/CharacterSimulationController.ts` -- simulation toggle

## Category Tune Properties

### Physics Mode
- Keywords: physics mode, kinematic, dynamic
- Affects: which force controller is active
- Suggested presets: Kinematic, Dynamic
- UI Type: toggle_multisegment
- UI Group: Customize
- Notes: Switches between KinematicForceController and DynamicForceController

### Ground Detection
- Keywords: ground detection, grounded, threshold
- Affects: how reliably the character detects ground
- Suggested presets: Strict, Standard, Lenient
- UI Type: toggle_multisegment
- UI Group: Customize
- Notes: Adjusts groundedThreshold and castDistance presets

## Item Tune Properties

### Static Friction (per-item)
- Type: Numeric
- Keywords: friction, static, surface
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/controllers/KinematicForceController.ts
  class: KinematicForceController
  property: staticFriction
  scope: per-item
```

### Dynamic Friction (per-item)
- Type: Numeric
- Keywords: friction, dynamic, sliding
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/controllers/KinematicForceController.ts
  class: KinematicForceController
  property: dynamicFriction
  scope: per-item
```

### Cast Distance (per-item)
- Type: Numeric
- Keywords: ground detection, cast distance, raycast
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/components/physics/WorldsGroundInfoComponent.ts
  class: WorldsGroundInfoComponent
  property: castDistance
  scope: per-item
```

### Slope Limit (per-item)
- Type: Numeric
- Keywords: slope, angle, walkable
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/components/physics/WorldsGroundInfoComponent.ts
  class: WorldsGroundInfoComponent
  property: slopeLimit
  scope: per-item
```
