import {
  Component,
  component,
  NetworkMode,
  NetworkingService,
  property,
  TemplateAsset,
  Vec3,
  WorldService,
} from 'meta/worlds';
import type {Maybe} from 'meta/worlds';

/**
 * Spawns collectibles with ownership following the network mode.
 *
 * Networked collectibles spawn from the server context so the server is the
 * initial owner and verdict authority. Local-only items spawn from any
 * context and stay local to the spawning client.
 */
@component()
export class CollectibleSpawner extends Component {
  /** Template with a Collectible-derived component attached to its root. */
  @property()
  collectibleTemplate: Maybe<TemplateAsset> = null;

  /** Network mode for spawned collectibles. LocalOnly keeps items local-only. */
  @property()
  networkMode: NetworkMode = NetworkMode.Networked;

  /** Spawns one collectible at a world position. */
  async spawnCollectible(position: Vec3): Promise<void> {
    if (!this.collectibleTemplate) {
      console.warn('CollectibleSpawner: No template assigned');
      return;
    }

    // Networked collectibles are server-spawned so the server owns the
    // verdict; spawning them from a client would leave a client as authority.
    if (
      this.networkMode !== NetworkMode.LocalOnly &&
      !NetworkingService.get().isServerContext()
    ) {
      return;
    }

    await WorldService.get().spawnTemplate({
      templateAsset: this.collectibleTemplate,
      networkMode: this.networkMode,
      position,
    });
  }

  /** Spawns multiple collectibles through the same ownership path. */
  async spawnCollectibles(positions: Vec3[]): Promise<void> {
    for (const position of positions) {
      await this.spawnCollectible(position);
    }
  }
}
