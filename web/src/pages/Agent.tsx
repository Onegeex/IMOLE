import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { parseUnits, type Address } from "viem";
import { Connect, short } from "../components/Shell";
import { UnlockCode } from "../components/UnlockCode";
import { RefillFloat } from "../components/RefillFloat";
import { ADDR, deployed, erc20Abi, explorerTx, publicClient } from "../config";
import {
  explain, fmtUsd, humanDuration, payg_, periodName, qusdcDecimals, readKit, readPlan, send, type Plan,
} from "../chain";
import { useWallet } from "../wallet";

/** Currencies agents commonly take cash or mobile money in. Rates are units per 1 USD. */
const CURRENCIES = ["NGN", "KES", "GHS", "UGX", "TZS", "ZAR", "XOF", "INR", "BDT", "PKR", "PHP", "IDR", "HTG", "USD", "EUR", "GBP"];

/**
 * Agent top-up: the customer pays an agent (or the installer) in cash or mobile money, the way
 * they already do. The agent tops up the kit from their own QUSDC float in one tap and hands
 * the customer the kit's unlock code. The customer never needs a wallet.
 */
export function Agent() {
  const { account, client } = useWallet();
  const [kitInput, setKitInput] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [d, setD] = useState(6);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const [currency, setCurrency] = useState("NGN");
  const [local, setLocal] = useState("");
  const [rates, setRates] = useState<Record<string, number> | null>(null);
  const [ratesFailed, setRatesFailed] = useState(false);
  const [float, setFloat] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: string; amount: bigint } | null>(null);
  const [refills, setRefills] = useState(0);

  useEffect(() => {
    fetch("https://open.er-api.com/v6/latest/USD")
      .then((r) => r.json())
      .then((j) => (j.rates ? setRates(j.rates) : setRatesFailed(true)))
      .catch(() => setRatesFailed(true));
    qusdcDecimals().then(setD).catch(() => {});
  }, []);

  useEffect(() => {
    if (!account) return;
    publicClient
      .readContract({ address: ADDR.qusdc, abi: erc20Abi, functionName: "balanceOf", args: [account] })
      .then(setFloat)
      .catch(() => setFloat(null));
  }, [account, done, refills]);

  const lookup = async (e?: FormEvent) => {
    e?.preventDefault();
    setLookupErr(null);
    setPlan(null);
    setDone(null);
    if (!/^\d+$/.test(kitInput.trim())) return setLookupErr("Enter the number printed on the kit's controller.");
    try {
      const kit = await readKit(BigInt(kitInput.trim()));
      if (/^0x0{40}$/i.test(kit.installer)) return setLookupErr(`There's no kit ${kitInput.trim()} on Imole.`);
      setPlan(await readPlan(kit.currentPlan));
    } catch {
      setLookupErr("Couldn't reach QIE Mainnet. Try again in a moment.");
    }
  };

  const rate = currency === "USD" ? 1 : rates?.[currency];
  const usd = useMemo(() => {
    const n = Number(local.replace(/,/g, ""));
    if (!rate || !isFinite(n) || n <= 0) return null;
    return n / rate;
  }, [local, rate]);

  const remaining = plan ? plan.terms.price - plan.totalPaid : 0n;
  const amount = useMemo(() => {
    if (usd === null) return 0n;
    const a = parseUnits(usd.toFixed(d), d);
    return a > remaining ? remaining : a;
  }, [usd, d, remaining]);
  const buys = plan && amount > 0n ? humanDuration((Number(amount) * plan.terms.period) / Number(plan.terms.installment)) : null;

  const topUp = async () => {
    if (!plan || !client || !account) return;
    setErr(null);
    setDone(null);
    try {
      const allowance = await publicClient.readContract({
        address: ADDR.qusdc, abi: erc20Abi, functionName: "allowance", args: [account, ADDR.payg as Address],
      });
      if (allowance < amount) {
        setBusy("Approve QUSDC in your wallet…");
        await send(client, { address: ADDR.qusdc, abi: erc20Abi, functionName: "approve", args: [ADDR.payg as Address, amount] });
      }
      setBusy("Confirm the top-up in your wallet…");
      const hash = await send(client, { ...payg_(), functionName: "pay", args: [plan.id, amount] });
      setDone({ hash, amount });
      setPlan(await readPlan(plan.id));
    } catch (e) {
      setErr(explain(e));
    } finally {
      setBusy(null);
    }
  };

  if (!deployed) return <p className="empty">Contracts aren't configured for this build.</p>;

  return (
    <div className="agent">
      <section className="agent-intro">
        <h1>Top up a customer's kit</h1>
        <p className="lede">
          Your customer pays you in cash or mobile money, as they do today. You top up their kit from your QUSDC float
          and give them the code for their keypad. They never need a wallet.
        </p>
      </section>

      <div className="agent-grid">
        <div className="panel">
          <form className="lookup" onSubmit={lookup}>
            <label htmlFor="agent-kit">Kit number</label>
            <div className="lookup-row">
              <input id="agent-kit" inputMode="numeric" placeholder="e.g. 1" value={kitInput} onChange={(e) => setKitInput(e.target.value)} />
              <button className="btn">Find kit</button>
            </div>
          </form>
          {lookupErr && <p className="note note-err">{lookupErr}</p>}

          {plan && plan.status !== "Active" && (
            <p className="note note-err">
              {plan.status === "PaidOff"
                ? "This kit is already paid off. Nothing to top up."
                : plan.status === "Pending"
                  ? "The customer hasn't accepted this plan yet. They accept once, with the installer, before top-ups work."
                  : "This kit has no active plan."}
            </p>
          )}

          {plan && plan.status === "Active" && (
            <>
              <dl className="facts compact">
                <div><dt>Customer</dt><dd>{short(plan.customer)}</dd></div>
                <div><dt>Rate</dt><dd>{fmtUsd(plan.terms.installment, d)} QUSDC per {periodName(plan.terms.period)}</dd></div>
                <div><dt>Left to pay</dt><dd>{fmtUsd(remaining, d)} QUSDC</dd></div>
              </dl>

              <div className="cash-row">
                <label className="field">
                  <span>Cash received</span>
                  <input inputMode="decimal" placeholder="0" value={local} onChange={(e) => setLocal(e.target.value.replace(/[^\d.,]/g, ""))} />
                </label>
                <label className="field">
                  <span>Currency</span>
                  <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                    {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </label>
              </div>
              <p className="sum">
                <strong>{amount > 0n ? `${fmtUsd(amount, d)} QUSDC` : "—"}</strong>
                <span>
                  {!rate ? (ratesFailed ? "Couldn't load exchange rates. Choose USD and enter the US dollar amount." : "Loading exchange rate…") : buys ? `adds ${buys} of power` : `at ${rate.toLocaleString()} ${currency} per US$1`}
                </span>
              </p>

              {!account ? (
                <Connect why="Connect the wallet that holds your QUSDC float." />
              ) : (
                <>
                  <p className="muted small">Your float: {float === null ? "…" : `${fmtUsd(float, d)} QUSDC`}</p>
                  <button className="btn btn-primary" disabled={!!busy || amount === 0n || (float !== null && float < amount)} onClick={topUp}>
                    {busy ?? (float !== null && float < amount ? "Not enough QUSDC in your float" : `Top up kit ${plan.kitId}`)}
                  </button>
                </>
              )}
              {account && <RefillFloat d={d} onDone={() => setRefills((n) => n + 1)} />}
              {err && <p className="note note-err" role="alert">{err}</p>}
              {done && (
                <p className="note note-ok" role="status">
                  Topped up {fmtUsd(done.amount, d)} QUSDC. <a href={explorerTx(done.hash)}>View transaction</a>
                </p>
              )}
            </>
          )}
        </div>

        <div className="panel">
          {plan ? (
            <UnlockCode kitId={plan.kitId} auto={!!done} refreshKey={done ? 1 : 0} />
          ) : (
            <div className="unlock">
              <h3>Code for the kit's keypad</h3>
              <p className="muted">Find a kit first. After a top-up, its new code appears here to give the customer by voice, paper or SMS.</p>
            </div>
          )}
        </div>
      </div>

      <p className="muted small">
        Exchange rates from open.er-api.com, for display only. You're paying in QUSDC from your own float; agree your cash price with the
        customer as you would for airtime. <Link to="/installer">Installers</Link> receive 99% of every top-up instantly.
      </p>
    </div>
  );
}
