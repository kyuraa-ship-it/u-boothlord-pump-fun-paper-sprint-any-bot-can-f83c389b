// Young-coin sniper v1 for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Idea: most pump.fun coins die within minutes, but a small share runs up fast
// right after launch. This bot only buys coins in their first slots after the
// CreateEvent, and only when the opening tape looks clean: the creator has not
// sold, the creator's own opening buy is small, only a handful of other wallets
// bought in, the curve already holds real SOL, and the price has not run away
// yet. It takes profit fast (half at +15%, the rest at +40%), trails winners,
// cuts losers at -12%, and exits at once when the creator sells or after
// 120 slots. Paper trading only; a pure function of the batches it is fed:
// no clock, no randomness, no I/O.

import {
  BPS,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface SniperParams {
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to spend per coin. */
  stakeLamports: bigint;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: bigint;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: bigint;
  maxDevBuy: bigint;
  /** Distinct (non-creator) buyers seen before entry, at most. */
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: bigint;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: bigint;
  /** Price now over the create price, as bps: window. */
  minRunupBps: bigint;
  maxRunupBps: bigint;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** First take-profit: sell half the position once it is worth this much over its cost (bps). */
  tp1Bps: bigint;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: bigint;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: bigint;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: bigint;
  trailBps: bigint;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
}

export const DEFAULT_PARAMS: SniperParams = {
  maxAge: 3, // buy only in the first slots: the launch pop is where the edge is
  stakeLamports: 100_000_000n, // 0.10 SOL per coin
  minBuyLamports: 5_000_000n,
  minRealSol: 300_000_000n, // 0.3 SOL
  maxRealSol: 30_000_000_000n,
  minDevBuy: 0n,
  maxDevBuy: 2_500_000_000n, // 2.5 SOL
  maxBuyers: 3, // a launch bundled by many wallets is a dump in waiting
  maxSellRatioBps: 10_000n,
  maxBigSellBps: 10_000n,
  minRunupBps: 10_000n, // 1.00x
  maxRunupBps: 14_000n, // 1.40x
  skipDevSold: true,
  buySlippageBps: 500, // 10_000 bps tested worse (-1.29 vs -1.06 SOL): fills on the fastest runners cost more than they earn
  tp1Bps: 1_000_000n, // disabled: take the whole profit at tpBps instead of holding half for +40%
  tpBps: 2_000n, // +20% full exit (test)
  slBps: 1_200n, // -12%
  trailArmBps: 1_000_000n, // disabled: +15% exit already banks the move
  trailBps: 1_500n, // -15% from peak
  maxHold: 10, // exit fast: capital back for the next launch
  exitOnDevSell: true,
};

/** Curve fee on a sell: protocol 95 bps + creator 30 bps. */
const FEE_BPS = 125n;

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  lastTradeSlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  best: bigint;
  tookHalf: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createSniper(params: SniperParams = DEFAULT_PARAMS) {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          devSold: false,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          lastTradeSlot: e.slot,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.lastTradeSlot = e.slot;
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    readEvents(batch);
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();

    // Harness closes (complete / flatten / writeoff) drop the tracking entry.
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) held.delete(f.mint);
    }
    // Drop tracking for positions that are gone with nothing in flight.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !hasPending(state, mint, 'buy') && !hasPending(state, mint, 'sell')) {
        held.delete(mint);
      }
    }

    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) {
      marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
    }
    const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint } | undefined => {
      const mk = marks.get(mint);
      if (mk !== undefined) return mk;
      const cv = state.curves.get(mint);
      if (cv === undefined) return undefined;
      return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
    };

    // Exits first: take profit, cut losses, trail winners, react to the creator.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (hasPending(state, mint, 'sell')) continue;
      const c = coins.get(mint);
      let h = held.get(mint);
      if (h === undefined) {
        h = { openedSlot: state.slot, best: 0n, tookHalf: false };
        held.set(mint, h);
      }
      const mk = reservesOf(mint);
      if (mk === undefined) continue;
      const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
      const basis = pos.cost_lamports;
      if (basis <= 0n) continue;
      if (value > h.best) h.best = value;

      // First take-profit: sell half at +15%.
      if (!h.tookHalf && value * BPS >= basis * (BPS + P.tp1Bps)) {
        const half = pos.token_amount / 2n;
        if (half > 0n && half < pos.token_amount) {
          orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
          h.tookHalf = true;
          h.best = 0n;
          continue;
        }
      }

      let exit = false;
      if (value * BPS >= basis * (BPS + P.tpBps)) exit = true; // take-profit exit
      if (value * BPS <= basis * (BPS - P.slBps)) exit = true; // -12% stop loss
      if (h.best * BPS >= basis * (BPS + P.trailArmBps) && value * BPS <= h.best * (BPS - P.trailBps)) exit = true;
      if (state.slot - h.openedSlot >= P.maxHold) exit = true;
      if (c !== undefined && P.exitOnDevSell && c.devSold) exit = true;
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (c !== undefined) c.done = true;
    }

    // Entries: young coins whose opening tape looks clean.
    let free = state.freeCashLamports();
    let open = state.committedPositionCount();
    for (const c of coins.values()) {
      if (orders.length >= cap) break;
      if (c.done || c.complete) continue;
      const age = state.slot - c.createSlot;
      if (age > P.maxAge) {
        c.done = true;
        continue;
      }
      if (open >= state.hello.caps.max_open_positions) continue;
      if (hasPending(state, c.mint, 'buy')) continue;
      const curve = state.curves.get(c.mint);
      if (curve === undefined || curve.complete) continue;
      if (c.devSold && P.skipDevSold) {
        c.done = true;
        continue;
      }
      const rq = curve.real_quote_reserves;
      if (rq < P.minRealSol || rq > P.maxRealSol) continue;
      if (c.devBuy < P.minDevBuy || c.devBuy > P.maxDevBuy) continue;
      if (c.buyers.size > P.maxBuyers) continue;
      if (c.bought > 0n && c.soldByOthers * BPS > c.bought * P.maxSellRatioBps) continue;
      if (c.bigSellBps > P.maxBigSellBps) continue;
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      if (vt <= 0n || c.vq0 <= 0n || c.vt0 <= 0n) continue;
      const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
      if (runup < P.minRunupBps || runup > P.maxRunupBps) continue;
      const maxBuy = state.maxBuyLamports(c.mint);
      const amount = P.stakeLamports < maxBuy ? P.stakeLamports : maxBuy;
      if (amount < P.minBuyLamports) continue;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
      free -= amount + tx;
      open += 1;
    }
    return orders;
  }

  return { onBatch };
}
