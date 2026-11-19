/** Browser copy of the tamper reset code from api/_lib.ts (same vectors in scripts/test-codes.mts). */
export const RESET = 2 ** 23 - 2;

export async function makeResetCode(deviceKeyHex: string, kitId: bigint | number, tamperCount: number): Promise<string> {
  const raw = new Uint8Array(deviceKeyHex.match(/../g)!.map((b) => parseInt(b, 16)));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`imole-reset:${kitId}:${tamperCount}`)));
  const v = BigInt(RESET) * 65536n + BigInt((mac[0] << 8) | mac[1]);
  return v.toString().padStart(12, "0");
}
