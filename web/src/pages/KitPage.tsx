import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { formatEther, parseEther, type Address } from "viem";
import { Meter } from "../components/Meter";
import { Connect, short } from "../components/Shell";
import { ADDR, deployed, erc20Abi, explorerAddr, explorerTx, publicClient, routerAbi } from "../config";
import {
  explain, fmtUsd, humanDuration, isVerified, payg_, periodCount, periodName, qusdcDecimals, readInstaller, readKit, readKitStatus,
  readPlan, readTokenImage, send, type Kit, type Plan,
} from "../chain";
import { useWallet } from "../wallet";

type Loaded = {
  kit: Kit;
  plan: Plan;
  status: Awaited<ReturnType<typeof readKitStatus>>;
  installerName: string;
  installerVerified: boolean;
  image: string | null;
  d: number;
};

export function KitPage() {
  const { id = "0" } = useParams();
  const kitId = BigInt(/^\d+$/.test(id) ? id : "0");
  const [data, setData] = useState<Loaded | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const kit = await readKit(kitId);
      if (kit.installer === "0x0000000000000000000000000000000000000000") {
        setLoadErr(`There's no kit ${kitId} on Imole. Check the number on the controller sticker.`);
        return;
      }
      const [plan, status, inst, image, d] = await Promise.all([
        readPlan(kit.currentPlan),
        readKitStatus(kitId),
        readInstaller(kit.installer),
        readTokenImage(kitId),
        qusdcDecimals(),
      ]);
      setData({ kit, plan, status, installerName: inst.name, installerVerified: inst.verified, image, d });
      setLoadErr(null);
    } catch {
      setLoadErr("Couldn't reach QIE Mainnet to read this kit. Check your connection and reload.");
    }
  }, [kitId]);

  useEffect(() => {
    if (!deployed) return;
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  if (!deployed) return <p className="empty">Contracts aren't configured for this build.</p>;
  if (loadErr) return <p className="empty">{loadErr}</p>;
  if (!data) return <p className="empty">Reading kit {kitId.toString()} from QIE Mainnet…</p>;

  const { kit, plan, status, d } = data;
  const remaining = plan.terms.price - plan.totalPaid;

  return (
    <div className="kit-layout">
      <div className="kit-main">
        <Meter
          kitId={kitId}
          active={status.active}
          owned={plan.status === "PaidOff"}
          secondsLeft={status.secondsLeft}
          percentPaid={status.percentPaid}
        />
        <PayPanel data={data} reload={load} />
      </div>

      <aside className="kit-side">
        <h2>Kit {kitId.toString()}</h2>
        <dl className="facts">
          <div><dt>Location</dt><dd>{kit.location}</dd></div>
          <div><dt>Installer</dt><dd>{data.installerName}{data.installerVerified ? " (verified business)" : ""}</dd></div>
          <div><dt>Panels</dt><dd>{kit.panelWatts} W</dd></div>
          <div><dt>Battery</dt><dd>{(kit.batteryWh / 1000).toFixed(1)} kWh</dd></div>
          <div><dt>Inverter</dt><dd>{(kit.inverterVA / 1000).toFixed(1)} kVA</dd></div>
          <div><dt>Price</dt><dd>{fmtUsd(plan.terms.price, d)} QUSDC</dd></div>
          <div><dt>Paid so far</dt><dd>{fmtUsd(plan.totalPaid, d)} QUSDC</dd></div>
          <div><dt>Left to pay</dt><dd>{fmtUsd(remaining, d)} QUSDC</dd></div>
          <div><dt>Rate</dt><dd>{fmtUsd(plan.terms.installment, d)} QUSDC per {periodName(plan.terms.period)}</dd></div>
          <div><dt>Grace after time runs out</dt><dd>{humanDuration(plan.terms.grace)}</dd></div>
          <div><dt>Customer</dt><dd><a href={explorerAddr(plan.customer)}>{short(plan.customer)}</a></dd></div>
        </dl>
        {data.image && <img className="nft" src={data.image} alt={`Kit ${kitId} NFT showing its current state`} />}
        <p className="muted small">
          The kit is an NFT held by the Imole contract until it's paid off. <a href={explorerAddr(ADDR.payg)}>View contract</a>
        </p>
      </aside>
    </div>
  );
}

function PayPanel({ data, reload }: { data: Loaded; reload: () => Promise<void> }) {
  const { plan, d } = data;
  const { account, client } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ msg: string; hash: string } | null>(null);
  const [method, setMethod] = useState<"qusdc" | "qie">("qusdc");
  const [periods, setPeriods] = useState(1);
  const [qieAmount, setQieAmount] = useState("10");
  const [quote, setQuote] = useState<bigint | null>(null);
  const [copied, setCopied] = useState(false);

  const remaining = plan.terms.price - plan.totalPaid;
  const amount = useMemo(() => {
    const a = plan.terms.installment * BigInt(periods);
    return a > remaining ? remaining : a;
  }, [periods, plan, remaining]);

  // live QIEDEX quote for the QIE path
  useEffect(() => {
    if (method !== "qie") return;
    let gone = false;
    (async () => {
      try {
        const wei = parseEther(qieAmount || "0");
        if (wei === 0n) return setQuote(null);
        const wqie = await publicClient.readContract({ address: ADDR.router, abi: routerAbi, functionName: "WETH" });
        const out = await publicClient.readContract({
          address: ADDR.router, abi: routerAbi, functionName: "getAmountsOut", args: [wei, [wqie, ADDR.qusdc]],
        });
        if (!gone) setQuote(out[1]);
      } catch {
        if (!gone) setQuote(null);
      }
    })();
    return () => { gone = true; };
  }, [method, qieAmount]);

  const run = async (label: string, fn: () => Promise<string>, msg: string) => {
    setErr(null);
    setDone(null);
    setBusy(label);
    try {
      const hash = await fn();
      setDone({ msg, hash });
      await reload();
    } catch (e) {
      setErr(explain(e));
    } finally {
      setBusy(null);
    }
  };

  const approveIfNeeded = async (amt: bigint) => {
    const allowance = await publicClient.readContract({
      address: ADDR.qusdc, abi: erc20Abi, functionName: "allowance", args: [account!, ADDR.payg as Address],
    });
    if (allowance < amt) {
      setBusy("Approve QUSDC in your wallet…");
      await send(client!, { address: ADDR.qusdc, abi: erc20Abi, functionName: "approve", args: [ADDR.payg as Address, amt] });
    }
  };

  const shareLink = () => {
    navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (plan.status === "PaidOff")
    return <div className="panel"><h2>Paid off</h2><p>This kit belongs to {short(plan.customer)}. Its power can't be switched off again.</p></div>;
  if (plan.status === "Repossessed")
    return <div className="panel"><h2>Returned to the installer</h2><p>The plan went too long without payment and the installer took the kit back.</p></div>;
  if (plan.status === "Cancelled" || plan.status === "None")
    return <div className="panel"><h2>Not for sale</h2><p>This kit has no open plan right now.</p></div>;

  if (plan.status === "Pending") {
    const isCustomer = account?.toLowerCase() === plan.customer.toLowerCase();
    return (
      <div className="panel">
        <h2>Waiting for the customer to accept</h2>
        <p>
          Accepting fixes the terms and pays the {fmtUsd(plan.terms.deposit, d)} QUSDC deposit, which buys{" "}
          {humanDuration((Number(plan.terms.deposit) * plan.terms.period) / Number(plan.terms.installment))} of power.
        </p>
        {!account && <Connect why="If you're the customer, connect the wallet the installer registered." />}
        {account && !isCustomer && <p className="muted">Only {short(plan.customer)} can accept this plan.</p>}
        {account && isCustomer && (
          <button
            className="btn"
            disabled={!!busy}
            onClick={() =>
              run("Accepting…", async () => {
                if (plan.terms.requireKyc && !(await isVerified(account))) {
                  throw new Error("Your ID check isn't recorded yet. Ask the installer to verify you, then try again.");
                }
                if (plan.terms.deposit > 0n) await approveIfNeeded(plan.terms.deposit);
                setBusy("Confirm in your wallet…");
                return send(client!, { ...payg_(), functionName: "acceptPlan", args: [plan.id] });
              }, "Plan accepted. Your kit is on.")
            }
          >
            {busy ?? `Accept and pay ${fmtUsd(plan.terms.deposit, d)} QUSDC deposit`}
          </button>
        )}
        <Feedback err={err} done={done} />
      </div>
    );
  }

  // Active
  const buys = (a: bigint) => humanDuration((Number(a) * plan.terms.period) / Number(plan.terms.installment));
  const options = [1, 2, 4, 8].filter((n, i) => i === 0 || plan.terms.installment * BigInt(n) <= remaining);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Buy more power</h2>
        <button className="link" onClick={shareLink}>{copied ? "Link copied" : "Copy link to share"}</button>
      </div>
      <p className="muted">Anyone can pay toward this kit. Send the link to family who want to help.</p>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={method === "qusdc"} onClick={() => setMethod("qusdc")}>Pay in QUSDC</button>
        <button role="tab" aria-selected={method === "qie"} onClick={() => setMethod("qie")}>Pay in QIE</button>
      </div>

      {method === "qusdc" ? (
        <>
          <div className="chips" role="radiogroup" aria-label="How much to pay">
            {options.map((n) => (
              <button key={n} role="radio" aria-checked={periods === n} className="chip" onClick={() => setPeriods(n)}>
                {periodCount(n, plan.terms.period)}
              </button>
            ))}
            <button role="radio" aria-checked={periods === 10_000} className="chip" onClick={() => setPeriods(10_000)}>
              Pay it all off
            </button>
          </div>
          <p className="sum">
            <strong>{fmtUsd(amount, d)} QUSDC</strong>
            <span>{periods === 10_000 || amount === remaining ? "clears the kit. It's yours after this." : `adds ${buys(amount)} of power`}</span>
          </p>
          {account ? (
            <button
              className="btn"
              disabled={!!busy}
              onClick={() =>
                run("Paying…", async () => {
                  await approveIfNeeded(amount);
                  setBusy("Confirm the payment in your wallet…");
                  return send(client!, { ...payg_(), functionName: "pay", args: [plan.id, amount] });
                }, `Paid ${fmtUsd(amount, d)} QUSDC.`)
              }
            >
              {busy ?? `Pay ${fmtUsd(amount, d)} QUSDC`}
            </button>
          ) : (
            <Connect why="Connect a wallet to pay." />
          )}
        </>
      ) : (
        <>
          <label className="field">
            <span>Amount of QIE</span>
            <input inputMode="decimal" value={qieAmount} onChange={(e) => setQieAmount(e.target.value.replace(/[^\d.]/g, ""))} />
          </label>
          <p className="sum">
            <strong>{quote !== null ? `≈ ${fmtUsd(quote > remaining ? remaining : quote, d)} QUSDC` : "Getting a price…"}</strong>
            <span>{quote !== null ? (quote >= remaining ? "clears the kit. Any extra comes back to you as QUSDC." : `adds about ${buys(quote)} of power`) : "from QIEDEX"}</span>
          </p>
          <p className="muted small">The swap must land within 8% of the QIE Oracle price or it's refused.</p>
          {account ? (
            <button
              className="btn"
              disabled={!!busy || !quote}
              onClick={() =>
                run("Paying…", async () => {
                  const wei = parseEther(qieAmount);
                  const minOut = (quote! * 98n) / 100n;
                  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
                  setBusy("Confirm the payment in your wallet…");
                  return send(client!, { ...payg_(), functionName: "payWithQIE", args: [plan.id, minOut, deadline], value: wei });
                }, `Paid ${formatEther(parseEther(qieAmount))} QIE.`)
              }
            >
              {busy ?? `Pay ${qieAmount || 0} QIE`}
            </button>
          ) : (
            <Connect why="Connect a wallet to pay." />
          )}
        </>
      )}
      <Feedback err={err} done={done} />
    </div>
  );
}

function Feedback({ err, done }: { err: string | null; done: { msg: string; hash: string } | null }) {
  if (err) return <p className="note note-err" role="alert">{err}</p>;
  if (done)
    return (
      <p className="note note-ok" role="status">
        {done.msg} <a href={explorerTx(done.hash)}>View transaction</a>
      </p>
    );
  return null;
}
