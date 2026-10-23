# Player Guide

## Purpose
The Player module covers the controllable character and all movement abilities: ground locomotion, jumping, and dashing. It is the primary design surface for how the character feels to control.

## Design Intent
Prioritize responsiveness and precision. Acceleration curves should feel snappy without being instant. Jump timing should reward skilled play via coyote time and input buffering. Dash should feel powerful but gated by cooldown.

## Module Keywords
movement, locomotion, jump, dash, ability, character, state machine, animation

## Behaviors
- Camera-relative movement with smooth acceleration/deceleration
- Jump with coyote time, input buffering, and cooldown
- Directional dash with configurable distance, duration, and cooldown
- Rule-based state machine: Movement → Jumping → Dashing

## UI Rules
Layout: browse_focused
Appearance: yes

### Items

```yaml
- id: player_character
  template: Templates/PlayerCharacter.hstf
  entity: Visuals
```

## Content Rules
- Each item represents a distinct character configuration or ability profile
- Include movement speed, jump height, and dash distance as primary tunables

## Source Files
- `scripts/components/ability/MovementAbility.ts` -- moveSpeed, rotationSpeed, accelerationTime, airControlFactor, decelerationFactor
- `scripts/components/ability/JumpAbility.ts` -- jumpImpulse, jumpBufferTime, coyoteTime, jumpCooldown
- `scripts/components/ability/DashAbility.ts` -- dashDistance, dashDuration, dashCooldown
- `scripts/controllers/CharacterStateMachine.ts` -- state machine (Movement, Jumping, Dashing)
- `scripts/controllers/AnimationController.ts` -- animation graph variables

## Quick Tune Properties

### Move Speed
- Type: Numeric
- Keywords: movement, speed, locomotion
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/components/ability/MovementAbility.ts
  class: MovementAbility
  property: moveSpeed
  scope: singleton
  template: Templates/PlayerCharacter.hstf
  entity: PlayerCharacter
  tags: [responsiveness, feel]
```

### Jump Impulse
- Type: Numeric
- Keywords: jump, height, impulse
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/components/ability/JumpAbility.ts
  class: JumpAbility
  property: jumpImpulse
  scope: singleton
  template: Templates/PlayerCharacter.hstf
  entity: PlayerCharacter
  tags: [feel]
```

## Category Tune Properties

### Movement Style
- Keywords: movement, style, physics mode
- Affects: movement feel, momentum
- Suggested presets: Kinematic (responsive), Force-Based (momentum)
- UI Type: toggle_multisegment
- UI Group: Customize
- Notes: Toggles useForceAsInputs on MovementAbility

### Slide Direction Lock
- Keywords: slide, direction, lock, precision
- Affects: movement precision on slopes
- Suggested presets: Off, On
- UI Type: toggle_multisegment
- UI Group: Customize
- Notes: Toggles slideDirectionLockEnabled

### Strafe Mode
- Keywords: strafe, rotation, camera-facing
- Affects: character rotation behavior
- Suggested presets: Off (face movement), On (face camera)
- UI Type: toggle_multisegment
- UI Group: Customize
- Notes: Toggles strafeMode on MovementAbility

### Acceleration
- Keywords: acceleration, smoothing, responsiveness
- Affects: how quickly the character reaches max speed
- Suggested presets: Instant, Smooth, Gradual
- UI Type: toggle_multisegment
- UI Group: Customize
- Notes: Controls enableAcceleration and accelerationTime

## Item Tune Properties

### Move Speed (per-item)
- Type: Numeric
- Keywords: movement, speed
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/components/ability/MovementAbility.ts
  class: MovementAbility
  property: moveSpeed
  scope: per-item
  tags: [responsiveness]
```

### Jump Impulse (per-item)
- Type: Numeric
- Keywords: jump, height
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/components/ability/JumpAbility.ts
  class: JumpAbility
  property: jumpImpulse
  scope: per-item
  tags: [feel]
```

### Rotation Speed (per-item)
- Type: Numeric
- Keywords: rotation, turning speed
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/components/ability/MovementAbility.ts
  class: MovementAbility
  property: rotationSpeed
  scope: per-item
```

### Acceleration Time (per-item)
- Type: Numeric
- Keywords: acceleration, ramp-up
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/components/ability/MovementAbility.ts
  class: MovementAbility
  property: accelerationTime
  scope: per-item
  tags: [responsiveness]
```

### Air Control Factor (per-item)
- Type: Numeric
- Keywords: air control, aerial movement
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/components/ability/MovementAbility.ts
  class: MovementAbility
  property: airControlFactor
  scope: per-item
```

### Jump Buffer Time (per-item)
- Type: Numeric
- Keywords: jump buffer, input forgiveness
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/components/ability/JumpAbility.ts
  class: JumpAbility
  property: jumpBufferTime
  scope: per-item
```

### Coyote Time (per-item)
- Type: Numeric
- Keywords: coyote time, ledge forgiveness
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/components/ability/JumpAbility.ts
  class: JumpAbility
  property: coyoteTime
  scope: per-item
```
