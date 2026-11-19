// End-to-end test of the mobile-money webhook on a local chain.
// Needs anvil + forge (Foundry). Run from web/: npx tsx scripts/test-momo.mts
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { createHmac } from "node:crypto";

const RPC = "http://127.0.0.1:8547";
const K = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // owner + installer
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // customer
  "0x" + "7".repeat(64), // installer's float wallet (funded below)
];
const anvil = spawn("anvil", ["--chain-id", "1990", "--port", "8547", "--silent"], { stdio: "ignore" });
const sh = (c: string) => execSync(c, { encoding: "utf8", env: { ...process.env, OWNER_KEY: K[0], CUSTOMER_KEY: K[1] } });
try {
  await new Promise((r) => setTimeout(r, 1500));
  const out = sh(`cd ../contracts && forge script script/LocalDemo.s.sol --rpc-url ${RPC} --broadcast --use /root/.solc/solc-0.8.24 2>&1`);
  const addr = (n: string) => out.match(new RegExp(`${n} (0x[0-9a-fA-F]{40})`))![1];
  const PAYG = addr("PAYG"), QUSDC = addr("QUSDC");
  const floatAddr = sh(`cast wallet address ${K[2]}`).trim();
  sh(`cast send ${QUSDC} "mint(address,uint256)" ${floatAddr} 50000000 --private-key ${K[0]} --rpc-url ${RPC}`);
  sh(`cast send ${floatAddr} --value 1ether --private-key ${K[0]} --rpc-url ${RPC}`); // gas money

  Object.assign(process.env, {
    VITE_PAYG: PAYG, IMOLE_RPC: RPC, TOPUP_KEY: K[2], PAYSTACK_SECRET_KEY: "sk_test_imole", MOMO_RATE_OVERRIDE: "NGN=1500",
    IMOLE_MASTER_KEY: "00".repeat(31) + "01",
  });
  const { POST } = await import("../api/momo.ts");
  const paidUntil = () => BigInt(sh(`cast call ${PAYG} "getPlan(uint256)((uint256,address,address,(uint128,uint128,uint128,uint32,uint32,uint32,bool),uint64,uint64,uint128,uint8))" 1 --rpc-url ${RPC}`).split(", ").at(-3)!.split(" ")[0]);
  const call = (body: object, secret = "sk_test_imole") => {
    const raw = JSON.stringify(body);
    return POST(new Request("http://x/api/momo", { method: "POST", body: raw, headers: { "x-paystack-signature": createHmac("sha512", secret).update(raw).digest("hex") } }));
  };
  const evt = { event: "charge.success", data: { reference: "ref-001", amount: 200000, currency: "NGN", metadata: { kit: "1", phone: "+2348000000000" } } };

  assert.equal((await call(evt, "wrong-secret")).status, 401, "bad signature is refused");
  const before = paidUntil();
  const res = await call(evt);
  const j = await res.json();
  console.log(j);
  assert.equal(res.status, 200);
  assert.equal(j.qusdc, 1.333333);          // ₦2,000 at ₦1,500/US$1
  assert.match(j.code, /^\d{4} \d{4} \d{4}$/);
  const after = paidUntil();
  assert.ok(after > before, "kit gained paid time");
  // 1.333333 QUSDC at 9 QUSDC per 7 days ≈ 1 day 0 h
  console.log(`paid time added: ${Number(after - before) / 3600} h`);
  const dup = await (await call(evt)).json();
  assert.equal(dup.duplicate, "ref-001", "same reference isn't paid twice");
  delete process.env.TOPUP_KEY;
  const dry = await call({ ...evt, data: { ...evt.data, reference: "ref-002" } });
  assert.equal(dry.status, 202, "no float wallet = dry run");
  console.log("mobile-money webhook OK");
} finally {
  anvil.kill();
}
