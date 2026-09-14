import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import "./styles.css";
import { RepoListPage } from "./pages/RepoListPage.js";
import { RepoDetailPage } from "./pages/RepoDetailPage.js";
import { PrDetailPage } from "./pages/PrDetailPage.js";
import { BlobPage } from "./pages/BlobPage.js";
import { RepoHeaderProvider, useRepoHeaderName } from "./context/repoHeader.js";

function Header() {
  const repoName = useRepoHeaderName();
  return (
    <header className="topbar">
      <h1>
        <Link to="/" className="brand">
          Git Law
        </Link>
        {repoName && (
          <>
            <span className="breadcrumb-sep">/</span>
            <span className="breadcrumb-repo">{repoName}</span>
          </>
        )}
      </h1>
    </header>
  );
}

function App() {
  return (
    <BrowserRouter>
      <RepoHeaderProvider>
        <Header />
        <div className="container">
          <Routes>
            <Route path="/" element={<RepoListPage />} />
            <Route path="/repos/:repoId" element={<RepoDetailPage />} />
            <Route path="/repos/:repoId/blob" element={<BlobPage />} />
            <Route path="/repos/:repoId/prs/:prId" element={<PrDetailPage />} />
          </Routes>
        </div>
      </RepoHeaderProvider>
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
