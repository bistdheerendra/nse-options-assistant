/**
 * Stage 3 volume confirm/disqualify sanity checks.
 * Usage: npx tsx scripts/test-scalp-volume.ts
 */
import {
  VOLUME_LOOKBACK,
  VOLUME_SPIKE_MULT,
  VOLUME_WEAK_MULT,
  analyzeTimeframeVolume,
  applyVolumeConfirmation,
  rollingAvgVolume,
} from "../src/lib/marketdata/scalp/volume";
import type { OhlcvCandle } from "../src/lib/marketdata/angelone";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function makeSeries(vols: number[]): OhlcvCandle[] {
  return vols.map((volume, i) => ({
    time: `2026-01-01T09:${String(i).padStart(2, "0")}:00+05:30`,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume,
  }));
}

const prior = Array.from({ length: VOLUME_LOOKBACK }, () => 1000);
const spikeSeries = makeSeries([...prior, 1000 * VOLUME_SPIKE_MULT]);
const weakSeries = makeSeries([...prior, 1000 * VOLUME_WEAK_MULT * 0.5]);
const normalSeries = makeSeries([...prior, 1000]);

assert(
  rollingAvgVolume(spikeSeries) === 1000,
  `avg should be 1000, got ${rollingAvgVolume(spikeSeries)}`,
);

const spike = analyzeTimeframeVolume("ONE_MINUTE", spikeSeries);
assert(spike.flag === "spike", `expected spike, got ${spike.flag}`);

const weak = analyzeTimeframeVolume("ONE_MINUTE", weakSeries);
assert(weak.flag === "weak", `expected weak, got ${weak.flag}`);

const normal = analyzeTimeframeVolume("FIVE_MINUTE", normalSeries);
assert(normal.flag === "normal", `expected normal, got ${normal.flag}`);

const confirmed = applyVolumeConfirmation(spike, 0.6, 1);
assert(confirmed.role === "confirm", `role ${confirmed.role}`);
assert(
  confirmed.adjustedConfidence > confirmed.inputConfidence,
  "spike should boost confidence",
);

const disqualified = applyVolumeConfirmation(weak, 0.7, 1);
assert(disqualified.role === "disqualify", `role ${disqualified.role}`);
assert(
  disqualified.adjustedConfidence < disqualified.inputConfidence,
  "weak volume should lower confidence",
);

console.log("test-scalp-volume: all passed", {
  VOLUME_LOOKBACK,
  VOLUME_SPIKE_MULT,
  VOLUME_WEAK_MULT,
  spikeRatio: spike.volumeRatio,
  weakRatio: weak.volumeRatio,
});
