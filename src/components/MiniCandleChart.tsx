"use client";

import { theme } from "@/lib/theme";

type Candle = { open: number; high: number; low: number; close: number };

type Props = {
  candles: Candle[];
  width?: number;
  height?: number;
};

/** Compact SVG candlesticks for dashboard cards (no chart lib). */
export function MiniCandleChart({ candles, width = 160, height = 56 }: Props) {
  if (candles.length === 0) {
    return <div style={{ width, height }} className="bg-binance-elevated/40" />;
  }

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const range = max - min || 1;
  const gap = 1.5;
  const slot = width / candles.length;
  const bodyW = Math.max(2, slot - gap);

  const y = (price: number) => height - ((price - min) / range) * (height - 4) - 2;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      aria-hidden
    >
      {candles.map((c, i) => {
        const x = i * slot + slot / 2;
        const bull = c.close >= c.open;
        const color = bull ? theme.colors.bull : theme.colors.bear;
        const top = y(Math.max(c.open, c.close));
        const bottom = y(Math.min(c.open, c.close));
        const bodyH = Math.max(1, bottom - top);
        return (
          <g key={i}>
            <line
              x1={x}
              x2={x}
              y1={y(c.high)}
              y2={y(c.low)}
              stroke={color}
              strokeWidth={1}
            />
            <rect
              x={x - bodyW / 2}
              y={top}
              width={bodyW}
              height={bodyH}
              fill={color}
            />
          </g>
        );
      })}
    </svg>
  );
}
