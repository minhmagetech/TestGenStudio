/**
 * DiamondSpawnerComponent — spawns diamond collectibles at predefined positions.
 *
 * Component Attachment: Scene Entity (server-owned, e.g. ServerSystems)
 * Component Networking: Networked
 * Component Ownership: Server
 *
 * On start, the server spawns diamond collectibles at fixed positions around
 * the player spawn area so they can be tested immediately.
 */
import {
  Component,
  component,
  ExecuteOn,
  NetworkingService,
  NetworkMode,
  OnEntityStartEvent,
  property,
  subscribe,
  TemplateAsset,
  Vec3,
  WorldService,
} from 'meta/worlds';
import type {Maybe} from 'meta/worlds';

@component()
export class DiamondSpawnerComponent extends Component {
  @property()
  diamondTemplate: Maybe<TemplateAsset> = null;

  /** Positions to spawn diamonds at (relative to world origin). */
  private readonly spawnPositions: Vec3[] = [
    new Vec3(3, 0.5, 3),
    new Vec3(-3, 0.5, -3),
    new Vec3(5, 0.5, 0),
    new Vec3(0, 0.5, 5),
    new Vec3(-5, 0.5, -1),
  ];

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    // Only the server spawns networked collectibles.
    if (!NetworkingService.get().isServerContext()) {
      return;
    }
    if (!this.diamondTemplate) {
      console.log('[DiamondSpawnerComponent] No diamondTemplate assigned — skipping spawn');
      return;
    }
    console.log(`[DiamondSpawnerComponent] Spawning ${this.spawnPositions.length} diamonds`);
    for (const pos of this.spawnPositions) {
      void this.spawnDiamond(pos);
    }
  }

  private async spawnDiamond(position: Vec3): Promise<void> {
    if (!this.diamondTemplate) return;
    try {
      await WorldService.get().spawnTemplate({
        templateAsset: this.diamondTemplate,
        networkMode: NetworkMode.Networked,
        position: position,
      });
    } catch (e) {
      console.log(`[DiamondSpawnerComponent] Failed to spawn diamond at ${position}: ${e}`);
    }
  }
}
