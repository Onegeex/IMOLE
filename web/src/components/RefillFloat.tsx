import { useEffect, useState } from "react";
import { formatEther, parseEther } from "viem";
import { ADDR, explorerTx, publicClient, routerAbi } from "../config";
import { explain, fmtUsd, send } from "../chain";
import { useWallet } from "../wallet";

/**
 * Agents need QUSDC to top up kits. This swaps QIE in the agent's wallet for QUSDC on QIEDEX,
 * straight into the same wallet. Cash-out is the reverse swap on QIEDEX, or an exchange.
 */
export function RefillFloat({ d, onDone }: { d: number; onDone: () => void }) {
  const { account, client } = useWallet();
  const [qie, setQie] = useState("10");
  const [bal, setBal] = useState<bigint | null>(null);
  const [quote, setQuote] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);

  useEffect(() => {
    if (account) publicClient.getBalance({ address: account }).then(setBal).catch(() => setBal(null));
  }, [account, hash]);

  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const wei = parseEther(qie || "0");
        if (wei === 0n) return setQuote(null);
        const wqie = await publicClient.readContract({ address: ADDR.router, abi: routerAbi, functionName: "WETH" });
        const out = await publicClient.readContract({ address: ADDR.router, abi: routerAbi, functionName: "getAmountsOut", args: [wei, [wqie, ADDR.qusdc]] });
        if (!gone) setQuote(out[1]);
      } catch {
        if (!gone) setQuote(null);
      }
    })();
    return () => { gone = true; };
  }, [qie]);

  if (!account) return null;

  const swap = async () => {
    setErr(null);
    setHash(null);
    try {
      const wei = parseEther(qie);
      const wqie = await publicClient.readContract({ address: ADDR.router, abi: routerAbi, functionName: "WETH" });
      const minOut = (quote! * 97n) / 100n; // at most 3% worse than the quote
      setBusy("Confirm the swap in your wallet…");
      const h = await send(client!, {
        address: ADDR.router, abi: routerAbi, functionName: "swapExactETHForTokens",
        args: [minOut, [wqie, ADDR.qusdc], account, BigInt(Math.floor(Date.now() / 1000) + 600)], value: wei,
      });
      setHash(h);
      onDone();
    } catch (e) {
      setErr(explain(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="refill">
      <summary>Refill your float with QIE</summary>
      <p className="muted small">
        Swaps QIE in this wallet for QUSDC on QIEDEX, into the same wallet. You have {bal === null ? "…" : `${Number(formatEther(bal)).toFixed(2)} QIE`}.
      </p>
      <div className="cash-row">
        <label className="field">
          <span>QIE to swap</span>
          <input inputMode="decimal" value={qie} onChange={(e) => setQie(e.target.value.replace(/[^\d.]/g, ""))} />
        </label>
        <div className="field">
          <span>You get about</span>
          <strong className="refill-out">{quote === null ? "—" : `${fmtUsd(quote, d)} QUSDC`}</strong>
        </div>
      </div>
      <button className="btn btn-small" disabled={!!busy || !quote || (bal !== null && parseEther(qie || "0") >= bal)} onClick={swap}>
        {busy ?? "Swap for QUSDC"}
      </button>
      {err && <p className="note note-err">{err}</p>}
      {hash && <p className="note note-ok">Float refilled. <a href={explorerTx(hash)}>View transaction</a></p>}
      <p className="muted small">
        Cashing out: swap QUSDC back to QIE on <a href="https://qiedex.qie.digital">QIEDEX</a>, then sell QIE on an exchange or OTC desk.
        Mobile-money on- and off-ramps are the next integration on the roadmap.
      </p>
    </details>
  );
}
