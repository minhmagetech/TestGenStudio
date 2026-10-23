/**
 * DiamondCollectible — a walk-over collectible that grants diamonds.
 *
 * Component Attachment: Spawned Entity (DiamondCollectible template root)
 * Component Networking: Networked
 * Component Ownership: Server
 *
 * On pickup the server grants diamonds via SoftCurrencyService; the client
 * logs a confirmation in onCollected().
 */
import {component, property} from 'meta/worlds';
import type {Entity} from 'meta/worlds';
import {Collectible} from './Collectible';
import {SoftCurrencyService} from './SoftCurrencyService';

@component()
export class DiamondCollectible extends Collectible {
  @property()
  diamondValue: number = 1;

  protected override tryCommitCollectionAsOwner(collector: Entity): boolean {
    // Server-side: grant diamonds through the wallet service.
    void SoftCurrencyService.get().grant(
      collector,
      'diamonds',
      this.diamondValue,
      'diamond_pickup',
    );
    console.log(`[DiamondCollectible] Granted ${this.diamondValue} diamond(s) to collector`);
    return true;
  }

  protected override onCollected(collector: Entity): void {
    // Client-side feedback — the HUD updates via the balance broadcast.
    console.log(`[DiamondCollectible] Collected diamond worth ${this.diamondValue}!`);
  }
}
