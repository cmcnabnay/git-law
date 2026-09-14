import { useEffect, useState } from "react";
import { api, type Repo, type LocalStatus, type TreeEntry } from "../api/client.js";
import { formatBytes, timeAgo } from "../format.js";

export function LocalPanel({ repo, onRepoUpdate }: { repo: Repo; onRepoUpdate: (r: Repo) => void }) {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState(repo.local_path ?? "");
  const [linking, setLinking] = useState(false);

  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [commitMessage, setCommitMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const [showCreateBranch, setShowCreateBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [newBranchFrom, setNewBranchFrom] = useState("");

  function loadStatus() {
    setError(null);
    api
      .getLocalStatus(repo.id)
      .then(setStatus)
      .catch((e) => setError(e.message));
  }

  useEffect(loadStatus, [repo.id]);

  useEffect(() => {
    if (!status?.valid || !status.currentBranch) {
      setTree([]);
      return;
    }
    setTreeError(null);
    api
      .getLocalTree(repo.id, status.currentBranch)
      .then(setTree)
      .catch((e) => setTreeError(e.message));
  }, [repo.id, status?.valid, status?.currentBranch]);

  useEffect(() => {
    if (status?.branches?.length && !newBranchFrom) {
      setNewBranchFrom(status.currentBranch ?? status.branches[0].name);
    }
  }, [status]);

  async function handleLink(e: React.FormEvent) {
    e.preventDefault();
    if (!pathInput.trim()) return;
    setLinking(true);
    setError(null);
    try {
      const updated = await api.setLocalPath(repo.id, pathInput.trim());
      onRepoUpdate(updated);
      loadStatus();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLinking(false);
    }
  }

  async function handleCheckout(branch: string) {
    setBusy("checkout");
    setError(null);
    try {
      setStatus(await api.checkoutLocalBranch(repo.id, branch));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleCommit() {
    if (!commitMessage.trim()) return;
    setBusy("commit");
    setError(null);
    try {
      setStatus(await api.commitLocal(repo.id, commitMessage.trim()));
      setCommitMessage("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handlePush() {
    if (!status?.currentBranch) return;
    setBusy("push");
    setError(null);
    try {
      setStatus(await api.pushLocal(repo.id, status.currentBranch));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleSync() {
    setBusy("sync");
    setError(null);
    setSyncMsg(null);
    try {
      const result = await api.syncLocal(repo.id);
      setStatus(result);
      setSyncMsg(
        result.created.length > 0
          ? `Pulled down ${result.created.length} new branch${result.created.length === 1 ? "" : "es"}: ${result.created.join(", ")}`
          : "Already up to date — no new remote branches."
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateBranch(e: React.FormEvent) {
    e.preventDefault();
    if (!newBranchName.trim() || !newBranchFrom) return;
    setBusy("branch");
    setError(null);
    try {
      setStatus(await api.createLocalBranch(repo.id, newBranchName.trim(), newBranchFrom));
      setNewBranchName("");
      setShowCreateBranch(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  if (!status) return <p>Loading...</p>;

  if (!status.linked || !status.valid) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>{status.linked ? "Local clone not found" : "Link a local clone"}</h3>
        {status.linked && status.error && <p style={{ color: "var(--danger)" }}>{status.error}</p>}
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          Enter the absolute path to a clone of this repo on the machine running the Git Law server. Once linked,
          you can add &amp; commit, push, sync new branches, and create branches from here.
        </p>
        <form onSubmit={handleLink} style={{ display: "flex", gap: 8 }}>
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="/home/you/repos/my-repo"
            className="mono"
          />
          <button className="primary" disabled={linking || !pathInput.trim()}>
            {linking ? "Linking…" : status.linked ? "Update path" : "Link"}
          </button>
        </form>
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <div className="repo-toolbar">
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select value={status.currentBranch ?? ""} onChange={(e) => handleCheckout(e.target.value)} disabled={busy !== null}>
            {status.branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>
            {status.dirty ? "uncommitted changes" : "clean"} · <span className="mono">{status.localPath}</span>
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleSync} disabled={busy !== null}>
            {busy === "sync" ? "Syncing…" : "Sync"}
          </button>
          <button onClick={() => setShowCreateBranch((v) => !v)} disabled={busy !== null}>
            Create branch
          </button>
        </div>
      </div>

      {showCreateBranch && (
        <form className="card" onSubmit={handleCreateBranch}>
          <h4 style={{ marginTop: 0 }}>Create a new branch</h4>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ fontSize: 13 }}>
              Branch off of
              <br />
              <select value={newBranchFrom} onChange={(e) => setNewBranchFrom(e.target.value)}>
                {status.branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 13, flex: 1, minWidth: 180 }}>
              New branch name
              <br />
              <input value={newBranchName} onChange={(e) => setNewBranchName(e.target.value)} placeholder="feature-x" />
            </label>
            <button className="primary" disabled={busy !== null || !newBranchName.trim()}>
              {busy === "branch" ? "Creating…" : "Create & switch"}
            </button>
          </div>
        </form>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Commit</h3>
        <textarea
          rows={2}
          placeholder='Commit message (equivalent to git add . && git commit -m "...")'
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="primary" onClick={handleCommit} disabled={busy !== null || !commitMessage.trim()}>
            {busy === "commit" ? "Committing…" : "Add & Commit"}
          </button>
          <button onClick={handlePush} disabled={busy !== null || !status.currentBranch}>
            {busy === "push" ? "Pushing…" : `Push ${status.currentBranch ?? ""}`}
          </button>
        </div>
      </div>

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      {syncMsg && <p style={{ color: "var(--muted)", fontSize: 13 }}>{syncMsg}</p>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>
          Files {status.currentBranch && <span style={{ color: "var(--muted)", fontWeight: "normal" }}>@ {status.currentBranch}</span>}
        </h3>
        {treeError && <p style={{ color: "var(--danger)" }}>{treeError}</p>}
        {!treeError && tree.length === 0 && <p>No files on this branch yet.</p>}
        {tree.map((entry) => (
          <div className="repo-row" key={entry.path}>
            <div>
              <span className="mono">{entry.path}</span>
              <div style={{ color: "var(--muted)", fontSize: 12 }}>
                {entry.lastCommitMessage || "—"}
                {entry.lastCommitDate && ` · ${timeAgo(entry.lastCommitDate)}`} · {formatBytes(entry.size)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
