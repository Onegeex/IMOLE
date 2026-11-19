/**
 * Imole offline unlock codes.
 *
 * Why: off-grid kits often have no internet. The controller can't read the chain, so the
 * customer types a short code on the kit's keypad instead, like the keypad tokens used by
 * existing pay-as-you-go solar companies. The difference: here a code can only ever encode
 * time that has already been paid ON-CHAIN, so neither the installer nor Imole can sell
 * power that wasn't paid for, and nobody can withhold it (the endpoint is public).
 *
 * Scheme (mirrored byte for byte in firmware/imole-controller/imole-controller.ino):
 *   EPOCH       = 2026-01-01T00:00:00Z (1767225600)
 *   T10         = floor((unlockUntil - EPOCH) / 600)   // 10-minute steps, 23 bits; 2^23-1 = forever
 *   deviceKey   = HMAC-SHA256(masterKey, "imole-device-key:" + kitId)          // 32 bytes, flashed into the kit
 *   mac16       = first 2 bytes of HMAC-SHA256(deviceKey, "imole:" + kitId + ":" + T10)
 *   code        = T10 * 65536 + mac16, as 12 decimal digits                     // < 2^39, fits in 12 digits
 *
 * Tamper reset (installer only): if the kit's case is opened, the controller locks and counts the event.
 * Only a reset code clears it, and each one works once:
 *   T10 = RESET (2^23 - 2, reserved), mac16 = first 2 bytes of HMAC-SHA256(deviceKey, "imole-reset:" + kitId + ":" + tamperCount)
 * The installer makes it from the kit's device key (Installers -> Controller key). The public code service never issues one.
 *
 * The controller keeps time with its RTC (set from the chain's block time whenever it is online),
 * and only accepts a code whose T10 is later than the one it already holds, so old codes can't be
 * replayed. Five wrong codes lock the keypad for ten minutes (1-in-65,536 guess per try).
 */
import { createHmac } from "node:crypto";
import { createPublicClient, fallback, http, parseAbi, type Address } from "viem";

export const EPOCH = 1767225600;
export const FOREVER = 2 ** 23 - 1;
export const RESET = 2 ** 23 - 2; // reserved for tamper reset codes

export function deviceKey(masterHex: string, kitId: bigint | number): Buffer {
  return createHmac("sha256", Buffer.from(masterHex, "hex")).update(`imole-device-key:${kitId}`).digest();
}

export function t10For(unlockUntil: number): number {
  if (unlockUntil <= EPOCH) return 0;
  return Math.min(RESET - 1, Math.floor((unlockUntil - EPOCH) / 600));
}

export function makeCode(key: Buffer, kitId: bigint | number, t10: number): string {
  const mac = createHmac("sha256", key).update(`imole:${kitId}:${t10}`).digest();
  const mac16 = (mac[0] << 8) | mac[1];
  const v = BigInt(t10) * 65536n + BigInt(mac16);
  return v.toString().padStart(12, "0");
}

export function makeResetCode(key: Buffer, kitId: bigint | number, tamperCount: number): string {
  const mac = createHmac("sha256", key).update(`imole-reset:${kitId}:${tamperCount}`).digest();
  const v = BigInt(RESET) * 65536n + BigInt((mac[0] << 8) | mac[1]);
  return v.toString().padStart(12, "0");
}

export const groupCode = (c: string) => `${c.slice(0, 4)} ${c.slice(4, 8)} ${c.slice(8, 12)}`;

// ------------------------------------------------------------------ chain

const PAYG = (process.env.VITE_PAYG || "0xae6501e9c96EaDFB835f11b581D8353cF5e7d8AD") as Address;
const RPCS = process.env.IMOLE_RPC
  ? [process.env.IMOLE_RPC]
  : ["https://rpc1mainnet.qie.digital", "https://rpc2mainnet.qie.digital", "https://rpc5mainnet.qie.digital"];

export const client = createPublicClient({
  transport: fallback(RPCS.map((u) => http(u, { timeout: 6000 })), { retryCount: 2 }),
});

const abi = parseAbi([
  "function kits(uint256) view returns (address installer, uint32 panelWatts, uint32 batteryWh, uint32 inverterVA, string location, uint256 currentPlan)",
  "function getPlan(uint256) view returns ((uint256 kitId, address installer, address customer, (uint128 price, uint128 deposit, uint128 installment, uint32 period, uint32 grace, uint32 repossessAfter, bool requireKyc) terms, uint64 startedAt, uint64 paidUntil, uint128 totalPaid, uint8 status))",
]);

export async function readKitUnlock(kitId: bigint) {
  const kit = await client.readContract({ address: PAYG, abi, functionName: "kits", args: [kitId] });
  const installer = kit[0];
  if (/^0x0{40}$/i.test(installer)) return { exists: false as const };
  const plan = await client.readContract({ address: PAYG, abi, functionName: "getPlan", args: [kit[5]] });
  const status = Number(plan.status); // 2 Active, 3 PaidOff
  let unlockUntil = 0;
  if (status === 3) unlockUntil = Number.MAX_SAFE_INTEGER;
  else if (status === 2) unlockUntil = Number(plan.paidUntil) + Number(plan.terms.grace);
  return { exists: true as const, installer: installer as Address, status, unlockUntil };
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}
