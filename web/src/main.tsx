import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import { WalletProvider } from "./wallet";
import { Shell } from "./components/Shell";
import { Home } from "./pages/Home";
import { KitPage } from "./pages/KitPage";
import { Installer } from "./pages/Installer";
import { Mine } from "./pages/Mine";
import { Agent } from "./pages/Agent";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WalletProvider>
      <HashRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/kit/:id" element={<KitPage />} />
            <Route path="/installer" element={<Installer />} />
            <Route path="/mine" element={<Mine />} />
            <Route path="/agent" element={<Agent />} />
            <Route path="*" element={<p className="empty">That page doesn't exist. Go back to the home page to find a kit.</p>} />
          </Routes>
        </Shell>
      </HashRouter>
    </WalletProvider>
  </React.StrictMode>,
);
