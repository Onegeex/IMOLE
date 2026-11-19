import { Link, NavLink } from "react-router-dom";
import type { ReactNode } from "react";
import { useWallet } from "../wallet";
import { ADDR, deployed, explorerAddr } from "../config";

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function Shell({ children }: { children: ReactNode }) {
  const { account, connect, connecting, error, walletName } = useWallet();
  return (
    <>
      <div className="sky" aria-hidden="true">
        <span className="sky-sun" />
        <span className="sky-grid" />
        <span className="sky-sweep" />
      </div>
      <header className="top">
        <Link to="/" className="logo">
          <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
            <circle cx="16" cy="16" r="7" fill="var(--sun)" />
            {[0, 45, 90, 135, 180, 225, 270, 315].map((r) => (
              <rect key={r} x="15" y="2" width="2" height="5" rx="1" fill="var(--sun)" transform={`rotate(${r} 16 16)`} />
            ))}
          </svg>
          Imole
        </Link>
        <nav>
          <NavLink to="/installer">Installers</NavLink>
          <NavLink to="/agent">Top up</NavLink>
          <NavLink to="/mine">My kits</NavLink>
        </nav>
        {account ? (
          <span className="acct" title={walletName ?? ""}>
            {short(account)}
          </span>
        ) : (
          <button className="btn btn-small" onClick={connect} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
        )}
      </header>
      {error && <p className="banner banner-err">{error}</p>}
      {!deployed && (
        <p className="banner">
          Contracts aren't configured for this build yet. Set VITE_PAYG and VITE_KYC to the mainnet addresses.
        </p>
      )}
      <main>{children}</main>
      <footer className="foot">
        <p>
          Imole runs on QIE Mainnet. Payments settle in QUSDC straight to the installer, with a 1% network fee.
        </p>
        <p className="foot-links">
          {import.meta.env.VITE_REPO_URL && <a href={import.meta.env.VITE_REPO_URL}>Source code</a>}
          {ADDR.payg && <a href={explorerAddr(ADDR.payg)}>Contract on the QIE explorer</a>}
        </p>
      </footer>
    </>
  );
}

export function Connect({ why }: { why: string }) {
  const { connect, connecting } = useWallet();
  return (
    <div className="empty">
      <p>{why}</p>
      <button className="btn" onClick={connect} disabled={connecting}>
        {connecting ? "Connecting…" : "Connect QIE Wallet"}
      </button>
    </div>
  );
}
