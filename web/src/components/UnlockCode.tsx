import { useCallback, useEffect, useState } from "react";
import { humanDuration } from "../chain";

type Resp = { code?: string; owned?: boolean; secondsLeft?: number | null; error?: string };

/** Fetches the offline unlock code for a kit's paid-up time and offers copy / SMS. */
export function UnlockCode({ kitId, auto = false, refreshKey = 0 }: { kitId: bigint; auto?: boolean; refreshKey?: number }) {
  const [data, setData] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/code?kit=${kitId}`, { cache: "no-store" });
      setData(await r.json());
    } catch {
      setData({ error: "Couldn't reach the code service. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }, [kitId]);

  useEffect(() => {
    if (auto) load();
  }, [auto, load, refreshKey]);

  const sms = data?.code
    ? `sms:?&body=${encodeURIComponent(`Imole kit ${kitId}: type ${data.code.replace(/ /g, "")} then # on your kit's keypad.`)}`
    : "";

  return (
    <div className="unlock">
      <div className="unlock-head">
        <h3>Code for the kit's keypad</h3>
        <button className="link" onClick={load} disabled={busy}>{busy ? "Getting code…" : data ? "Refresh" : "Get code"}</button>
      </div>
      <p className="muted small">
        For kits with no internet. The code holds only the time already paid on-chain, so it's safe to share.
      </p>
      {data?.error && <p className="note note-err">{data.error}</p>}
      {data?.code && (
        <>
          <p className="unlock-code" aria-label={`Unlock code ${data.code}`}>{data.code}</p>
          <p className="muted small">
            {data.owned ? "Unlocks the kit for good." : `Keeps the kit on for ${humanDuration(data.secondsLeft ?? 0)}.`} The customer
            types it, then # on the kit.
          </p>
          <div className="unlock-actions">
            <button
              className="btn btn-small"
              onClick={() => navigator.clipboard?.writeText(data.code!.replace(/ /g, "")).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); })}
            >
              {copied ? "Copied" : "Copy code"}
            </button>
            <a className="btn btn-small btn-ghost" href={sms}>Send by SMS</a>
          </div>
        </>
      )}
    </div>
  );
}
