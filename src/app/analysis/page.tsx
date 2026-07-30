import { AnalysisPanel } from "@/components/AnalysisPanel";
import { Suspense } from "react";

export default function AnalysisPage() {
  return (
    <Suspense
      fallback={
        <p className="text-sm text-binance-muted">Loading analysis…</p>
      }
    >
      <AnalysisPanel />
    </Suspense>
  );
}
