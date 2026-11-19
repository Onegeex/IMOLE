import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Meter } from "../components/Meter";
import { DEMO_KIT, deployed } from "../config";
import { qusdcDecimals, readKitStatus, readStats } from "../chain";
import { useCountUp, usePowerMood } from "../motion";
import { formatUnits } from "viem";

type Stats = Awaited<ReturnType<typeof readStats>> & { d: number };

export function Home() {
  const nav = useNavigate();
  const [demo, setDemo] = useState<Awaited<ReturnType<typeof readKitStatus>> | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [kitInput, setKitInput] = useState("");

  useEffect(() => {
    if (!deployed) return;
    const load = async () => {
      try {
        const [s, d] = await Promise.all([readStats(), qusdcDecimals()]);
        setStats({ ...s, d });
        if (DEMO_KIT > 0n) setDemo(await readKitStatus(DEMO_KIT));
      } catch {
        /* RPC hiccup: keep the last good values */
      }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  usePowerMood(demo ? (demo.percentPaid >= 100 ? "owned" : demo.active ? "on" : "off") : null);

  const go = (e: FormEvent) => {
    e.preventDefault();
    if (/^\d+$/.test(kitInput.trim())) nav(`/kit/${kitInput.trim()}`);
  };

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h1 className="hero-title">
            <span className="line">Pay for light a week at a time.</span>
            <span className="line">Own the solar kit at the end.</span>
          </h1>
          <p className="lede">
            Imole lets solar installers sell kits on credit. Each payment on QIE buys days of power. The kit's
            controller switches off when the time runs out, and unlocks for good once the kit is paid off.
          </p>
          <form className="lookup" onSubmit={go}>
            <label htmlFor="kit">Pay for a kit</label>
            <div className="lookup-row">
              <input
                id="kit"
                inputMode="numeric"
                placeholder="Kit number, e.g. 3"
                value={kitInput}
                onChange={(e) => setKitInput(e.target.value)}
              />
              <button className="btn">Open kit</button>
            </div>
          </form>
        </div>
        <div className="hero-meter">
          {demo ? (
            <Meter
              kitId={DEMO_KIT}
              active={demo.active}
              owned={demo.percentPaid >= 100}
              secondsLeft={demo.secondsLeft}
              percentPaid={demo.percentPaid}
              caption="Live from QIE Mainnet. This is the demo kit wired to the controller."
            />
          ) : (
            <Meter
              kitId={7n}
              active
              owned={false}
              secondsLeft={BigInt(4 * 86400 + 6 * 3600 + 12 * 60)}
              percentPaid={35}
              caption="Example reading."
            />
          )}
        </div>
      </section>

      <section className="band">
        <h2>How a kit gets paid off</h2>
        <ol className="steps">
          <li>
            <h3>The installer fits the kit and lists it</h3>
            <p>Panels, battery and inverter are recorded on QIE as a kit NFT, with a fixed price and a weekly amount.</p>
          </li>
          <li>
            <h3>The customer verifies once and accepts</h3>
            <p>An ID check through QIE Pass, or in person by the installer's field agent. Only a hash goes on-chain.</p>
          </li>
          <li>
            <h3>Anyone pays, in QUSDC or QIE</h3>
            <p>
              The customer, or a relative in London or Houston, pays from the kit's page. QIE is swapped on QIEDEX and
              checked against the QIE Oracle.
            </p>
          </li>
          <li>
            <h3>The last payment hands over the kit</h3>
            <p>The NFT moves to the customer's wallet and the controller stays on for good.</p>
          </li>
        </ol>
      </section>

      <section className="split">
        <div>
          <h2>Rules the installer can't break</h2>
          <p className="muted">These are enforced by the contract. Tested on mainnet, with the refused transactions linked in the project README.</p>
        </div>
        <ul className="rules">
          <li>A customer who is paid up can't be switched off. Power state comes from payments alone.</li>
          <li>Price and terms are fixed the moment the customer accepts.</li>
          <li>The kit can only be taken back once the customer is overdue by the period agreed at signing, 30 days by default.</li>
          <li>Once paid off, nobody can lock the kit again, the installer included.</li>
        </ul>
      </section>

      {stats && (
        <section className="stats" aria-label="Network numbers">
          <h2>On QIE Mainnet so far</h2>
          <dl>
            <div>
              <dt>Paid toward kits</dt>
              <dd><Count value={Number(formatUnits(stats.volume, stats.d))} decimals={2} /> QUSDC</dd>
            </div>
            <div>
              <dt>Payments</dt>
              <dd><Count value={Number(stats.payments)} /></dd>
            </div>
            <div>
              <dt>People paying</dt>
              <dd><Count value={Number(stats.payers)} /></dd>
            </div>
            <div>
              <dt>Kits listed</dt>
              <dd><Count value={Number(stats.kits)} /></dd>
            </div>
            <div>
              <dt>Kits paid off</dt>
              <dd><Count value={Number(stats.paidOff)} /></dd>
            </div>
          </dl>
        </section>
      )}
    </>
  );
}

function Count({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const v = useCountUp(value);
  return <span className="num">{v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</span>;
}
