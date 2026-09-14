import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Repo, type PullRequest, type TreeEntry } from "../api/client.js";
import { useSetRepoHeaderName } from "../context/repoHeader.js";
import { formatBytes, timeAgo } from "../format.js";
import { LocalPanel } from "../components/LocalPanel.js";

type Tab = "local" | "remote" | "prs" | "settings";

function StatusBadge({ status }: { status: PullRequest["status"] }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

function FileRow({ repo, refName, entry }: { repo: Repo; refName: string; entry: TreeEntry }) {
  const blobHref = `/repos/${repo.id}/blob?ref=${encodeURIComponent(refName)}&path=${encodeURIComponent(entry.path)}`;

  return (
    <div className="repo-row">
      <div>
        <Link to={blobHref} className="mono">
          {entry.path}
        </Link>
        <div style={{ color: "var(--muted)", fontSize: 12 }}>
          {entry.lastCommitMessage || "—"}
          {entry.lastCommitDate && ` · ${timeAgo(entry.lastCommitDate)}`} · {formatBytes(entry.size)}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Link to={blobHref}>
          <button>View</button>
        </Link>
        <a href={api.blobUrl(repo.id, refName, entry.path)}>
          <button>Download</button>
        </a>
      </div>
    </div>
  );
}

function ClonePopover({ repo, onClose }: { repo: Repo; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const cloneUrl = repo.cloneUrl ?? repo.clonePath ?? repo.bare_path;

  function handleCopy() {
    navigator.clipboard.writeText(cloneUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div className="popover clone-popover">
        <strong>Clone</strong>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input readOnly className="mono" value={cloneUrl} onFocus={(e) => e.target.select()} />
          <button onClick={handleCopy}>{copied ? "Copied!" : "Copy"}</button>
        </div>
        <p style={{ color: "var(--muted)", fontSize: 12, marginBottom: 0, marginTop: 8 }}>Clone using the web URL.</p>
      </div>
    </>
  );
}

export function RepoDetailPage() {
  const { repoId } = useParams<{ repoId: string }>();
  const navigate = useNavigate();
  const [repo, setRepo] = useState<Repo | null>(null);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState<Tab>("remote");
  const [showClone, setShowClone] = useState(false);

  function load() {
    if (!repoId) return;
    Promise.all([api.getRepo(repoId), api.listPrs(repoId)])
      .then(([r, p]) => {
        setRepo(r);
        setPrs(p);
        setSelectedRef((current) => current ?? r.default_branch);
      })
      .catch((e) => setError(e.message));
  }

  useEffect(load, [repoId]);

  useEffect(() => {
    // No branches yet means nothing has ever been pushed — the ref this
    // would ask for (repo.default_branch) doesn't exist in the bare repo
    // yet, so skip the request instead of surfacing a raw git error.
    if (!repoId || !selectedRef || (repo && repo.branches?.length === 0)) return;
    setTreeError(null);
    api
      .getTree(repoId, selectedRef)
      .then(setTree)
      .catch((e) => setTreeError(e.message));
  }, [repoId, selectedRef, repo]);

  function handleDelete() {
    if (!repo) return;
    if (!window.confirm(`Permanently delete "${repo.name}" and all its history? This cannot be undone.`)) return;
    setDeleting(true);
    api
      .deleteRepo(repo.id)
      .then(() => navigate("/"))
      .catch((e) => {
        setError(e.message);
        setDeleting(false);
      });
  }

  useSetRepoHeaderName(repo?.name ?? null);

  if (error) return <p style={{ color: "var(--danger)" }}>{error}</p>;
  if (!repo) return <p>Loading...</p>;

  const branches = repo.branches ?? [];
  const currentBranch = branches.find((b) => b.name === (selectedRef ?? repo.default_branch));

  return (
    <div>
      <div className="tabs repo-tabs">
        <button className={tab === "remote" ? "active" : ""} onClick={() => setTab("remote")}>
          Remote
        </button>
        <button className={tab === "local" ? "active" : ""} onClick={() => setTab("local")}>
          Local
        </button>
        <button className={tab === "prs" ? "active" : ""} onClick={() => setTab("prs")}>
          Pull requests{prs.length > 0 ? ` (${prs.length})` : ""}
        </button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
          Settings
        </button>
      </div>

      {tab === "local" && <LocalPanel repo={repo} />}

      {tab === "remote" && (
        <div>
          <div className="repo-toolbar">
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {branches.length > 0 ? (
                <select value={selectedRef ?? repo.default_branch} onChange={(e) => setSelectedRef(e.target.value)}>
                  {branches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span style={{ color: "var(--muted)" }}>No branches yet</span>
              )}
              <span style={{ color: "var(--muted)", fontSize: 13 }}>
                {branches.length} branch{branches.length === 1 ? "" : "es"}
              </span>
            </div>
            <div style={{ position: "relative" }}>
              <button className="primary" onClick={() => setShowClone((v) => !v)}>
                Clone
              </button>
              {showClone && <ClonePopover repo={repo} onClose={() => setShowClone(false)} />}
            </div>
          </div>

          <div className="card">
            {branches.length === 0 && <p>Nothing pushed to this repo yet — clone it and push to see files here.</p>}
            {branches.length > 0 && treeError && <p style={{ color: "var(--danger)" }}>{treeError}</p>}
            {branches.length > 0 && !treeError && tree.length === 0 && <p>No files pushed to this branch yet.</p>}
            {currentBranch && tree.length > 0 && (
              <div
                className="repo-row"
                style={{ background: "var(--card-alt, rgba(127,127,127,0.08))", borderRadius: 6, padding: "8px 10px", marginBottom: 8 }}
              >
                <div>
                  <strong>{currentBranch.lastCommitAuthorEmail}</strong> <span>{currentBranch.lastCommitMessage}</span>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--muted)", fontSize: 12 }}>
                  <span className="mono">{currentBranch.headSha.slice(0, 7)}</span>
                  <span>{timeAgo(currentBranch.lastCommitDate)}</span>
                </div>
              </div>
            )}
            {tree.map((entry) => (
              <FileRow key={entry.path} repo={repo} refName={selectedRef ?? repo.default_branch} entry={entry} />
            ))}
          </div>
        </div>
      )}

      {tab === "prs" && (
        <div className="card">
          {prs.length === 0 && <p>No pull requests yet — push a branch to the repo above to open one.</p>}
          {prs.map((pr) => (
            <div className="pr-row" key={pr.id}>
              <div>
                <Link to={`/repos/${repo.id}/prs/${pr.id}`}>
                  <strong>{pr.branch}</strong> → {pr.target_branch}
                </Link>
                <div style={{ color: "var(--muted)", fontSize: 13 }}>
                  by {pr.author_email ?? "unknown"}
                  {pr.turn_email && pr.status === "open" ? ` · waiting on ${pr.turn_email}` : ""}
                  {pr.base_branch && pr.base_branch !== pr.target_branch ? ` · vs ${pr.base_branch}` : ""}
                </div>
              </div>
              <StatusBadge status={pr.status} />
            </div>
          ))}
        </div>
      )}

      {tab === "settings" && (
        <div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Repo name</h3>
            <input readOnly value={repo.name} />
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Default branch</h3>
            <input readOnly value={repo.default_branch} />
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Participants</h3>
            {(repo.participants ?? []).length === 0 && <p>None registered.</p>}
            {(repo.participants ?? []).map((p) => (
              <div key={p.id}>
                {p.display_name} &lt;{p.email}&gt;
              </div>
            ))}
          </div>

          <div className="card danger-zone">
            <h3 style={{ marginTop: 0, color: "var(--danger)" }}>Danger zone</h3>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div>
                <strong>Delete this repo</strong>
                <div style={{ color: "var(--muted)", fontSize: 13 }}>Permanently deletes the repo and all its history.</div>
              </div>
              <button className="danger" onClick={handleDelete} disabled={deleting}>
                {deleting ? "Deleting…" : "Delete repo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
