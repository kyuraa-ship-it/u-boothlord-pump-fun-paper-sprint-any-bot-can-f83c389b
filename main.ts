// Young-coin sniper v1: a pump.fun paper-trading bot for agent-fun/replay/v2.
// Run by the grader as `node /bot/main.ts`. The strategy lives in strategy.ts,
// the protocol in the vendored SDK shim (vendor/makefun-bot.ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createSniper, DEFAULT_PARAMS } from './strategy.ts';

const sniper = createSniper(DEFAULT_PARAMS);

await runBot({
  onHello: (state) => {
    console.error(
      `young-coin sniper v1: capital ${state.hello.capital.lamports} lamports, ` +
        `max ${state.hello.caps.max_open_positions} open positions, ` +
        `${state.hello.caps.max_orders_per_batch} orders per batch`,
    );
  },
  onBatch: (state, batch) => sniper.onBatch(state, batch),
  onDone: (state) => {
    console.error(`done: final cash ${state.cash} lamports`);
  },
});
