# Camera Guide

## Purpose
The Camera module controls the third-person camera that orbits the player. It handles distance, height, smoothing, collision avoidance, and field of view — all the parameters that shape how the player perceives the game world.

## Design Intent
The camera should stay out of the way while keeping the player clearly visible. Smoothing should feel polished without introducing lag. Collision avoidance should be invisible to the player.

## Module Keywords
camera, third-person, orbit, smoothing, collision, FOV, pitch, yaw

## Behaviors
- Orbits the player at a configurable distance and shoulder height
- Angle-space smoothing prevents quaternion hemisphere-crossing oscillation
- Collision avoidance with state machine (NoCollision → Collided → WaitingToReturn → Returning)
- Right stick / mouse controls yaw and pitch

## UI Rules
Layout: browse_focused
Appearance: no

### Items

```yaml
- id: third_person_camera
  template: space.hstf
  entity: Camera
```

## Content Rules
- Camera is a singleton system — one item representing the scene camera
- Expose distance, height, FOV, and smoothing as primary tunables

## Remix & Validation Rules
When remixing an existing world, the Camera entity is inherited from the source world and may not fit the new layout. A camera tuned for one game (e.g. a pulled-back tycoon view) becomes unusable in a different one and presents as the camera being stuck at ground level. Before finishing a remix, validate and re-derive:
- `targetDistance` and `fieldOfView` must sit within the tunable ranges (targetDistance 2 to 20, fieldOfView 40 to 110). Inherited values outside these ranges leave the world unviewable.
- `nearClippingPlane` / `farClippingPlane` live on the Camera entity's CameraComponent and are not surfaced as tunables. The CameraComponent API range is 0.001 to 1000, but `ThirdPersonCamera` and the engine backstop cap `nearClippingPlane` at 0.05 for a usable third-person view, because a large near plane clips the whole scene. Keep the authored `nearClippingPlane` small (around 0.01) and `farClippingPlane` well beyond it. Runtime correction applies when values are out of range, but the authored template values should still be sane.
- The Camera entity's initial position must match the resolved player spawn, not the source world's spawn. Resolve the spawn platform first; if it cannot be resolved (e.g. the template is not loaded yet), retry rather than guessing a camera position.
- The FOV bounds are intentionally layered, not a mismatch: 40 to 110 is the recommended authoring range surfaced here, the `ThirdPersonCamera` runtime enforces a wider [20, 120] safety net, and the engine `CameraPlatformComponent` clamps to [20, 179] (the SDK FOV range is 20 to 180). Do not align one to another.

## Source Files
- `scripts/ThirdPersonCamera.ts` -- targetDistance, shoulderHeight, shoulderOffset, mouseSensitivity, fieldOfView, rotationSpeed, translationSpeed, minPitch, maxPitch, defaultPitch, enableCollision, collisionRadius

## Quick Tune Properties

### Camera Distance
- Type: Numeric
- Keywords: camera, distance, zoom
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/ThirdPersonCamera.ts
  class: ThirdPersonCamera
  property: targetDistance
  scope: singleton
  template: space.hstf
  entity: Camera
  tags: [feel]
```

### Field of View
- Type: Numeric
- Keywords: FOV, field of view, zoom
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/ThirdPersonCamera.ts
  class: ThirdPersonCamera
  property: fieldOfView
  scope: singleton
  template: space.hstf
  entity: Camera
  tags: [feel]
```

## Category Tune Properties

### Camera Style
- Keywords: camera style, perspective, distance
- Affects: how close/far the camera sits from the player
- Suggested presets: Close, Standard, Wide
- UI Type: toggle_multisegment
- UI Group: Customize
- Notes: Adjusts targetDistance preset

### Collision Avoidance
- Keywords: collision, avoidance, clipping
- Affects: whether camera clips through geometry
- Suggested presets: Off, On
- UI Type: toggle_multisegment
- UI Group: Customize
- Notes: Toggles enableCollision

### Smoothing Level
- Keywords: smoothing, lag, responsiveness
- Affects: how snappy vs. smooth the camera feels
- Suggested presets: Snappy, Balanced, Smooth
- UI Type: toggle_multisegment
- UI Group: Customize
- Notes: Adjusts rotationSpeed and translationSpeed presets

## Item Tune Properties

### Target Distance (per-item)
- Type: Numeric
- Keywords: distance, zoom
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/ThirdPersonCamera.ts
  class: ThirdPersonCamera
  property: targetDistance
  scope: per-item
  tags: [feel]
```

### Shoulder Height (per-item)
- Type: Numeric
- Keywords: height, shoulder, pivot
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/ThirdPersonCamera.ts
  class: ThirdPersonCamera
  property: shoulderHeight
  scope: per-item
```

### Mouse Sensitivity (per-item)
- Type: Numeric
- Keywords: sensitivity, input, rotation
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/ThirdPersonCamera.ts
  class: ThirdPersonCamera
  property: mouseSensitivity
  scope: per-item
  tags: [responsiveness]
```

### Field of View (per-item)
- Type: Numeric
- Keywords: FOV, field of view
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/ThirdPersonCamera.ts
  class: ThirdPersonCamera
  property: fieldOfView
  scope: per-item
  tags: [feel]
```

### Rotation Speed (per-item)
- Type: Numeric
- Keywords: rotation, smoothing, snappiness
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/ThirdPersonCamera.ts
  class: ThirdPersonCamera
  property: rotationSpeed
  scope: per-item
  tags: [responsiveness]
```

### Translation Speed (per-item)
- Type: Numeric
- Keywords: translation, follow speed, lag
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/ThirdPersonCamera.ts
  class: ThirdPersonCamera
  property: translationSpeed
  scope: per-item
```
