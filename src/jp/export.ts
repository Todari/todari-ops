import { allCards, allMistakes, stats } from "./cards.js";

// Consumed by the Mac-side cron (workspace-harness jp_snapshot.py, Task 7b)
// via POST /jp/export, which regenerates read-only vault notes from this
// bot's file-based store (jp.json is the source of truth).
export function jpExport() {
  return {
    cards: allCards(),
    mistakes: allMistakes().slice(-200).reverse(),
    stats: stats(new Date()),
  };
}
