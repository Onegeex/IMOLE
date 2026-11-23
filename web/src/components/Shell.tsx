import { Link, NavLink, useLocation } from "react-router-dom";
import { useEffect, useState, type ReactNode } from "react";
import { useWallet } from "../wallet";
import { ADDR, deployed, explorerAddr } from "../config";

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/* Line icons drawn on a 24px grid, in the spirit of SF Symbols. */
const icons = {
  home: <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z" />,
  topup: <><circle cx="12" cy="12" r="8.5" /><path d="M13 7.5 9.5 12.5h3.5L11 16.5" /></>,
  kits: <><circle cx="12" cy="12" r="3.6" /><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6" /></>,
  installer: <><path d="M14.5 6.5a3.5 3.5 0 0 0 4.4 4.4l-7.8 7.8a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8a3.5 3.5 0 0 0-1.9-1.9z" /><path d="M17.5 3.5 15 6l.6 2.4L18 9l2.5-2.5" /></>,
};
type IconName = keyof typeof icons;
export const Icon = ({ name }: { name: IconName }) => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {icons[name]}
  </svg>
);

const tabs: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: "/", label: "Home", icon: "home", end: true },
  { to: "/agent", label: "Top up", icon: "topup" },
  { to: "/mine", label: "My kits", icon: "kits" },
  { to: "/installer", label: "Installers", icon: "installer" },
];

function titleFor(path: string) {
  if (path.startsWith("/kit/")) return `Kit ${path.split("/")[2]}`;
  return { "/agent": "Top up", "/mine": "My kits", "/installer": "Installers" }[path] ?? "Imole";
}

const SunMark = ({ size = 28 }: { size?: number }) => (
  <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
    <circle cx="16" cy="16" r="7" fill="var(--sun)" />
    {[0, 45, 90, 135, 180, 225, 270, 315].map((r) => (
      <rect key={r} x="15" y="2" width="2" height="5" rx="1" fill="var(--sun)" transform={`rotate(${r} 16 16)`} />
    ))}
  </svg>
);

function WalletButton({ compact = false }: { compact?: boolean }) {
  const { account, connect, connecting, walletName } = useWallet();
  if (account)
    return (
      <span className="acct" title={walletName ?? ""}>
        <span className="acct-dot" aria-hidden="true" />
        {short(account)}
      </span>
    );
  return (
    <button className={compact ? "btn btn-small" : "btn btn-tinted"} onClick={connect} disabled={connecting}>
      {connecting ? "Connecting…" : compact ? "Connect" : "Connect wallet"}
    </button>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { error } = useWallet();
  const { pathname } = useLocation();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 48);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useEffect(() => window.scrollTo(0, 0), [pathname]);

  return (
    <div className="app">
      <div className="sky" aria-hidden="true">
        <span className="sky-sun" />
        <span className="sky-grid" />
        <span className="sky-sweep" />
      </div>

      <aside className="sidebar" aria-label="Imole">
        <Link to="/" className="brand">
          <span className="app-icon"><SunMark size={26} /></span>
          Imole
        </Link>
        <nav className="side-nav">
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end}>
              <Icon name={t.icon} />
              {t.label}
            </NavLink>
          ))}
        </nav>
        <div className="side-foot">
          <WalletButton />
          <p>Runs on QIE Mainnet. Payments settle in QUSDC straight to the installer, with a 1% network fee.</p>
          <p className="foot-links">
            {import.meta.env.VITE_REPO_URL && <a href={import.meta.env.VITE_REPO_URL}>Source code</a>}
            {ADDR.payg && <a href={explorerAddr(ADDR.payg)}>Contract</a>}
          </p>
        </div>
      </aside>

      <div className="main-col">
        <header className={`navbar${scrolled ? " is-scrolled" : ""}`}>
          <Link to="/" className="navbar-brand" aria-label="Imole home"><SunMark size={24} /></Link>
          <span className="navbar-title">{titleFor(pathname)}</span>
          <WalletButton compact />
        </header>
        {error && <p className="banner banner-err">{error}</p>}
        {!deployed && (
          <p className="banner">Contracts aren't configured for this build yet. Set VITE_PAYG and VITE_KYC to the mainnet addresses.</p>
        )}
        <main className="page" key={pathname}>{children}</main>
        <footer className="foot">
          <p>Imole runs on QIE Mainnet. Payments settle in QUSDC straight to the installer, with a 1% network fee.</p>
          <p className="foot-links">
            {import.meta.env.VITE_REPO_URL && <a href={import.meta.env.VITE_REPO_URL}>Source code</a>}
            {ADDR.payg && <a href={explorerAddr(ADDR.payg)}>Contract on the QIE explorer</a>}
          </p>
        </footer>
      </div>

      <nav className="tabbar" aria-label="Sections">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end}>
            <Icon name={t.icon} />
            <span>{t.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export function Connect({ why }: { why: string }) {
  const { connect, connecting } = useWallet();
  return (
    <div className="empty unavailable">
      <span className="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="6" width="18" height="13" rx="3" /><path d="M3 10h18M16 14.5h2" /><path d="M6 6V5a2 2 0 0 1 2-2h8" />
        </svg>
      </span>
      <h2>Connect QIE Wallet</h2>
      <p>{why}</p>
      <button className="btn" onClick={connect} disabled={connecting}>
        {connecting ? "Connecting…" : "Connect"}
      </button>
    </div>
  );
}
