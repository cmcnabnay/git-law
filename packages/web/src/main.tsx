import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import "./styles.css";
import { RepoListPage } from "./pages/RepoListPage.js";
import { RepoDetailPage } from "./pages/RepoDetailPage.js";
import { PrDetailPage } from "./pages/PrDetailPage.js";
import { BlobPage } from "./pages/BlobPage.js";

function App() {
  return (
    <BrowserRouter>
      <header className="topbar">
        <h1>
          <Link to="/">Git Law</Link>
        </h1>
      </header>
      <div className="container">
        <Routes>
          <Route path="/" element={<RepoListPage />} />
          <Route path="/repos/:repoId" element={<RepoDetailPage />} />
          <Route path="/repos/:repoId/blob" element={<BlobPage />} />
          <Route path="/repos/:repoId/prs/:prId" element={<PrDetailPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
