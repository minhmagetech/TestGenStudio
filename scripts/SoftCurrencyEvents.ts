/** AGENTS: DO NOT MODIFY THIS FILE — use copy_local_file to install verbatim */

import {
  NetworkEvent,
  property,
  serializable,
  type Entity,
  type Maybe,
} from 'meta/worlds';

/**
 * Shared event contract for the soft-currency wallet. Every event is keyed by
 * `currencyId` so one world can run several independent currencies at once.
 *
 * Security model — AUTHORITY (who may change a balance) and VISIBILITY (who may
 * observe one) are SEPARATE decisions, and the engine exposes NO authenticated
 * sender to handlers, so never trust a client-supplied payload for authority:
 * - AUTHORITY is server-only. There is intentionally NO client-acceptable "earn"
 *   event — currency is created only by server-side `SoftCurrencyService.grant()`,
 *   called from server-side gameplay relays (see game-integration.md). This closes
 *   client-side minting and mirrors the landed `implementing-daily-quests` pattern.
 * - `SpendCurrencyRequestEvent` is the one client -> server request. Because there
 *   is no authenticated sender, the spender is carried in the payload — which the
 *   client controls. The server MUST bind the spend to the REQUESTING client's own
 *   player (ownership context) and never let one client target another's wallet.
 *   VERIFY-IN-EDITOR: confirm how to resolve the true owner in your SDK build; if
 *   it cannot be resolved, do NOT ship a spoofable spend (see "Secure eventing" in
 *   implementing-soft-currency.md).
 * - VISIBILITY: there is NO private owner-routed delivery. Server -> client events
 *   use `EventService.sendGlobally(event, payload)` and the client filters by
 *   `isLocalPlayer`, so balances are world-visible on the wire (display-filtered).
 *   `sendToOwner`'s 3rd arg is an event TARGET (subscribers on that entity), NOT a
 *   per-player private router — and the HUD is a separate entity, so it never
 *   receives `sendToOwner(..., player)`. True per-player privacy needs a different
 *   architecture (a future item).
 */

// ============================================================================
// Client -> server: spend request
// ============================================================================

@serializable()
export class SpendCurrencyRequestPayload {
  @property() public readonly player: Maybe<Entity> = null;
  @property() public readonly currencyId: string = '';
  @property() public readonly amount: number = 0;
  @property() public readonly reason: string = '';
  // Required for idempotency: a repeat of the same requestId re-returns the
  // original result instead of charging twice (double-tap / network retry).
  @property() public readonly requestId: string = '';
  constructor(
    player: Maybe<Entity> = null,
    currencyId: string = '',
    amount: number = 0,
    reason: string = '',
    requestId: string = '',
  ) {
    this.player = player;
    this.currencyId = currencyId;
    this.amount = amount;
    this.reason = reason;
    this.requestId = requestId;
  }
}

export const SpendCurrencyRequestEvent = new NetworkEvent(
  'SoftCurrencySpendRequest',
  SpendCurrencyRequestPayload,
);

// ============================================================================
// Server -> owning client: authoritative balance (drives the HUD)
// ============================================================================

@serializable()
export class CurrencyBalancePayload {
  @property() public readonly player: Maybe<Entity> = null;
  @property() public readonly currencyId: string = '';
  @property() public readonly balance: number = 0;
  @property() public readonly displayName: string = '';
  constructor(
    player: Maybe<Entity> = null,
    currencyId: string = '',
    balance: number = 0,
    displayName: string = '',
  ) {
    this.player = player;
    this.currencyId = currencyId;
    this.balance = balance;
    this.displayName = displayName;
  }
}

export const CurrencyBalanceEvent = new NetworkEvent(
  'SoftCurrencyBalance',
  CurrencyBalancePayload,
);

// ============================================================================
// Server -> owning client: transaction results (player-facing receipts)
// ============================================================================

@serializable()
export class CurrencyResultPayload {
  @property() public readonly player: Maybe<Entity> = null;
  @property() public readonly currencyId: string = '';
  @property() public readonly amount: number = 0;
  @property() public readonly success: boolean = false;
  @property() public readonly balance: number = 0;
  // Empty on success; on failure one of: 'rate_limited' | 'cap_reached' |
  // 'insufficient' | 'invalid_amount' | 'invalid_currency' | 'persist_failed' |
  // 'missing_request_id'.
  @property() public readonly reason: string = '';
  constructor(
    player: Maybe<Entity> = null,
    currencyId: string = '',
    amount: number = 0,
    success: boolean = false,
    balance: number = 0,
    reason: string = '',
  ) {
    this.player = player;
    this.currencyId = currencyId;
    this.amount = amount;
    this.success = success;
    this.balance = balance;
    this.reason = reason;
  }
}

// Earn and spend share the same result shape; two event names keep them
// distinguishable for listeners that care about only one direction.
export const EarnCurrencyResultEvent = new NetworkEvent(
  'SoftCurrencyEarnResult',
  CurrencyResultPayload,
);

export const SpendCurrencyResultEvent = new NetworkEvent(
  'SoftCurrencySpendResult',
  CurrencyResultPayload,
);
