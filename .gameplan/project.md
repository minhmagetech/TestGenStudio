# Base AI Template

## Core Idea
summary: A modular third-person character controller template with physics, camera, and animation.

A production-ready starting point for third-person games. The template provides camera-relative movement, physics-based locomotion, jump and dash abilities, and a rule-based state machine — all wired together in a clean two-entity hierarchy that separates logical state from physics simulation.

## Gameplay
summary: Move, jump, and dash a character through a 3D space with responsive, physics-driven controls.

- **Move** -- Camera-relative WASD/joystick locomotion with smooth acceleration
- **Jump** -- Physics impulse jump with coyote time and input buffering
- **Dash** -- Instant burst movement in any direction with cooldown
- **Explore** -- Navigate the environment with a collision-aware third-person camera

## Mechanics
summary: Component-based state machine drives movement, jump, and dash via modular ability scripts.

The character uses a two-entity hierarchy (root + simulated body) that cleanly separates gameplay logic from physics. A rule-based state machine (Movement / Jumping / Dashing) orchestrates ability activation. The camera orbits the player with angle-space smoothing and collision avoidance. All subsystems implement `ICharacterInitializable` for hot-swappable physics bodies.

## Game Feel
summary: Responsive and snappy with smooth acceleration curves, coyote time, and camera polish.

The template prioritizes responsiveness: acceleration curves prevent floaty movement, coyote time forgives late jumps, and the camera uses angle-space smoothing to avoid quaternion oscillation. Designers can tune every parameter — from jump impulse to camera FOV — without touching code.

## Inspiration
- Classic third-person action games with tight, responsive controls
- Platformers that reward precise movement timing
- Camera systems that stay out of the way while keeping the player visible

## Modules

- **Overview** -- Project identity, module navigation, and key tunable parameters
  includes: overview
- **Player** -- The controllable character and all movement abilities
  includes: player, movement, jump, dash, animation, state_machine
- **Camera** -- Third-person camera orbit, smoothing, and collision avoidance
  includes: camera
- **Physics** -- Force controllers, ground detection, and physics simulation
  includes: physics, kinematic, dynamic, ground_detection

```yaml
overview:
  type: overview
  owns: [project_identity, module_navigation, aggregate_controls]

player:
  type: gameplay
  owns: [player_character, movement_ability, jump_ability, dash_ability, animation, state_machine]
  rationale: "The controllable entity and all abilities that drive its behavior."

camera:
  type: system
  owns: [camera_orbit, camera_smoothing, camera_collision, camera_fov]
  rationale: "Third-person camera that follows the player with collision avoidance."

physics:
  type: system
  owns: [force_controller, ground_detection, physics_simulation, body_swapping]
  excludes: [player_character]
  rationale: "Low-level physics: force integration, ground raycasting, and body hot-swap."
```

## Tags

```yaml
responsiveness: "Properties that affect how quickly the character responds to input."
feel: "Properties that affect the overall game feel and player satisfaction."
```

## Relationships
- Player movement reads camera forward direction from the Camera module for camera-relative locomotion
- Physics module provides ground state to the Player module for jump and movement decisions
- State machine in Player module gates ability activation based on ground detection from Physics
