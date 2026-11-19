import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { isAddress, keccak256, toHex, type Address } from "viem";
import { Connect, short } from "../components/Shell";
import { ADDR, deployed, explorerTx, publicClient } from "../config";
import { ImoleKYCAbi } from "../abi/ImoleKYC";
import {
  explain, fmtUsd, isAttester, payg_, plansOf, qusdcDecimals, readInstaller, readKitStatus, readPlan, send, toUnits,
  type Plan,
} from "../chain";
import { useWallet } from "../wallet";

type Row = Plan & { active: boolean };

const PERIODS = [
  { label: "Week", sec: 604800 },
  { label: "Day", sec: 86400 },
  { label: "30 days", sec: 2592000 },
  { label: "10 minutes (demo kits)", sec: 600 },
];

export function Installer() {
  const { account, client } = useWallet();
  const [profile, setProfile] = useState<Awaited<ReturnType<typeof readInstaller>> | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [attester, setAttester] = useState(false);
  const [d, setD] = useState(6);
  const [chainNow, setChainNow] = useState(Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<{ msg: string; hash?: string } | null>(null);
  const [keyFor, setKeyFor] = useState<{ kit: bigint; key: string } | null>(null);

  const load = useCallback(async () => {
    if (!account || !deployed) return;
    const [p, dec, att] = await Promise.all([readInstaller(account), qusdcDecimals(), isAttester(account)]);
    setProfile(p);
    setD(dec);
    setAttester(att);
    setChainNow(Number((await publicClient.getBlock()).timestamp));
    if (p.registered) {
      const ids = await plansOf("installer", account);
      const plans = await Promise.all(ids.map(readPlan));
      const withPower = await Promise.all(plans.map(async (pl) => ({ ...pl, active: (await readKitStatus(pl.kitId)).active })));
      setRows(withPower.reverse());
    }
  }, [account]);

  useEffect(() => {
    load().catch(() => setErr("Couldn't read your installer account from QIE Mainnet. Reload to try again."));
  }, [load]);

  const act = async (fn: () => Promise<string>, msg: string) => {
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      const hash = await fn();
      setOk({ msg, hash });
      await load();
    } catch (e) {
      setErr(explain(e));
    } finally {
      setBusy(false);
    }
  };

  if (!deployed) return <p className="empty">Contracts aren't configured for this build.</p>;
  if (!account) return <Connect why="Installers sign in with the wallet that receives their customers' payments." />;
  if (!profile) return <p className="empty">Reading your account…</p>;

  if (!profile.registered) {
    return (
      <section className="narrow">
        <h1>Sell solar kits on credit</h1>
        <p className="lede">
          List each kit you install with a price and a weekly amount. Customers' payments land in this wallet as QUSDC,
          minus a 1% network fee, and the kit switches itself off when they fall behind.
        </p>
        <form
          className="form"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const name = new FormData(e.currentTarget).get("name") as string;
            act(() => send(client!, { ...payg_(), functionName: "registerInstaller", args: [name.trim()] }), "You're registered.");
          }}
        >
          <label className="field">
            <span>Business name</span>
            <input name="name" required maxLength={60} placeholder="e.g. Sunrise Solar Co." />
          </label>
          <button className="btn" disabled={busy}>{busy ? "Registering…" : "Register as an installer"}</button>
        </form>
        <Notes err={err} ok={ok} />
      </section>
    );
  }

  return (
    <div className="installer">
      <section className="inst-head">
        <h1>{profile.name}</h1>
        <p className="muted">
          {profile.verified ? "Verified business. " : ""}
          {profile.plans} plan{profile.plans === 1 ? "" : "s"} listed, {fmtUsd(profile.collected, d)} QUSDC collected.
        </p>
      </section>

      <Notes err={err} ok={ok} />

      <section>
        <h2>Your kits</h2>
        {rows.length === 0 ? (
          <p className="muted">No kits yet. List the first one below once it's installed.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Kit</th><th>Customer</th><th>Status</th><th>Power</th><th>Paid</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const overdue = r.status === "Active" && chainNow > r.paidUntil + r.terms.repossessAfter;
                  return (
                    <tr key={r.id.toString()}>
                      <td><Link to={`/kit/${r.kitId}`}>Kit {r.kitId.toString()}</Link></td>
                      <td>{short(r.customer)}</td>
                      <td>{r.status === "PaidOff" ? "Paid off" : r.status === "Pending" ? "Waiting to accept" : r.status}</td>
                      <td><span className={`dot ${r.active ? "dot-on" : ""}`} />{r.active ? "On" : "Off"}</td>
                      <td>{fmtUsd(r.totalPaid, d)} / {fmtUsd(r.terms.price, d)}</td>
                      <td>
                        {r.status === "Pending" && (
                          <button className="link" disabled={busy}
                            onClick={() => act(() => send(client!, { ...payg_(), functionName: "cancelPlan", args: [r.id] }), `Plan for kit ${r.kitId} cancelled.`)}>
                            Cancel
                          </button>
                        )}
                        {(r.status === "Active" || r.status === "Pending") && (
                          <button className="link" disabled={busy}
                            onClick={() => act(async () => {
                              const signature = await client!.signMessage({ account: account!, message: `Imole device key for kit ${r.kitId}` });
                              const res = await fetch("/api/device-key", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kit: r.kitId.toString(), signature }) });
                              const j = await res.json();
                              if (!res.ok) throw new Error(j.error || "Couldn't get the controller key.");
                              setKeyFor({ kit: r.kitId, key: j.deviceKey });
                              return "";
                            }, `Controller key for kit ${r.kitId} is below. Flash it into the kit's controller as DEVICE_KEY_HEX.`)}>
                            Controller key
                          </button>
                        )}
                        {overdue && (
                          <button className="link link-danger" disabled={busy}
                            onClick={() => act(() => send(client!, { ...payg_(), functionName: "repossess", args: [r.id] }), `Kit ${r.kitId} is back in your wallet.`)}>
                            Take kit back
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {keyFor && (
        <section className="panel">
          <h2>Controller key for kit {keyFor.kit.toString()}</h2>
          <p className="muted">
            Set this as <code>DEVICE_KEY_HEX</code> and <code>KIT_ID = {keyFor.kit.toString()}</code> in the controller firmware before you
            install it. Keep it private: it lets the controller check unlock codes for this kit.
          </p>
          <p className="unlock-code key">{keyFor.key}</p>
          <button className="btn btn-small" onClick={() => navigator.clipboard?.writeText(keyFor.key)}>Copy key</button>
        </section>
      )}

      {attester && <VerifyCustomer busy={busy} act={act} />}

      <ListKit d={d} busy={busy} act={act} self={account} />
    </div>
  );
}

function ListKit({ d, busy, act, self }: { d: number; busy: boolean; act: (f: () => Promise<string>, m: string) => void; self: Address }) {
  const { client } = useWallet();
  const [period, setPeriod] = useState(604800);
  const demo = period === 600;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const g = (k: string) => String(f.get(k) ?? "").trim();
    const customer = g("customer");
    if (!isAddress(customer) || customer.toLowerCase() === self.toLowerCase()) {
      act(async () => { throw new Error("Enter the customer's own wallet address, not yours."); }, "");
      return;
    }
    const graceSec = demo ? 120 : Math.round(Number(g("grace")) * 86400);
    const repoSec = demo ? 3600 : Math.round(Number(g("repo")) * 86400);
    const specs = { panelWatts: Number(g("w")), batteryWh: Number(g("wh")), inverterVA: Number(g("va")), location: g("loc") };
    const terms = {
      price: toUnits(g("price"), d), deposit: toUnits(g("deposit"), d), installment: toUnits(g("inst"), d),
      period, grace: graceSec, repossessAfter: repoSec, requireKyc: f.get("kyc") === "on",
    };
    act(() => send(client!, { ...payg_(), functionName: "listKit", args: [customer as Address, specs, terms] }), "Kit listed. Send the customer the kit's page so they can accept.");
  };

  return (
    <section>
      <h2>List an installed kit</h2>
      <form className="form grid" onSubmit={submit}>
        <fieldset>
          <legend>Customer and kit</legend>
          <label className="field wide"><span>Customer's wallet address</span><input name="customer" required placeholder="0x…" /></label>
          <label className="field wide"><span>Town or area (no street address)</span><input name="loc" required maxLength={40} placeholder="e.g. Kisumu, Kenya" /></label>
          <label className="field"><span>Panels (W)</span><input name="w" type="number" min="1" required defaultValue="1200" /></label>
          <label className="field"><span>Battery (Wh)</span><input name="wh" type="number" min="1" required defaultValue="2400" /></label>
          <label className="field"><span>Inverter (VA)</span><input name="va" type="number" min="1" required defaultValue="1500" /></label>
        </fieldset>
        <fieldset>
          <legend>Terms, in QUSDC</legend>
          <label className="field"><span>Full price</span><input name="price" inputMode="decimal" required defaultValue={demo ? "1" : "450"} /></label>
          <label className="field"><span>Deposit</span><input name="deposit" inputMode="decimal" required defaultValue={demo ? "0" : "45"} /></label>
          <label className="field"><span>Amount per period</span><input name="inst" inputMode="decimal" required defaultValue={demo ? "0.05" : "9"} /></label>
          <label className="field">
            <span>Period</span>
            <select value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
              {PERIODS.map((p) => <option key={p.sec} value={p.sec}>{p.label}</option>)}
            </select>
          </label>
          {!demo && (
            <>
              <label className="field"><span>Grace (days)</span><input name="grace" type="number" min="0" step="0.5" defaultValue="2" /></label>
              <label className="field"><span>Take back after overdue (days)</span><input name="repo" type="number" min="7" defaultValue="30" /></label>
            </>
          )}
          {demo && <p className="muted small wide">Demo kits get 2 minutes of grace and can be taken back after 1 hour overdue.</p>}
          <label className="check wide"><input type="checkbox" name="kyc" defaultChecked /> Require an ID check before the customer can accept</label>
        </fieldset>
        <button className="btn" disabled={busy}>{busy ? "Listing…" : "List kit"}</button>
      </form>
    </section>
  );
}

function VerifyCustomer({ busy, act }: { busy: boolean; act: (f: () => Promise<string>, m: string) => void }) {
  const { client } = useWallet();
  return (
    <section>
      <h2>Record a customer's ID check</h2>
      <p className="muted">
        For customers checked in person. Only a hash of your reference goes on-chain, never their name or ID number.
      </p>
      <form
        className="form inline"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const who = String(f.get("who")).trim();
          const ref = keccak256(toHex(String(f.get("ref")).trim()));
          if (!isAddress(who)) return act(async () => { throw new Error("That isn't a valid wallet address."); }, "");
          act(() => send(client!, { address: ADDR.kyc as Address, abi: ImoleKYCAbi, functionName: "attest", args: [who, 2, ref] }), "Customer verified.");
        }}
      >
        <label className="field"><span>Customer wallet</span><input name="who" required placeholder="0x…" /></label>
        <label className="field"><span>Your reference</span><input name="ref" required placeholder="Form number or visit ID" /></label>
        <button className="btn" disabled={busy}>Record ID check</button>
      </form>
    </section>
  );
}

function Notes({ err, ok }: { err: string | null; ok: { msg: string; hash?: string } | null }) {
  if (err) return <p className="note note-err" role="alert">{err}</p>;
  if (ok?.msg) return <p className="note note-ok" role="status">{ok.msg} {ok.hash && <a href={explorerTx(ok.hash)}>View transaction</a>}</p>;
  return null;
}
