import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
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
        if (DEMO_KIT > 0n) readKitStatus(DEMO_KIT).then(setDemo).catch(() => {});
        const [s, d] = await Promise.all([readStats(), qusdcDecimals()]);
        setStats({ ...s, d });
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
            <span className="line">Sell solar on credit.</span>
            <span className="line">Get paid the moment your customer pays.</span>
          </h1>
          <p className="lede">
            Your customers keep paying the way they do now: cash or mobile money, to you or a local agent. Imole settles each
            payment on QIE in seconds, switches the kit on (even where the home has no internet), and gives your customers
            guarantees you can't break.
          </p>
          <div className="cta-row">
            <Link to="/installer" className="btn btn-primary">List your first kit</Link>
            <Link to="/agent" className="btn btn-ghost">Top up a customer's kit</Link>
          </div>
          <form className="lookup" onSubmit={go}>
            <label htmlFor="kit">Have a kit? Enter its number</label>
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
          ) : deployed && DEMO_KIT > 0n ? (
            <Meter kitId={DEMO_KIT} active={false} owned={false} secondsLeft={0n} percentPaid={0} loading
              caption="Live from QIE Mainnet. This is the demo kit wired to the controller." />
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
          {demo && !demo.active && demo.percentPaid < 100 && (
            <Link to={`/kit/${DEMO_KIT}`} className="locked-cta">
              Demo kit is locked: its paid time ran out. Pay 1 QIE to switch it back on.
            </Link>
          )}
        </div>
      </section>

      <section className="band">
        <h2>How it works for an installer</h2>
        <ol className="steps">
          <li>
            <h3>You install the kit and list it</h3>
            <p>Panels, battery and inverter go on QIE as a kit NFT, with a fixed price and a weekly amount. Takes two minutes.</p>
          </li>
          <li>
            <h3>The customer verifies once and accepts</h3>
            <p>An ID check through QIE Pass or in person by your field agent. Only a hash goes on-chain.</p>
          </li>
          <li>
            <h3>They pay any way they can</h3>
            <p>
              Cash or mobile money to you or an agent, who tops up in one tap. Or QUSDC or QIE straight from the kit's page, from
              family anywhere.
            </p>
          </li>
          <li>
            <h3>The kit switches on, online or off</h3>
            <p>
              Connected kits read the chain. Off-grid kits take a 12-digit code that only covers time already paid. The last payment
              hands the kit to the customer.
            </p>
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

      <section className="world">
        <p className="world-num">720 million</p>
        <p className="world-text">
          people still had no electricity in 2025, most of them in sub-Saharan Africa, South Asia and island
          communities. Imole gives any installer, in any country, the same pay-as-you-go tools the big solar companies
          built for themselves.
        </p>
        <p className="muted small">Source: <a href="https://www.iea.org/commentaries/a-record-number-of-people-in-africa-gained-electricity-access-in-2025">IEA, 2026</a></p>
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
