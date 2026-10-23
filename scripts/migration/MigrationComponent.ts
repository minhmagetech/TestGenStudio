/**
 * MigrationComponent.ts
 *
 * Consolidated migration system: upsell panel, reward popup, trigger detection,
 * trigger handling, and server-side reward granting — all in one file.
 *
 * Exported components (one per entity):
 *   MigrationUpsellDetection     — PlayerCharacter physics host (client-owned)
 *   MigrationTriggerHandler      — MigrationPortal trigger volume (server-owned)
 *   MigrationRewardGrantHandler  — ServerSystems entity (server-owned)
 *   MigrationUpsellPanelController  — MigrationUpsellPanel UI entity (local, not networked)
 *   MigrationRewardPanelController  — MigrationRewardPanel UI entity (local, not networked)
 */

import {
  Component,
  component,
  subscribe,
  OnEntityStartEvent,
  ExecuteOn,
  CustomUiComponent,
  UiEvent,
  UiViewModel,
  uiViewModel,
  PlayerService,
  NetworkingService,
  NetworkEvent,
  EventService,
  MigrationService,
  MobileAppPlatform,
  Service,
  CameraService,
  UiService,
  OnSafeZonesChangeEvent,
  property,
  serializable,
} from 'meta/worlds';
import type {Entity, Maybe} from 'meta/worlds';
import {TriggerVolume} from '../TriggerVolume';
import {TriggerVolumeDetection} from '../TriggerVolumeDetection';
import {SoftCurrencyService} from '../SoftCurrencyService';

// =============================================================================
// Events (previously MigrationEvents.ts)
// =============================================================================

@serializable()
class MigrationPortalEnteredPayload {
  @property() public readonly player: Maybe<Entity> = null;
}
const MigrationPortalEnteredEvent = new NetworkEvent<MigrationPortalEnteredPayload>(
  'MigrationPortalEnteredEvent',
  MigrationPortalEnteredPayload,
);

@serializable()
class MigrationRewardGrantRequestPayload {
  @property() public readonly player: Maybe<Entity> = null;
}
const MigrationRewardGrantRequestEvent = new NetworkEvent<MigrationRewardGrantRequestPayload>(
  'MigrationRewardGrantRequestEvent',
  MigrationRewardGrantRequestPayload,
);

@serializable()
class MigrationRewardGrantedPayload {
  @property() public readonly player: Maybe<Entity> = null;
  @property() public readonly amount: number = 0;
}
const MigrationRewardGrantedEvent = new NetworkEvent<MigrationRewardGrantedPayload>(
  'MigrationRewardGrantedEvent',
  MigrationRewardGrantedPayload,
);

// =============================================================================
// UiEvent constants (module-level for perf)
// =============================================================================

const letsGoClickEvent = new UiEvent('MigrationUpsellVM-letsGoClick');
const maybeLaterClickEvent = new UiEvent('MigrationUpsellVM-maybeLaterClick');
const closeClickEvent = new UiEvent('MigrationRewardVM-closeClick');

// =============================================================================
// Safe-area constants (portrait)
// =============================================================================

const REF_W = 1080;
const REF_H = 1920;

const REWARD_AMOUNT = 100;
const CURRENCY_ID = 'diamonds';

// =============================================================================
// Helper: compute safe-area margin string
// =============================================================================

function computeSafeAreaMargin(): string {
  if (NetworkingService.get().isServerContext()) {
    return '0,0,0,0';
  }
  const safe = Service.get(UiService).getSafeZone();
  const aspect = Service.get(CameraService).aspectRatio;
  if (!Number.isFinite(aspect) || aspect <= 0) {
    return '0,0,0,0';
  }
  const designW = Math.max(REF_W, REF_H * aspect);
  const designH = Math.max(REF_H, REF_W / aspect);
  const left = safe.x * designW;
  const top = safe.y * designH;
  const right = (1 - safe.x - safe.width) * designW;
  const bottom = (1 - safe.y - safe.height) * designH;
  return `${left},${top},${right},${bottom}`;
}

// =============================================================================
// MigrationUpsellDetection
// Component Attachment: Player physics host entity (KinematicCharacter)
// Component Networking: Networked (on the player's physics body)
// Component Ownership: Player (client-owned)
// =============================================================================

@component()
export class MigrationUpsellDetection extends TriggerVolumeDetection {}

// =============================================================================
// MigrationTriggerHandler
// Component Attachment: Migration trigger volume template root entity
// Component Networking: Networked (server-owned trigger)
// Component Ownership: Server
// =============================================================================

@component()
export class MigrationTriggerHandler extends TriggerVolume {
  protected override isValidTarget(_entity: Entity): boolean {
    return true;
  }

  protected override onEntityEntered(entity: Entity): void {
    console.log('[MigrationTriggerHandler] Player entered migration portal');
    EventService.sendGlobally(MigrationPortalEnteredEvent, {player: entity});
  }
}

// =============================================================================
// MigrationRewardGrantHandler
// Component Attachment: ServerSystems scene entity (server-owned)
// Component Networking: Networked (on a server-owned entity)
// Component Ownership: Server
//
// Listens for MigrationRewardGrantRequestEvent (sent by the client when an
// unrewarded migration is detected). On the server, grants 100 diamonds via
// SoftCurrencyService and broadcasts a confirmation event back.
// =============================================================================

@component()
export class MigrationRewardGrantHandler extends Component {
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    console.log('[MigrationRewardGrantHandler] Initialized');
  }

  @subscribe(MigrationRewardGrantRequestEvent, {execution: ExecuteOn.Everywhere})
  async onGrantRequest(payload: MigrationRewardGrantRequestPayload): Promise<void> {
    if (!NetworkingService.get().isServerContext()) {
      return;
    }
    if (!payload.player) {
      console.error('[MigrationRewardGrantHandler] No player in grant request');
      return;
    }
    console.log('[MigrationRewardGrantHandler] Processing migration reward grant');
    try {
      await SoftCurrencyService.get().grant(
        payload.player,
        CURRENCY_ID,
        REWARD_AMOUNT,
        'migration_reward',
      );
      console.log(`[MigrationRewardGrantHandler] Granted ${REWARD_AMOUNT} ${CURRENCY_ID}`);
      EventService.sendGlobally(MigrationRewardGrantedEvent, {
        player: payload.player,
        amount: REWARD_AMOUNT,
      });
    } catch (err) {
      console.error('[MigrationRewardGrantHandler] Grant failed:', err);
    }
  }
}

// =============================================================================
// Upsell ViewModel
// =============================================================================

@uiViewModel()
class MigrationUpsellViewModel extends UiViewModel {
  public safeAreaMargin: string = '0,0,0,0';
  public notAvailableVisible: boolean = false;

  readonly events = {
    letsGoClick: letsGoClickEvent,
    maybeLaterClick: maybeLaterClickEvent,
  };
}

// =============================================================================
// MigrationUpsellPanelController
// Component Attachment: MigrationUpsellPanel scene entity (same entity as CustomUiComponent)
// Component Networking: Not Networked (local UI entity, client-only)
// Component Ownership: Not Networked
//
// Shows the upsell panel when the local player enters the portal trigger AND
// the platform is MobileAppPlatform.MetaApps. LET'S GO calls migrateToHorizonApp;
// MAYBE LATER hides the panel. If migration returns false, shows "not available".
// =============================================================================

@component()
export class MigrationUpsellPanelController extends Component {
  private viewModel = new MigrationUpsellViewModel();
  private customUi: Maybe<CustomUiComponent> = null;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (NetworkingService.get().isServerContext()) {
      return;
    }
    this.customUi = this.entity.getComponent(CustomUiComponent);
    if (this.customUi) {
      this.customUi.dataContext = this.viewModel;
      this.customUi.isVisible = false;
    }
    this.viewModel.safeAreaMargin = computeSafeAreaMargin();
    console.log('[MigrationUpsellPanelController] Initialized, panel hidden');
  }

  @subscribe(OnSafeZonesChangeEvent, {execution: ExecuteOn.Everywhere})
  onSafeZonesChanged(): void {
    if (NetworkingService.get().isServerContext()) {
      return;
    }
    this.viewModel.safeAreaMargin = computeSafeAreaMargin();
  }

  @subscribe(MigrationPortalEnteredEvent, {execution: ExecuteOn.Everywhere})
  onPortalEntered(payload: MigrationPortalEnteredPayload): void {
    if (NetworkingService.get().isServerContext()) {
      return;
    }
    if (!payload.player || !PlayerService.get().isLocalPlayer(payload.player)) {
      return;
    }
    const platform = MigrationService.get().getMobileAppPlatform();
    if (platform !== MobileAppPlatform.MetaApps) {
      console.log('[MigrationUpsellPanelController] Platform is not MetaApps, skipping upsell');
      return;
    }
    console.log('[MigrationUpsellPanelController] Showing upsell panel');
    this.viewModel.notAvailableVisible = false;
    if (this.customUi) {
      this.customUi.isVisible = true;
      this.customUi.dataContext = this.viewModel;
    }
  }

  @subscribe(letsGoClickEvent)
  async onLetsGoClick(): Promise<void> {
    console.log('[MigrationUpsellPanelController] LET\'S GO pressed');
    try {
      const result = await MigrationService.get().migrateToHorizonApp({
        migrationId: 'welcome_bonus_v1',
      });
      if (!result) {
        console.log('[MigrationUpsellPanelController] Migration not available');
        this.viewModel.notAvailableVisible = true;
        if (this.customUi) {
          this.customUi.dataContext = this.viewModel;
        }
      }
    } catch (err) {
      console.error('[MigrationUpsellPanelController] Migration failed:', err);
      this.viewModel.notAvailableVisible = true;
      if (this.customUi) {
        this.customUi.dataContext = this.viewModel;
      }
    }
  }

  @subscribe(maybeLaterClickEvent)
  onMaybeLaterClick(): void {
    console.log('[MigrationUpsellPanelController] MAYBE LATER pressed');
    if (this.customUi) {
      this.customUi.isVisible = false;
    }
  }
}

// =============================================================================
// Reward ViewModel
// =============================================================================

@uiViewModel()
class MigrationRewardViewModel extends UiViewModel {
  public safeAreaMargin: string = '0,0,0,0';

  readonly events = {
    closeClick: closeClickEvent,
  };
}

// =============================================================================
// MigrationRewardPanelController
// Component Attachment: MigrationRewardPanel scene entity (same entity as CustomUiComponent)
// Component Networking: Not Networked (local UI entity, client-only)
// Component Ownership: Not Networked
//
// On player join, calls fetchMigrationData(). If unrewarded migration exists,
// sends a grant request to the server and shows the reward popup. If the panel
// entity isn't ready yet, queues the popup and shows it when ready.
// =============================================================================

@component()
export class MigrationRewardPanelController extends Component {
  private viewModel = new MigrationRewardViewModel();
  private customUi: Maybe<CustomUiComponent> = null;
  private pendingShow = false;
  private entityReady = false;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (NetworkingService.get().isServerContext()) {
      return;
    }
    this.customUi = this.entity.getComponent(CustomUiComponent);
    if (this.customUi) {
      this.customUi.dataContext = this.viewModel;
      this.customUi.isVisible = false;
    }
    this.entityReady = true;
    this.viewModel.safeAreaMargin = computeSafeAreaMargin();
    console.log('[MigrationRewardPanelController] Initialized, panel hidden');

    if (this.pendingShow) {
      this.showPopup();
    }
    this.checkMigrationOnJoin();
  }

  @subscribe(OnSafeZonesChangeEvent, {execution: ExecuteOn.Everywhere})
  onSafeZonesChanged(): void {
    if (NetworkingService.get().isServerContext()) {
      return;
    }
    this.viewModel.safeAreaMargin = computeSafeAreaMargin();
  }

  private async checkMigrationOnJoin(): Promise<void> {
    try {
      const migrationService = MigrationService.get();
      const data = await migrationService.fetchMigrationData();

      if (data?.hasUnrewardedMigration) {
        console.log('[MigrationRewardPanelController] Unrewarded migration found, requesting grant');
        const localPlayer = PlayerService.get().getLocalPlayer();
        EventService.sendGlobally(MigrationRewardGrantRequestEvent, {
          player: localPlayer,
        });

        const closed = await migrationService.setMigrationRewardGranted();
        console.log(`[MigrationRewardPanelController] setMigrationRewardGranted returned: ${closed}`);

        if (this.entityReady) {
          this.showPopup();
        } else {
          this.pendingShow = true;
        }
      } else {
        console.log('[MigrationRewardPanelController] No unrewarded migration');
      }
    } catch (err) {
      console.error('[MigrationRewardPanelController] Migration check failed:', err);
    }
  }

  @subscribe(MigrationRewardGrantedEvent, {execution: ExecuteOn.Everywhere})
  onRewardGranted(payload: MigrationRewardGrantedPayload): void {
    if (NetworkingService.get().isServerContext()) {
      return;
    }
    if (!payload.player || !PlayerService.get().isLocalPlayer(payload.player)) {
      return;
    }
    console.log(`[MigrationRewardPanelController] Server confirmed grant of ${payload.amount} diamonds`);
    if (!this.pendingShow && this.entityReady && this.customUi && !this.customUi.isVisible) {
      this.showPopup();
    }
  }

  private showPopup(): void {
    this.pendingShow = false;
    if (this.customUi) {
      this.customUi.isVisible = true;
      this.customUi.dataContext = this.viewModel;
      console.log('[MigrationRewardPanelController] Reward popup shown');
    }
  }

  @subscribe(closeClickEvent)
  onCloseClick(): void {
    console.log('[MigrationRewardPanelController] Close pressed');
    if (this.customUi) {
      this.customUi.isVisible = false;
    }
  }
}
