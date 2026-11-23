import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Meter } from "../components/Meter";
import { Icon } from "../components/Shell";
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
      <header className="title-block hero-copy">
        <h1 className="hero-title">
          <span className="line">Sell solar on credit.</span>
          <span className="line">Get paid the moment your customer pays.</span>
        </h1>
        <p className="lede">
          Your customers keep paying the way they do now: cash or mobile money, to you or a local agent. Imole settles each payment
          on QIE in seconds, switches the kit on (even where the home has no internet), and gives your customers guarantees you
          can't break.
        </p>
      </header>

      <section className="home-top">
        <div className="hero-meter">
          {demo ? (
            <Meter
              kitId={DEMO_KIT}
              active={demo.active}
              owned={demo.percentPaid >= 100}
              secondsLeft={demo.secondsLeft}
              percentPaid={demo.percentPaid}
              caption="Live from QIE Mainnet. The demo kit wired to the controller."
            />
          ) : deployed && DEMO_KIT > 0n ? (
            <Meter kitId={DEMO_KIT} active={false} owned={false} secondsLeft={0n} percentPaid={0} loading
              caption="Live from QIE Mainnet. The demo kit wired to the controller." />
          ) : (
            <Meter kitId={7n} active owned={false} secondsLeft={BigInt(4 * 86400 + 6 * 3600 + 12 * 60)} percentPaid={35} caption="Example reading." />
          )}
          {demo && !demo.active && demo.percentPaid < 100 && (
            <Link to={`/kit/${DEMO_KIT}`} className="locked-cta">
              Demo kit is locked: its paid time ran out. Pay 1 QIE to switch it back on.
            </Link>
          )}
        </div>

        <div className="actions">
          <ul className="group">
            <li>
              <Link to="/installer" className="row row-link">
                <span className="row-icon tint-blue"><Icon name="installer" /></span>
                <span className="row-text"><strong>List your first kit</strong><span>Two minutes, for installers</span></span>
              </Link>
            </li>
            <li>
              <Link to="/agent" className="row row-link">
                <span className="row-icon tint-sun"><Icon name="topup" /></span>
                <span className="row-text"><strong>Top up a customer's kit</strong><span>Cash in, power on</span></span>
              </Link>
            </li>
          </ul>
          <form className="lookup" onSubmit={go}>
            <label htmlFor="kit">Have a kit? Enter its number</label>
            <div className="lookup-row">
              <input id="kit" inputMode="numeric" placeholder="Kit number, e.g. 3" value={kitInput} onChange={(e) => setKitInput(e.target.value)} />
              <button className="btn">Open</button>
            </div>
          </form>
        </div>
      </section>

      <section className="section">
        <h2>How it works for an installer</h2>
        <ol className="group steps">
          <li>
            <h3>You install the kit and list it</h3>
            <p>Panels, battery and inverter go on QIE as a kit NFT, with a fixed price and a weekly amount.</p>
          </li>
          <li>
            <h3>The customer verifies once and accepts</h3>
            <p>An ID check through QIE Pass or in person by your field agent. Only a hash goes on-chain.</p>
          </li>
          <li>
            <h3>They pay any way they can</h3>
            <p>Cash or mobile money to you or an agent, who tops up in one tap. Or QUSDC or QIE from the kit's page, from family anywhere.</p>
          </li>
          <li>
            <h3>The kit switches on, online or off</h3>
            <p>Connected kits read the chain. Off-grid kits take a 12-digit code that only covers time already paid. The last payment hands the kit to the customer.</p>
          </li>
        </ol>
      </section>

      <section className="section cash">
        <h2>Taking cash costs you 1%</h2>
        <p className="section-sub">
          You top up your customer's kit from a small QUSDC float, and the contract sends 99% straight back to you in the same
          transaction. You keep the cash. The customer never sees a wallet.
        </p>
        <div className="ledger group" aria-label="Example: a customer pays 2,000 naira in cash">
          <div><span>Customer hands you</span><strong>₦2,000 cash</strong></div>
          <div><span>You top up their kit from your float</span><strong>−1.48 QUSDC</strong></div>
          <div><span>Back to you, same transaction</span><strong>+1.46 QUSDC</strong></div>
          <div className="ledger-total"><span>Your float after</span><strong>−0.0148 QUSDC, the 1% fee</strong></div>
        </div>
        <p className="group-foot">At ₦1,354 per US$1. A float of a few dollars serves hundreds of top-ups. Shops and kiosks can top up for you too, and keep a margin like they do on airtime.</p>
      </section>

      <section className="section">
        <h2>Rules the installer can't break</h2>
        <ul className="group rules">
          <li>A customer who is paid up can't be switched off. Power state comes from payments alone.</li>
          <li>Price and terms are fixed the moment the customer accepts.</li>
          <li>The kit can only be taken back once the customer is overdue by the period agreed at signing, 30 days by default.</li>
          <li>Once paid off, nobody can lock the kit again, the installer included.</li>
        </ul>
        <p className="group-foot">Enforced by the contract. Tested on mainnet, with the refused transactions linked in the project README.</p>
      </section>

      <section className="section widgets">
        <div className="widget world">
          <p className="world-num">720 million</p>
          <p className="world-text">
            people still had no electricity in 2025, most of them in sub-Saharan Africa, South Asia and island communities. Imole
            gives any installer, in any country, the same pay-as-you-go tools the big solar companies built for themselves.
          </p>
          <p className="muted small">Source: <a href="https://www.iea.org/commentaries/a-record-number-of-people-in-africa-gained-electricity-access-in-2025">IEA, 2026</a></p>
        </div>
      </section>

      {stats && (
        <section className="section stats" aria-label="Network numbers">
          <h2>On QIE Mainnet so far</h2>
          <dl>
            <div className="widget"><dt>Paid toward kits</dt><dd><Count value={Number(formatUnits(stats.volume, stats.d))} decimals={2} /> <small>QUSDC</small></dd></div>
            <div className="widget"><dt>Payments</dt><dd><Count value={Number(stats.payments)} /></dd></div>
            <div className="widget"><dt>People paying</dt><dd><Count value={Number(stats.payers)} /></dd></div>
            <div className="widget"><dt>Kits listed</dt><dd><Count value={Number(stats.kits)} /></dd></div>
            <div className="widget"><dt>Kits paid off</dt><dd><Count value={Number(stats.paidOff)} /></dd></div>
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
