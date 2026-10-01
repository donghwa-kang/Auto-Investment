import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { PortfolioApp } from "./PortfolioApp.js";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {new URLSearchParams(location.search).get("view") === "portfolio" ? (
      <PortfolioApp />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
