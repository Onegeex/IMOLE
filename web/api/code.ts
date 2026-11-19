/**
 * GET /api/code?kit=1
 * Returns the offline unlock code for a kit's paid-up time, read live from QIE Mainnet.
 * Public on purpose: a code only encodes time that is already paid for on-chain.
 */
import { deviceKey, FOREVER, groupCode, json, makeCode, readKitUnlock, t10For } from "./_lib.js";

export async function GET(req: Request) {
  const master = process.env.IMOLE_MASTER_KEY;
  if (!master) return json({ error: "Code service isn't configured." }, 503);
  const kitParam = new URL(req.url).searchParams.get("kit") ?? "";
  if (!/^\d{1,9}$/.test(kitParam)) return json({ error: "Pass a kit number, e.g. ?kit=1" }, 400);
  const kitId = BigInt(kitParam);

  try {
    const k = await readKitUnlock(kitId);
    if (!k.exists) return json({ error: `There's no kit ${kitId} on Imole.` }, 404);
    const owned = k.status === 3;
    const now = Math.floor(Date.now() / 1000);
    if (!owned && k.unlockUntil <= now) {
      return json({ error: "This kit has no paid time left. Pay first, then fetch the code again.", kit: kitParam }, 409);
    }
    const t10 = owned ? FOREVER : t10For(k.unlockUntil);
    const code = makeCode(deviceKey(master, kitId), kitId, t10);
    return json({
      kit: kitParam,
      code: groupCode(code),
      owned,
      unlockUntil: owned ? null : 1767225600 + t10 * 600,
      secondsLeft: owned ? null : 1767225600 + t10 * 600 - now,
    });
  } catch {
    return json({ error: "Couldn't reach QIE Mainnet. Try again in a moment." }, 502);
  }
}
