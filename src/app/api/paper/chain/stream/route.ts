import { liveOptionChainHub } from "@/lib/marketdata/liveOptionChainHub";
import type { Underlying } from "@/lib/marketdata/angelone/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * SSE stream of paper option-chain snapshots.
 * ATM-band LTP/OI patched from Angel SmartAPI WebSocket; full chain via REST.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const underlying = (url.searchParams.get("underlying") ??
    "NIFTY") as Underlying;
  if (!["NIFTY", "BANKNIFTY", "SENSEX"].includes(underlying)) {
    return new Response(JSON.stringify({ ok: false, error: "Invalid underlying" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      const send = (event: string, data: unknown) => {
        safeEnqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        unsubscribe?.();
        unsubscribe = null;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      unsubscribe = liveOptionChainHub.subscribe(underlying, (payload) => {
        send("chain", payload);
      });

      heartbeat = setInterval(() => {
        safeEnqueue(`: heartbeat ${Date.now()}\n\n`);
      }, 12_000);

      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      unsubscribe?.();
      unsubscribe = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
