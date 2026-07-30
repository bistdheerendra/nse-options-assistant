import { runOptionsFlowLane } from "../src/lib/lanes/optionsFlow";
import { runTechnicalLane } from "../src/lib/lanes/technical";

async function main() {
  const underlying = "NIFTY" as const;
  console.log("=== Technical lane (SWING) ===");
  const tech = await runTechnicalLane({ underlying, mode: "SWING" });
  console.log(JSON.stringify(tech, null, 2));

  console.log("\n=== Options Flow lane (SWING) ===");
  const flow = await runOptionsFlowLane({ underlying, mode: "SWING" });
  console.log(JSON.stringify(flow, null, 2));

  console.log("\n=== Technical lane (SCALP) ===");
  const techScalp = await runTechnicalLane({ underlying, mode: "SCALP" });
  console.log(JSON.stringify({ score: techScalp.score, signals: techScalp.signals }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
