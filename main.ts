// Pump.fun Bot Sprint: Make Bot And Win — momentum bot for pumpfun-replay/v2.
//
// Strategy: buy young coins only after momentum is confirmed (price up from
// creation plus buy-dominated flow), then exit fast on a take-profit, a stop,
// a trailing pullback, a dump in flow, or age. Everything is deterministic:
// no wall clock, no unseeded randomness, no network. Decisions come only from
// the hello seed, the batch slot, the marks, and the events in each batch.
//
// The harness speaks NDJSON on stdin/stdout; the vendored SDK (vendor/) owns
// that protocol. This file only decides orders via runBot's onBatch hook.

import {
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from "./vendor/makefun-bot.ts";

// ---- tunables (lamports; 1 SOL = 1_000_000_000) ---------------------------
const BUY_TARGET = 300_000_000n; // 0.30 SOL per entry, before caps
const MIN_BUY = 30_000_000n; // 0.03 SOL: smallest buy worth its fees
const MAX_SLIPPAGE_BPS = 300; // 3%: fills lag 2 slots, prices move fast
const MAX_AGE_SLOTS = 6_000; // only coins created within ~21 min
const FLOW_WINDOW_SLOTS = 3_000; // trailing flow window (~11 min)
const MOMENTUM_WINDOW_SLOTS = 1_000; // recent-rise window (~4 min)
const MIN_RISE_FROM_CREATION_BPS = 300; // +3% from creation price
const MIN_RECENT_RISE_BPS = 100; // +1% over the momentum window
const MIN_BUY_FLOW_SOL = 500_000_000n; // 0.5 SOL of buys in the window
const BUY_DOMINANCE_NUM = 3; // buys >= 1.5x sells in the window
const BUY_DOMINANCE_DEN = 2;
const TAKE_PROFIT_BPS = 1_200; // +12% on cost basis
const STOP_LOSS_BPS = 800; // -8% on cost basis
const TRAILING_DROP_BPS = 500; // -5% from the peak value
const TRAILING_ARM_BPS = 500; // arm the trailing exit only once +5% up
const MAX_HOLD_SLOTS = 12_000; // time exit (~43 min after entry)
const EXIT_COOLDOWN_SLOTS = 5_000; // do not re-buy a mint just exited
const DUMP_SELL_NUM = 2; // sells >= 2x buys in the short window -> dump
const DUMP_WINDOW_SLOTS = 1_500;

// ---- per-mint tracking -----------------------------------------------------
interface PricePoint {
  slot: number;
  n: bigint; // virtual quote reserves (price numerator)
  d: bigint; // virtual token reserves (price denominator)
}
interface FlowPoint {
  slot: number;
  buy: bigint; // buy SOL in this batch
  sell: bigint; // sell SOL in this batch
}
interface MintTrack {
  createdSlot: number;
  first: PricePoint | null; // price at creation / first sight
  last: PricePoint | null; // latest price seen
  hist: PricePoint[]; // sampled prices, pruned to the recent window
  flow: FlowPoint[]; // per-batch flow, pruned to the flow window
  peakValue: bigint; // peak position value (lamports) since entry
  entrySlot: number; // slot the position was first seen held
  exitedSlot: number; // slot of the last exit, for the re-buy cooldown
  seen: boolean;
}

const tracks = new Map<string, MintTrack>();

function trackFor(mint: string): MintTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      createdSlot: -1,
      first: null,
      last: null,
      hist: [],
      flow: [],
      peakValue: 0n,
      entrySlot: -1,
      exitedSlot: -1,
      seen: false,
    };
    tracks.set(mint, t);
  }
  return t;
}

// Price ratio helpers on (numerator, denominator) pairs, all integer math.
function priceGe(aN: bigint, aD: bigint, bN: bigint, bD: bigint): boolean {
  return aN * bD >= bN * aD;
}
// Rise of price a over price b in bps: (a/b - 1) * 10000, floored at 0.
function riseBps(aN: bigint, aD: bigint, bN: bigint, bD: bigint): bigint {
  if (bN <= 0n || aD <= 0n || bD <= 0n) return 0n;
  const r = (aN * bD * 10_000n) / (bN * aD) - 10_000n;
  return r > 0n ? r : 0n;
}
function dropBps(aN: bigint, aD: bigint, bN: bigint, bD: bigint): bigint {
  if (bN <= 0n || aD <= 0n || bD <= 0n) return 0n;
  const r = 10_000n - (aN * bD * 10_000n) / (bN * aD);
  return r > 0n ? r : 0n;
}

function notePrice(t: MintTrack, slot: number, n: bigint, d: bigint): void {
  if (n <= 0n || d <= 0n) return;
  const p: PricePoint = { slot, n, d };
  if (t.first === null) t.first = p;
  t.last = p;
  // Keep one sample per distinct slot at most.
  const h = t.hist;
  if (h.length === 0 || h[h.length - 1].slot !== slot) h.push(p);
  // Prune anything older than the longest window we consult.
  const floor = slot - (MAX_HOLD_SLOTS + FLOW_WINDOW_SLOTS);
  while (h.length > 0 && h[0].slot < floor) h.shift();
}

function priceAtOrBefore(t: MintTrack, slot: number): PricePoint | null {
  let best: PricePoint | null = null;
  for (const p of t.hist) {
    if (p.slot <= slot) best = p;
    else break;
  }
  return best;
}

function flowInWindow(
  t: MintTrack,
  slot: number,
  windowSlots: number,
): { buy: bigint; sell: bigint } {
  let buy = 0n;
  let sell = 0n;
  const floor = slot - windowSlots;
  for (const f of t.flow) {
    if (f.slot >= floor) {
      buy += f.buy;
      sell += f.sell;
    }
  }
  return { buy, sell };
}

function pruneFlow(t: MintTrack, slot: number): void {
  const floor = slot - FLOW_WINDOW_SLOTS;
  while (t.flow.length > 0 && t.flow[0].slot < floor) t.flow.shift();
}

// ---- batch handling --------------------------------------------------------
function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const slot = batch.slot;
  const orders: OrderInput[] = [];
  const touched = new Set<string>();

  // Ingest this batch's events: creation prices and per-batch trade flow.
  for (const e of batch.events) {
    const t = trackFor(e.mint);
    touched.add(e.mint);
    if (e.event === "CreateEvent") {
      if (t.createdSlot < 0) t.createdSlot = e.slot;
      notePrice(t, e.slot, BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves));
    } else if (e.event === "TradeEvent") {
      if (t.createdSlot < 0) t.createdSlot = e.slot;
      notePrice(t, e.slot, BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves));
      const f = t.flow;
      const sol = BigInt(e.sol_amount);
      if (f.length > 0 && f[f.length - 1].slot === slot) {
        if (e.is_buy) f[f.length - 1].buy += sol;
        else f[f.length - 1].sell += sol;
      } else {
        f.push({ slot, buy: e.is_buy ? sol : 0n, sell: e.is_buy ? 0n : sol });
      }
    }
    // CompleteEvent: no price, the curve is done; exits below handle it.
  }

  // Ingest marks: the freshest reserves for mints that moved.
  for (const m of batch.marks) {
    const t = trackFor(m.mint);
    touched.add(m.mint);
    notePrice(t, m.slot, BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves));
  }
  for (const mint of touched) pruneFlow(trackFor(mint), slot);

  // ---- exits: check every open position first -----------------------------
  const held = new Set<string>();
  for (const pos of state.positions) {
    const mint = pos.mint;
    held.add(mint);
    const t = trackFor(mint);
    const curve = state.curves.get(mint);
    const tokens = BigInt(pos.token_amount);
    const cost = BigInt(pos.cost_lamports);
    if (tokens <= 0n || cost <= 0n) continue;
    if (t.entrySlot < 0) t.entrySlot = slot;
    if (curve === undefined) continue;
    // Current value of the position at the latest mark, in lamports.
    const value =
      (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
    if (value > t.peakValue) t.peakValue = value;
    const gainBps = riseBps(value, 1n, cost, 1n);
    const lossBps = dropBps(value, 1n, cost, 1n);
    const peakDropBps =
      t.peakValue > 0n ? dropBps(value, 1n, t.peakValue, 1n) : 0n;
    const flow = flowInWindow(t, slot, DUMP_WINDOW_SLOTS);
    const dumping =
      flow.sell >= DUMP_SELL_NUM * flow.buy && flow.sell > 0n && gainBps < 200n;
    const done = curve.complete === true;
    const tooOld = slot - t.entrySlot > MAX_HOLD_SLOTS;
    if (
      gainBps >= TAKE_PROFIT_BPS ||
      lossBps >= STOP_LOSS_BPS ||
      (gainBps >= TRAILING_ARM_BPS && peakDropBps >= TRAILING_DROP_BPS) ||
      dumping ||
      done ||
      tooOld
    ) {
      const sell: SellInput = {
        side: "sell",
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(sell);
      t.exitedSlot = slot;
      t.peakValue = 0n;
      t.entrySlot = -1;
    }
  }

  // ---- entries: momentum-confirmed young coins only ------------------------
  const maxPos = state.hello.caps.max_open_positions;
  const open = state.committedPositionCount();
  const room = maxPos - open;
  if (room > 0) {
    const pendingBuys = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === "buy") pendingBuys.add(p.order.mint);
    }
    const freeCash = state.freeCashLamports();
    interface Candidate {
      mint: string;
      score: bigint;
      size: bigint;
    }
    const candidates: Candidate[] = [];
    for (const mint of touched) {
      if (held.has(mint) || pendingBuys.has(mint)) continue;
      const t = trackFor(mint);
      if (t.createdSlot < 0 || t.first === null || t.last === null) continue;
      const age = slot - t.createdSlot;
      if (age < 0 || age > MAX_AGE_SLOTS) continue;
      if (slot - t.exitedSlot < EXIT_COOLDOWN_SLOTS && t.exitedSlot >= 0) continue;
      const riseFromCreation = riseBps(t.last.n, t.last.d, t.first.n, t.first.d);
      if (riseFromCreation < MIN_RISE_FROM_CREATION_BPS) continue;
      const past = priceAtOrBefore(t, slot - MOMENTUM_WINDOW_SLOTS);
      if (past !== null) {
        const recent = riseBps(t.last.n, t.last.d, past.n, past.d);
        if (recent < MIN_RECENT_RISE_BPS) continue;
      }
      const flow = flowInWindow(t, slot, FLOW_WINDOW_SLOTS);
      if (flow.buy < MIN_BUY_FLOW_SOL) continue;
      if (flow.buy * BigInt(BUY_DOMINANCE_DEN) < flow.sell * BigInt(BUY_DOMINANCE_NUM)) continue;
      const cap = state.maxBuyLamports(mint);
      let size = BUY_TARGET;
      if (cap < size) size = cap;
      if (freeCash < size) size = freeCash;
      if (size < MIN_BUY) continue;
      // Score: momentum first, then flow strength; mint breaks ties.
      const score = riseFromCreation * 1_000n + flow.buy / 1_000_000n;
      candidates.push({ mint, score, size });
    }
    candidates.sort((a, b) => {
      if (a.score !== b.score) return a.score > b.score ? -1 : 1;
      return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
    });
    let cashLeft = freeCash;
    for (const c of candidates.slice(0, room)) {
      let size = c.size;
      if (cashLeft < size) size = cashLeft;
      if (size < MIN_BUY) break;
      const buy: BuyInput = {
        side: "buy",
        mint: c.mint,
        quote_lamports: size.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(buy);
      cashLeft -= size;
    }
  }

  return orders;
}

await runBot({ onBatch });
