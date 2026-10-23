/** AGENTS: Copy verbatim via copy_local_file. The ONLY intended edit is FALLBACK_SETTINGS below — set one entry per currency (see its AGENTS marker). */

import {
  EventService,
  ExecuteOn,
  NetworkingService,
  OnPlayerCreateEvent,
  type OnPlayerCreateEventPayload,
  OnPlayerDestroyEvent,
  type OnPlayerDestroyEventPayload,
  PlayerVariablesService,
  Service,
  service,
  subscribe,
  type Entity,
} from 'meta/worlds';

// The wallet's currency registry comes from FALLBACK_SETTINGS. Runtime world-config
// tuning is a deferred enhancement (e.g. WorldService.getConfigValue, as the landed
// implementing-daily-quests skill uses).

import {
  CurrencyBalanceEvent,
  CurrencyBalancePayload,
  CurrencyResultPayload,
  EarnCurrencyResultEvent,
  SpendCurrencyRequestEvent,
  type SpendCurrencyRequestPayload,
  SpendCurrencyResultEvent,
} from './SoftCurrencyEvents';

type CurrencyDef = {
  id: string;
  displayName: string;
  startingBalance: number;
  maxBalance: number;
};

/** *** AGENTS: define your currencies here — one entry per currency (id == pvar name). This is the registry; there is no separate world config. *** */
const FALLBACK_SETTINGS: {currencies: CurrencyDef[]} = {
  currencies: [
    {id: 'diamonds', displayName: 'Diamonds', startingBalance: 0, maxBalance: 1_000_000_000},
  ],
};

/** Result of every balance mutation. Callers MUST check `success`. */
export type TxResult = {success: boolean; balance: number; error?: string};

/** A completed spend retained for idempotent replay: original result + amount. */
type SpendRecord = {result: TxResult; amount: number};

const PERSIST_MAX_RETRIES = 3;

// Max committed-spend dedupe records retained per player. Generous: retries fire
// within seconds, so an evicted oldest record can no longer be replayed. Bounds
// spendDedupe growth across a long session (entries are also purged on leave).
// No global ceiling: a player whose OnPlayerDestroyEvent never fires leaves an
// orphan bucket (capped at this size), reclaimed on world restart.
const MAX_SPEND_DEDUPE_PER_PLAYER = 64;

/**
 * Server-mediated soft-currency wallet — server-authoritative earn and balances;
 * the client spend request trusts the sender's player (a trusted-client demo, see
 * `onSpendRequest`). One NUMBER pvar per currency
 * (pvar name == currency id), so one world can run several independent
 * currencies and reward sources that grant the same id share one balance.
 *
 * Authority & trust (full security model in SoftCurrencyEvents.ts):
 * - `grant`/`trySpend` are the ONLY ways currency changes, and they only run on
 *   the server (`isServerContext()` guard). Earn has no client path at all —
 *   server-side gameplay relays call `grant()` (see game-integration.md). Spend is
 *   the one client request; the spender MUST be the requesting client's own player
 *   (the engine has no authenticated sender — see `onSpendRequest`).
 * - Every mutation runs inside a per-(player, currency) async lock so concurrent
 *   earn/spend cannot lose updates. The in-memory `balances` map is the SOURCE OF
 *   TRUTH; the pvar (`PlayerVariablesService`) is persistence only. WHY: pvar
 *   read-after-write is NOT immediately consistent in the MHS build — reading a
 *   balance back from the pvar right after writing it can return a STALE value, so
 *   a concurrent grant would read the pre-spend balance and OVERWRITE the spend (a
 *   lost update; reproduced in 2-player testing). So each balance is loaded from the
 *   pvar once on first access, then all read/modify/write happens on the in-memory
 *   value under the lock, writing THROUGH to the pvar for durability (persist-first
 *   ordering — see grant/trySpend).
 * - VISIBILITY is separate from authority. There is NO private owner-routed
 *   delivery: server -> client uses `sendGlobally(...)` and the HUD filters by
 *   `isLocalPlayer`, so balances are world-visible on the wire (display-filtered).
 *   `sendToOwner`'s 3rd arg is an event TARGET, not a per-player router — see
 *   `broadcastBalance`.
 */
@service()
export class SoftCurrencyService extends Service {
  private registry: Map<string, CurrencyDef> = new Map();
  // Cached in-flight registry load so concurrent callers await the SAME load. A
  // boolean flag set before the await would let a second caller race ahead and
  // read an empty registry (invalid_currency on a real currency).
  private registryPromise: Promise<void> | null = null;

  // Per-key promise chains serialize read->validate->write->broadcast.
  private locks: Map<string, Promise<unknown>> = new Map();
  // Session-scoped spend idempotency: dedupeKey -> the original spend's result AND
  // amount, so a replay re-sends the ORIGINAL receipt (never the retry's amount).
  // Bounded per player (MAX_SPEND_DEDUPE_PER_PLAYER) so a long session can't grow
  // it without limit; also fully purged for a player on leave.
  private spendDedupe: Map<string, SpendRecord> = new Map();
  // Authoritative in-memory balance, keyed by lockKey (`playerKey:currencyId`).
  // SOURCE OF TRUTH for every read (see `read`); the pvar is persistence only,
  // loaded once on first access. This is what fixes the stale-read lost update
  // (pvar read-after-write is not immediately consistent in this build). Purged
  // per player on leave so a rejoin reloads fresh from the durable pvar value.
  private balances: Map<string, number> = new Map();

  // --------------------------------------------------------------------------
  // Public server-side API (the ONLY way currency changes)
  // --------------------------------------------------------------------------

  /** Credit `amount` of `currencyId` to `player`. Server-only. */
  public async grant(
    player: Entity,
    currencyId: string,
    amount: number,
    reason: string = 'grant',
  ): Promise<TxResult> {
    if (!this.isServer()) {
      console.error('[SoftCurrency] grant() can only be called on the server');
      return {success: false, balance: 0, error: 'forbidden'};
    }
    if (!this.hasPlayerId(player)) {
      return this.finishEarn(player, currencyId, amount, false, 0, 'no_player_id');
    }
    await this.ensureRegistry();
    const def = this.registry.get(currencyId);
    if (!def) {
      return this.finishEarn(player, currencyId, amount, false, 0, 'invalid_currency');
    }
    if (!isPositiveInt(amount)) {
      return this.finishEarn(player, currencyId, amount, false, await this.read(player, def), 'invalid_amount');
    }
    return this.withLock(this.lockKey(player, currencyId), async () => {
      const bal = await this.read(player, def);
      const next = bal + amount;
      if (next > def.maxBalance || next > Number.MAX_SAFE_INTEGER) {
        return this.finishEarn(player, def.id, amount, false, bal, 'cap_reached');
      }
      // Persist-first: write the pvar, THEN commit the new value in
      // memory. On a durable persist failure, ABORT — leave the in-memory balance
      // untouched (== bal) so pvar and memory never disagree (see the spend note
      // below for the full rationale).
      const persisted = await this.persist(player, def.id, next);
      if (!persisted) {
        return this.finishEarn(player, def.id, amount, false, bal, 'persist_failed');
      }
      this.balances.set(this.lockKey(player, def.id), next);
      this.audit('earn', def.id, amount, next, reason);
      this.broadcastBalance(player, def, next);
      return this.finishEarn(player, def.id, amount, true, next, '');
    });
  }

  /** Debit `amount` of `currencyId` from `player` if affordable. Server-only. */
  public async trySpend(
    player: Entity,
    currencyId: string,
    amount: number,
    reason: string = 'spend',
    requestId: string = '',
  ): Promise<TxResult> {
    if (!this.isServer()) {
      console.error('[SoftCurrency] trySpend() can only be called on the server');
      return {success: false, balance: 0, error: 'forbidden'};
    }
    if (!this.hasPlayerId(player)) {
      return this.finishSpend(player, currencyId, amount, false, 0, 'no_player_id');
    }
    await this.ensureRegistry();
    const def = this.registry.get(currencyId);
    if (!def) {
      return this.finishSpend(player, currencyId, amount, false, 0, 'invalid_currency');
    }
    if (!isPositiveInt(amount)) {
      return this.finishSpend(player, def.id, amount, false, await this.read(player, def), 'invalid_amount');
    }
    // requestId is REQUIRED: an empty one would silently disable idempotency and
    // let a double-tap / network retry charge twice. Callers must pass a unique id.
    if (requestId === '') {
      return this.finishSpend(player, def.id, amount, false, await this.read(player, def), 'missing_request_id');
    }
    const dedupeKey = `${this.lockKey(player, currencyId)}:${requestId}`;
    if (this.spendDedupe.has(dedupeKey)) {
      return this.replaySpend(player, def, dedupeKey);
    }
    return this.withLock(this.lockKey(player, currencyId), async () => {
      // Re-check inside the lock: a duplicate may have committed while we waited.
      if (this.spendDedupe.has(dedupeKey)) {
        return this.replaySpend(player, def, dedupeKey);
      }
      const bal = await this.read(player, def);
      if (bal < amount) {
        // Do NOT dedupe a failed spend: nothing was charged, and the SAME requestId
        // may legitimately succeed later once the player has earned more. Caching
        // 'insufficient' would wrongly replay it forever.
        return this.finishSpend(player, def.id, amount, false, bal, 'insufficient');
      }
      const next = bal - amount;
      // Persist-first: write the pvar BEFORE committing in memory or
      // deduping. On a durable persist failure, ABORT — in-memory stays at `bal`,
      // nothing is deduped, and we return `persist_failed` so the client can retry.
      // WHY fail closed: this wallet underpins a Store that grants an item when the
      // spend reports success; reporting success without a durable write would let a
      // crash refund the spend AFTER the item shipped (a dupe). Reads come from the
      // in-memory map, so this still avoids the pvar stale-read lost update.
      const persisted = await this.persist(player, def.id, next);
      if (!persisted) {
        return this.finishSpend(player, def.id, amount, false, bal, 'persist_failed');
      }
      this.balances.set(this.lockKey(player, def.id), next);
      this.audit('spend', def.id, amount, next, reason);
      this.broadcastBalance(player, def, next);
      const r = this.finishSpend(player, def.id, amount, true, next, '');
      // Dedupe ONLY the committed (successful) spend — the one a retry must not
      // repeat. Store the original amount so a replay receipt is accurate.
      this.spendDedupe.set(dedupeKey, {result: r, amount});
      this.capSpendDedupe(this.playerKey(player));
      return r;
    });
  }

  /** Current balance of one currency (server-only). */
  public async getBalance(player: Entity, currencyId: string): Promise<number> {
    if (!this.isServer()) return 0;
    if (!this.hasPlayerId(player)) return 0;
    await this.ensureRegistry();
    const def = this.registry.get(currencyId);
    return def ? this.read(player, def) : 0;
  }

  /**
   * Per-currency balances (server-only). NOT a single atomic snapshot: each
   * currency is read individually and unlocked, so a concurrent grant/spend may
   * land between two currency reads. Each value is individually consistent; do not
   * rely on cross-currency atomicity here.
   */
  public async getAllBalances(player: Entity): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    if (!this.isServer()) return out;
    if (!this.hasPlayerId(player)) return out;
    await this.ensureRegistry();
    for (const def of this.registry.values()) {
      out[def.id] = await this.read(player, def);
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Player lifecycle
  // --------------------------------------------------------------------------

  @subscribe(OnPlayerCreateEvent, {execution: ExecuteOn.Everywhere})
  private async onPlayerJoin(payload: OnPlayerCreateEventPayload): Promise<void> {
    if (!this.isServer()) return;
    const player = payload.entity;
    if (!player) return;
    if (!this.hasPlayerId(player)) {
      console.error('[SoftCurrency] onPlayerJoin: no stable player id — skipping');
      return;
    }
    await this.ensureRegistry();
    for (const def of this.registry.values()) {
      try {
        const bal = await this.read(player, def);
        this.broadcastBalance(player, def, bal);
      } catch (err: unknown) {
        console.error(`[SoftCurrency] failed to load '${def.id}' on join: ${String(err)}`);
      }
    }
  }

  @subscribe(OnPlayerDestroyEvent, {execution: ExecuteOn.Everywhere})
  private onPlayerLeave(payload: OnPlayerDestroyEventPayload): void {
    if (!this.isServer()) return;
    const player = payload.entity;
    if (!player) return;
    if (!this.hasPlayerId(player)) return;
    const prefix = `${this.playerKey(player)}:`;
    // Dedupe entries are session-scoped and safe to drop immediately on leave.
    for (const k of [...this.spendDedupe.keys()]) {
      if (k.startsWith(prefix)) this.spendDedupe.delete(k);
    }
    // Drop the in-memory balances too, so a rejoining player reloads fresh from the
    // pvar (the durable value) instead of seeing this session's cached number. A
    // grant/spend still in persist() may re-insert a key after this purge; the
    // re-inserted value == the durable pvar (write-through), so it's benign and is
    // reclaimed on the next leave.
    for (const k of [...this.balances.keys()]) {
      if (k.startsWith(prefix)) this.balances.delete(k);
    }
    // Lock entries: evict only AFTER any in-flight op on that key settles, and only
    // if a newer op hasn't replaced it. Deleting a pending chain would let a
    // late/rejoin op on the same key start a fresh chain that doesn't await the
    // in-flight one, breaking the per-key serialization invariant.
    for (const k of [...this.locks.keys()]) {
      if (!k.startsWith(prefix)) continue;
      const tail = this.locks.get(k);
      if (!tail) continue;
      const evict = () => {
        if (this.locks.get(k) === tail) this.locks.delete(k);
      };
      void tail.then(evict, evict);
    }
  }

  // --------------------------------------------------------------------------
  // Client -> server spend request
  // --------------------------------------------------------------------------

  /**
   * Client -> server spend request.
   *
   * SECURITY — KNOWN, ACCEPTED DEMO LIMITATION: the engine exposes no authenticated
   * sender, so `payload.player` is CLIENT-CONTROLLED — a modified client can spend
   * ANOTHER player's wallet. This bundled spend path is a TRUSTED-CLIENT DEMO (the
   * same posture as shop-system and other MHS skills); earn and balances stay
   * server-authoritative, only this spend's *identity* is trusted. Before a
   * production economy you MUST bind the spend to the REQUESTING client's own player
   * via ownership context, or gate it (see "Secure eventing" in
   * implementing-soft-currency.md). Do not treat spend as tamper-resistant until then.
   */
  @subscribe(SpendCurrencyRequestEvent, {execution: ExecuteOn.Everywhere})
  private async onSpendRequest(payload: SpendCurrencyRequestPayload): Promise<void> {
    if (!this.isServer()) return;
    if (!payload.player) return;
    // trySpend sends the SpendCurrencyResultEvent + balance to the owner itself.
    await this.trySpend(
      payload.player,
      payload.currencyId,
      payload.amount,
      payload.reason !== '' ? payload.reason : 'spend',
      payload.requestId,
    );
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private isServer(): boolean {
    return NetworkingService.get().isServerContext();
  }

  /** True only if the engine gives us a usable stable id for this player. */
  private hasPlayerId(player: Entity): boolean {
    const id = (player as unknown as {id?: string | number | bigint}).id;
    return id !== undefined && id !== null;
  }

  /**
   * Stable per-player key for the lock/dedupe/balance maps. Deserialized NetworkEvent
   * Entity refs are not === across events, so key by the entity's stable id. Callers
   * MUST gate on `hasPlayerId()` first — a missing id must never reach here (it would
   * collapse every player onto one key); that fail-closed check is the safety net.
   * VERIFY-IN-EDITOR: `entity.id` is NOT on the public Entity type — confirm it
   * resolves to a defined, distinct, stable value per player (2-player probe), then
   * drop the cast. (Do NOT substitute `toString()`: an Entity stringifies to
   * "[object Object]", which would re-collapse all players onto one key.)
   */
  private playerKey(player: Entity): string {
    return String((player as unknown as {id?: string | number | bigint}).id);
  }

  private lockKey(player: Entity, currencyId: string): string {
    return `${this.playerKey(player)}:${currencyId}`;
  }

  /**
   * Bound this player's retained dedupe records to MAX_SPEND_DEDUPE_PER_PLAYER,
   * evicting the oldest first. Map preserves insertion order, so the earliest
   * matching keys are the oldest committed spends — safe to drop (a retry of a
   * spend that old is not a realistic double-charge). The `playerKey:` prefix
   * (note the trailing colon) matches only this player's entries, never another's.
   */
  private capSpendDedupe(playerKey: string): void {
    const prefix = `${playerKey}:`;
    const keys: string[] = [];
    for (const k of this.spendDedupe.keys()) {
      if (k.startsWith(prefix)) keys.push(k);
    }
    for (let i = 0; i < keys.length - MAX_SPEND_DEDUPE_PER_PLAYER; i++) {
      this.spendDedupe.delete(keys[i]);
    }
  }

  /**
   * Current balance, from the in-memory `balances` map (the source of truth).
   * Loads from the pvar exactly ONCE per (player, currency) on first access, then
   * caches; every later read is in-memory and never touches the pvar again. WHY:
   * the pvar's read-after-write is not immediately consistent in this build, so
   * reading it back after a write can return a stale value and cause a lost update
   * (a grant overwriting a just-committed spend). An unset pvar (never written)
   * loads as the configured starting balance.
   */
  private async read(player: Entity, def: CurrencyDef): Promise<number> {
    const key = this.lockKey(player, def.id);
    const cached = this.balances.get(key);
    if (cached !== undefined) return cached;
    const v = await PlayerVariablesService.get().fetchVariable<number>(player, def.id);
    // A grant/spend may have committed this key while the fetch was in flight —
    // honor that value instead of overwriting it with a possibly-stale pvar read.
    const committed = this.balances.get(key);
    if (committed !== undefined) return committed;
    const bal = typeof v === 'number' && Number.isFinite(v) ? v : def.startingBalance;
    this.balances.set(key, bal);
    return bal;
  }

  /**
   * Write-through persist with bounded backoff on backend rate-limit/rejection.
   * Deliberately awaited INSIDE the per-key lock to preserve persist-first ordering
   * (commit in memory only after a durable write); under sustained backend stalls
   * this serializes same-key ops for the ~350ms retry tail — an accepted tradeoff.
   */
  private async persist(player: Entity, name: string, value: number): Promise<boolean> {
    for (let attempt = 0; attempt <= PERSIST_MAX_RETRIES; attempt++) {
      try {
        await PlayerVariablesService.get().setVariable(player, name, value);
        return true;
      } catch (err: unknown) {
        if (attempt === PERSIST_MAX_RETRIES) {
          console.warn(`[SoftCurrency] setVariable('${name}') failed after ${String(attempt)} retries: ${String(err)}`);
          return false;
        }
        await delay(50 * Math.pow(2, attempt));
      }
    }
    return false;
  }

  private broadcastBalance(player: Entity, def: CurrencyDef, balance: number): void {
    // sendGlobally broadcasts to ALL subscribers; the HUD filters by isLocalPlayer
    // so only the owning client's HUD reacts. sendToOwner's 3rd arg targets
    // subscribers ON that entity — the HUD is a SEPARATE scene entity, so
    // sendToOwner(..., player) never reaches it. Balances are therefore world-visible
    // on the wire (true per-player privacy needs a different architecture — see
    // "Secure eventing" in implementing-soft-currency.md).
    EventService.sendGlobally(
      CurrencyBalanceEvent,
      new CurrencyBalancePayload(player, def.id, balance, def.displayName),
    );
  }

  private finishEarn(
    player: Entity,
    currencyId: string,
    amount: number,
    success: boolean,
    balance: number,
    reason: string,
  ): TxResult {
    // EarnCurrencyResultEvent is the player-facing earn receipt (success flag +
    // failure reason). The bundled HUD consumes only CurrencyBalanceEvent; this
    // receipt is an extension point for a Store / toast UI that wants per-transaction
    // feedback — especially failures like cap_reached, which emit NO balance update.
    // NOTE: on success this is a 2nd global event alongside broadcastBalance (by
    // design — it also carries failures); gate it to failures or drop it if unused.
    EventService.sendGlobally(
      EarnCurrencyResultEvent,
      new CurrencyResultPayload(player, currencyId, amount, success, balance, reason),
    );
    return {success, balance, error: success ? undefined : reason};
  }

  private finishSpend(
    player: Entity,
    currencyId: string,
    amount: number,
    success: boolean,
    balance: number,
    reason: string,
  ): TxResult {
    EventService.sendGlobally(
      SpendCurrencyResultEvent,
      new CurrencyResultPayload(player, currencyId, amount, success, balance, reason),
    );
    return {success, balance, error: success ? undefined : reason};
  }

  private replaySpend(player: Entity, def: CurrencyDef, dedupeKey: string): TxResult {
    const prior = this.spendDedupe.get(dedupeKey) as SpendRecord;
    // Re-send the ORIGINAL receipt (original amount + result) so a retrying client
    // gets the same answer and is never charged twice.
    EventService.sendGlobally(
      SpendCurrencyResultEvent,
      new CurrencyResultPayload(
        player, def.id, prior.amount, prior.result.success, prior.result.balance, prior.result.error ?? '',
      ),
    );
    return prior.result;
  }

  /**
   * Audit trail. console.log is used because `InWorldAnalyticsService` rejects
   * event names not allowlisted in its native implementation; promoting to
   * structured analytics is a native-allowlist follow-up (plan §12).
   */
  private audit(kind: string, currencyId: string, amount: number, newBalance: number, reason: string): void {
    console.log(
      `[SoftCurrency][audit] ${kind} currency=${currencyId} amount=${String(amount)} newBalance=${String(newBalance)} reason=${reason}`,
    );
  }

  /**
   * Load the currency registry exactly once. Returns a cached in-flight promise so
   * concurrent callers all await the SAME load (no empty-registry race). The
   * registry is built from FALLBACK_SETTINGS — runtime world-config tuning is a
   * deferred enhancement (see loadRegistry).
   */
  private ensureRegistry(): Promise<void> {
    if (!this.registryPromise) {
      this.registryPromise = this.loadRegistry();
    }
    return this.registryPromise;
  }

  private async loadRegistry(): Promise<void> {
    // Registry is driven by FALLBACK_SETTINGS today; runtime world-config tuning
    // (e.g. WorldService.getConfigValue, as implementing-daily-quests uses) is a
    // deferred enhancement. Add currencies in FALLBACK_SETTINGS.
    this.buildRegistry(FALLBACK_SETTINGS.currencies);
  }

  /** Validate each currency entry; malformed entries are skipped (not fatal). */
  private buildRegistry(entries: unknown[]): void {
    this.registry.clear();
    for (const entry of entries) {
      if (entry == null || typeof entry !== 'object') continue;
      const e = entry as Partial<CurrencyDef>;
      const id = e.id;
      const displayName = e.displayName;
      const startingBalance = e.startingBalance ?? 0;
      const maxBalance = e.maxBalance ?? Number.MAX_SAFE_INTEGER;
      if (
        typeof id !== 'string' || id === '' ||
        typeof displayName !== 'string' || displayName === '' ||
        !isNonNegativeInt(startingBalance) ||
        !isPositiveInt(maxBalance) ||
        startingBalance > maxBalance
      ) {
        console.warn(`[SoftCurrency] skipping malformed currency entry: ${JSON.stringify(entry)}`);
        continue;
      }
      this.registry.set(id, {id, displayName, startingBalance, maxBalance});
    }
    if (this.registry.size === 0) {
      console.warn('[SoftCurrency] no valid currencies configured — wallet is inert');
    }
  }

  /**
   * Per-(player, currency) serializer. Each op awaits the prior op on the same
   * key; the stored tail never rejects, so one failing op cannot poison or
   * deadlock later ops on that key. Different keys run in parallel.
   */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const result = prev.then(() => fn());
    this.locks.set(key, result.then(() => {}, () => {}));
    return result;
  }
}

function isPositiveInt(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER;
}

function isNonNegativeInt(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
