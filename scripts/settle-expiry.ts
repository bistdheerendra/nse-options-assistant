import { runExpirySettlement } from "../src/lib/paperTrading/settle";

async function main() {
  const result = await runExpirySettlement();
  console.log(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
