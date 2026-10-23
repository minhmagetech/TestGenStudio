/** AGENTS: Copy via copy_local_file. Adapt only the demo-spend constants below. */

import {
  Component,
  component,
  CustomUiComponent,
  EventService,
  ExecuteOn,
  NetworkingService,
  NetworkMode,
  OnEntityStartEvent,
  PlayerService,
  subscribe,
  UiEvent,
  UiViewModel,
  uiViewModel,
  type Maybe,
} from 'meta/worlds';

import {
  CurrencyBalanceEvent,
  type CurrencyBalancePayload,
  SpendCurrencyRequestEvent,
  SpendCurrencyRequestPayload,
} from './SoftCurrencyEvents';

// Demo spend button target. Replace with real Store wiring for production; the
// HUD itself only needs to DISPLAY balances.
const DEMO_SPEND_CURRENCY = 'gems';
const DEMO_SPEND_AMOUNT = 5;

// Unique per HUD instance so a rebuilt HUD (spendCounter resets to 0) can't reuse a
// requestId the server already committed. Date.now() separates mounts over time; the
// random suffix covers same-ms reconstruction. Falls back to random-only if the client
// runtime lacks Date (VERIFY-IN-EDITOR: confirm Date.now/Math.random exist client-side).
function makeMountSeed(): string {
  try {
    return `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  } catch {
    return `r${Math.floor(Math.random() * 1e9)}`;
  }
}

//#region ViewModel

const onSpendClicked = new UiEvent('SoftCurrencyOnSpendClicked');

// One pill per currency. The Noesis ItemsControl binds `@uiViewModel()` INSTANCES,
// not plain objects — a plain-object array fails to build.
@uiViewModel()
class SoftCurrencyPillViewModel extends UiViewModel {
  Name: string = '';
  Balance: string = '';
}

/**
 * Minimal balance display. One pill per currency, bound to a Noesis
 * ItemsControl. (All richer HUD UX — placement, VR/mobile, failure feedback,
 * juice, number formatting, a11y — is a deferred phase; plan §13.)
 */
@uiViewModel()
class SoftCurrencyHUDViewModel extends UiViewModel {
  Pills: readonly SoftCurrencyPillViewModel[] = [];
  override readonly events = {onSpendClicked};
}

//#endregion ViewModel

//#region Component

/**
 * Client-side wallet HUD.
 *
 * CRITICAL — every @subscribe must specify {execution: ExecuteOn.Everywhere}.
 * Without it, OnEntityStartEvent does not fire on this client-side component and
 * customUi.dataContext is never set, leaving the UI dead with no log output.
 * Balance events are filtered with PlayerService.isLocalPlayer (NOT ===) because
 * deserialized NetworkEvent payloads have distinct Entity references for the same
 * logical player. The server delivers balances via sendGlobally — there is no
 * private owner-routed delivery with this API — so this isLocalPlayer filter is
 * what keeps each client showing only its OWN balance. Balances are world-visible
 * on the wire and display-filtered here (see broadcastBalance in SoftCurrencyService.ts).
 */
// The HUD is client-local — LocalOnly states that intent explicitly and matches
// the landed `implementing-daily-quests` popup component.
@component({networkedRequirement: NetworkMode.LocalOnly})
export class SoftCurrencyHUDComponent extends Component {
  private customUi: Maybe<CustomUiComponent> = null;
  private viewModel = new SoftCurrencyHUDViewModel();
  private balances: Map<string, SoftCurrencyPillViewModel> = new Map();
  private spendCounter = 0;
  // Per-mount prefix for requestId so a remounted HUD can't collide with a
  // committed dedupe key (see makeMountSeed).
  private readonly mountSeed: string = makeMountSeed();

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  private onStart(): void {
    const customUi = this.entity.getComponent(CustomUiComponent);
    if (!customUi) {
      console.error('[SoftCurrencyHUD] onStart requires a CustomUiComponent on this entity');
      return;
    }
    this.customUi = customUi;
    this.customUi.dataContext = this.viewModel;
    this.customUi.isVisible = true;
  }

  @subscribe(CurrencyBalanceEvent, {execution: ExecuteOn.Everywhere})
  private onBalance(payload: CurrencyBalancePayload): void {
    if (NetworkingService.get().isServerContext()) return;
    if (!payload.player || !PlayerService.get().isLocalPlayer(payload.player)) return;
    const pill = new SoftCurrencyPillViewModel();
    pill.Name = payload.displayName;
    pill.Balance = String(payload.balance);
    this.balances.set(payload.currencyId, pill);
    // Reassign a new array so the ItemsControl re-renders.
    this.viewModel.Pills = [...this.balances.values()];
  }

  /**
   * Demo-only spend. Sends a spend request for the local player. The server
   * validates the balance and deducts authoritatively, then broadcasts the new
   * balance back (which refreshes the pill above).
   *
   * Client -> server delivery uses `sendGlobally` (the untargeted client->server
   * request); the server `SoftCurrencyService` subscribes with `{execution:
   * ExecuteOn.Everywhere}` and filters `isServerContext()`. Do NOT switch to
   * `sendToOwner` targeting the service — a `@service()` is not entity-attached, so
   * the event never reaches it.
   */
  @subscribe(onSpendClicked, {execution: ExecuteOn.Owner})
  private onSpend(): void {
    const localPlayer = PlayerService.get().getLocalPlayer();
    if (!localPlayer) return;
    this.spendCounter += 1;
    // requestId = per-mount seed + per-click counter. The seed keeps it unique
    // across HUD reconstructions — the counter alone resets to 0 on remount and
    // would collide with an already-committed dedupe key. The server's dedupe key
    // is `${playerKey}:${currencyId}:${requestId}`. (Do NOT use `String(localPlayer)`
    // — an Entity stringifies to "[object Object]", meaningless and not unique.)
    const requestId = `${this.mountSeed}-${this.spendCounter}`;
    EventService.sendGlobally(
      SpendCurrencyRequestEvent,
      new SpendCurrencyRequestPayload(
        localPlayer,
        DEMO_SPEND_CURRENCY,
        DEMO_SPEND_AMOUNT,
        'demo_button',
        requestId,
      ),
    );
  }
}

//#endregion Component
