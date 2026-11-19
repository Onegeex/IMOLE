/**
 * POST /api/device-key  { kit: "1", signature: "0x…" }
 * Gives an installer the secret key to flash into a kit's controller. The installer signs the
 * message "Imole device key for kit <n>" with the wallet that listed the kit; we check the signer
 * against the kit's installer on-chain. The key only lets a controller CHECK codes; codes
 * themselves are only issued for time paid on-chain.
 */
import { verifyMessage, type Hex } from "viem";
import { deviceKey, json, readKitUnlock } from "./_lib.js";

export async function POST(req: Request) {
  const master = process.env.IMOLE_MASTER_KEY;
  if (!master) return json({ error: "Code service isn't configured." }, 503);
  let body: { kit?: string; signature?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Send JSON: { kit, signature }" }, 400);
  }
  if (!body.kit || !/^\d{1,9}$/.test(body.kit) || !body.signature?.startsWith("0x")) {
    return json({ error: "Send JSON: { kit, signature }" }, 400);
  }
  const kitId = BigInt(body.kit);
  try {
    const k = await readKitUnlock(kitId);
    if (!k.exists) return json({ error: `There's no kit ${kitId} on Imole.` }, 404);
    const ok = await verifyMessage({
      address: k.installer,
      message: `Imole device key for kit ${kitId}`,
      signature: body.signature as Hex,
    });
    if (!ok) return json({ error: "Only the installer who listed this kit can get its controller key." }, 403);
    return json({ kit: body.kit, deviceKey: deviceKey(master, kitId).toString("hex") });
  } catch {
    return json({ error: "Couldn't reach QIE Mainnet. Try again in a moment." }, 502);
  }
}
