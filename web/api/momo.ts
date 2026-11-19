/**
 * POST /api/momo — mobile-money top-up (prototype, Paystack webhook format).
 *
 * The customer pays with mobile money or a card through a payment partner, for example a Paystack
 * payment link with the kit number in its metadata. The partner calls this webhook when the money
 * lands. Imole then:
 *   1. checks the partner's signature (HMAC-SHA512 of the raw body with PAYSTACK_SECRET_KEY),
 *   2. converts the local amount to QUSDC at today's rate,
 *   3. pays the kit's plan on QIE from the installer's float wallet (TOPUP_KEY),
 *   4. returns the kit's new 12-digit code, ready to send to the customer by SMS.
 * The customer never touches a wallet or a blockchain.
 *
 * Without TOPUP_KEY it runs as a dry run: it checks everything and reports what it would pay,
 * but sends nothing. The live deployment runs this way; the full path is tested on a local chain
 * by web/scripts/test-momo.mts.
 *
 * Production notes: keep processed references in a store (here they're kept in memory per
 * instance, and Paystack retries on non-200), and send the code through an SMS provider.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createWalletClient, defineChain, fallback, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { client, deviceKey, FOREVER, groupCode, json, makeCode, readKitUnlock, t10For } from "./_lib.js";

const PAYG = (process.env.VITE_PAYG || "0xae6501e9c96EaDFB835f11b581D8353cF5e7d8AD") as Address;
const RPCS = process.env.IMOLE_RPC
  ? [process.env.IMOLE_RPC]
  : ["https://rpc1mainnet.qie.digital", "https://rpc2mainnet.qie.digital", "https://rpc5mainnet.qie.digital"];
const qie = defineChain({
  id: 1990,
  name: "QIE Mainnet",
  nativeCurrency: { name: "QIE", symbol: "QIE", decimals: 18 },
  rpcUrls: { default: { http: RPCS } },
});

const abi = parseAbi([
  "function kits(uint256) view returns (address installer, uint32 panelWatts, uint32 batteryWh, uint32 inverterVA, string location, uint256 currentPlan)",
  "function getPlan(uint256) view returns ((uint256 kitId, address installer, address customer, (uint128 price, uint128 deposit, uint128 installment, uint32 period, uint32 grace, uint32 repossessAfter, bool requireKyc) terms, uint64 startedAt, uint64 paidUntil, uint128 totalPaid, uint8 status))",
  "function qusdc() view returns (address)",
  "function pay(uint256 planId, uint256 amount)",
]);
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);

const seen = new Set<string>();

/** Units of `currency` per US$1. Paystack amounts are in the currency's minor unit (kobo, pesewas, cents). */
async function usdRate(currency: string): Promise<number> {
  if (currency === "USD") return 1;
  const fixed = process.env.MOMO_RATE_OVERRIDE; // tests: "NGN=1500"
  if (fixed) {
    const [c, r] = fixed.split("=");
    if (c === currency) return Number(r);
  }
  const j = (await (await fetch("https://open.er-api.com/v6/latest/USD")).json()) as { rates?: Record<string, number> };
  const r = j.rates?.[currency];
  if (!r) throw new Error(`No exchange rate for ${currency}`);
  return r;
}

function signatureOk(raw: string, sig: string | null, secret: string): boolean {
  if (!sig || !/^[0-9a-f]{128}$/i.test(sig)) return false;
  const want = createHmac("sha512", secret).update(raw).digest();
  return timingSafeEqual(want, Buffer.from(sig, "hex"));
}

export async function POST(req: Request) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return json({ error: "Mobile-money top-ups aren't configured on this deployment." }, 503);

  const raw = await req.text();
  if (!signatureOk(raw, req.headers.get("x-paystack-signature"), secret)) return json({ error: "Bad signature." }, 401);

  let evt: { event?: string; data?: { reference?: string; amount?: number; currency?: string; metadata?: { kit?: string | number; phone?: string } } };
  try { evt = JSON.parse(raw); } catch { return json({ error: "Body isn't JSON." }, 400); }
  if (evt.event !== "charge.success") return json({ ignored: evt.event ?? "unknown event" });

  const d = evt.data ?? {};
  const ref = String(d.reference ?? "");
  const kitStr = String(d.metadata?.kit ?? "");
  if (!ref || !/^\d{1,9}$/.test(kitStr) || !Number.isInteger(d.amount) || (d.amount ?? 0) <= 0 || !d.currency) {
    return json({ error: "Missing reference, kit number, amount or currency." }, 400);
  }
  if (seen.has(ref)) return json({ duplicate: ref });

  const kitId = BigInt(kitStr);
  try {
    const kit = await client.readContract({ address: PAYG, abi, functionName: "kits", args: [kitId] });
    if (/^0x0{40}$/i.test(kit[0])) return json({ error: `There's no kit ${kitId} on Imole.` }, 404);
    const planId = kit[5];
    const plan = await client.readContract({ address: PAYG, abi, functionName: "getPlan", args: [planId] });
    if (Number(plan.status) !== 2) return json({ error: "This kit has no active plan to top up." }, 409);

    const usd = d.amount! / 100 / (await usdRate(d.currency));
    const remaining = plan.terms.price - plan.totalPaid;
    let amount = BigInt(Math.floor(usd * 1e6)); // QUSDC has 6 decimals
    if (amount > remaining) amount = remaining;
    if (amount === 0n) return json({ error: "Amount is too small to top up." }, 400);
    const summary = { reference: ref, kit: kitStr, plan: planId.toString(), localAmount: `${d.amount! / 100} ${d.currency}`, qusdc: Number(amount) / 1e6 };

    const key = process.env.TOPUP_KEY as `0x${string}` | undefined;
    if (!key) return json({ dryRun: true, wouldPay: summary, note: "No float wallet is configured here, so nothing was sent." }, 202);

    const account = privateKeyToAccount(key);
    const wallet = createWalletClient({ account, chain: qie, transport: fallback(RPCS.map((u) => http(u, { timeout: 8000 }))) });
    const qusdc = await client.readContract({ address: PAYG, abi, functionName: "qusdc" });
    const bal = await client.readContract({ address: qusdc, abi: erc20, functionName: "balanceOf", args: [account.address] });
    if (bal < amount) return json({ error: "The float wallet doesn't hold enough QUSDC.", needed: summary.qusdc }, 503);
    const allowance = await client.readContract({ address: qusdc, abi: erc20, functionName: "allowance", args: [account.address, PAYG] });
    if (allowance < amount) {
      const h = await wallet.writeContract({ address: qusdc, abi: erc20, functionName: "approve", args: [PAYG, 2n ** 255n] });
      await client.waitForTransactionReceipt({ hash: h });
    }
    const hash = await wallet.writeContract({ address: PAYG, abi, functionName: "pay", args: [planId, amount] });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") return json({ error: "The top-up transaction failed.", tx: hash }, 502);
    seen.add(ref);

    const master = process.env.IMOLE_MASTER_KEY;
    let code: string | null = null;
    if (master) {
      const k = await readKitUnlock(kitId);
      if (k.exists && (k.status === 3 || k.unlockUntil > 0)) {
        code = groupCode(makeCode(deviceKey(master, kitId), kitId, k.status === 3 ? FOREVER : t10For(k.unlockUntil)));
      }
    }
    const sms = code ? `Imole: kit ${kitStr} topped up with ${d.amount! / 100} ${d.currency}. Code: ${code}. Type it on the keypad, then #.` : null;
    return json({ ok: true, ...summary, tx: hash, code, sms, smsSentTo: null });
  } catch (e) {
    return json({ error: "Couldn't complete the top-up.", detail: (e as Error).message.slice(0, 200) }, 502);
  }
}
