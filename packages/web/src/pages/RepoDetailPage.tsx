import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Repo, type PullRequest, type TreeEntry } from "../api/client.js";

function StatusBadge({ status }: { status: PullRequest["status"] }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function timeAgo(iso: string): string {
  if (!iso) return "";
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  const plural = (n: number) => (Math.floor(n) === 1 ? "" : "s");
  const mins = diffSec / 60;
  const hours = mins / 60;
  const days = hours / 24;
  const weeks = days / 7;
  const months = days / 30.44;
  const years = days / 365.25;

  if (diffSec < 60) return `${Math.floor(diffSec)} second${plural(diffSec)} ago`;
  if (mins < 60) return `${Math.floor(mins)} minute${plural(mins)} ago`;
  if (hours < 24) return `${Math.floor(hours)} hour${plural(hours)} ago`;
  if (days < 7) return `${Math.floor(days)} day${plural(days)} ago`;
  if (weeks < 4.345) return `${Math.floor(weeks)} week${plural(weeks)} ago`;
  if (months < 12) return `${Math.floor(months)} month${plural(months)} ago`;
  return `${Math.floor(years)} year${plural(years)} ago`;
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

  if (error) return <p style={{ color: "var(--danger)" }}>{error}</p>;
  if (!repo) return <p>Loading...</p>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>{repo.name}</h2>
        <button className="danger" onClick={handleDelete} disabled={deleting}>
          {deleting ? "Deleting…" : "Delete repo"}
        </button>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Clone this repo</h3>
        <code className="clone-cmd">git clone {repo.cloneUrl ?? repo.clonePath ?? repo.bare_path} {repo.name}</code>
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          To be identified as a specific participant, run <code className="mono">git config user.email "you@example.com"</code>{" "}
          inside your clone, matching a registered participant below.
        </p>
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

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Branches</h3>
        {(repo.branches ?? []).map((b) => (
          <div className="repo-row" key={b.name}>
            <div>
              <strong>{b.name}</strong>
              <div style={{ color: "var(--muted)", fontSize: 13 }}>{b.lastCommitMessage}</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="mono">{b.headSha.slice(0, 8)}</span>
              <button
                className={selectedRef === b.name ? "active" : ""}
                onClick={() => setSelectedRef(b.name)}
              >
                Browse files
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>
          Files {selectedRef && <span style={{ color: "var(--muted)", fontWeight: "normal" }}>@ {selectedRef}</span>}
        </h3>
        {(repo.branches ?? []).length === 0 && <p>Nothing pushed to this repo yet — clone it and push to see files here.</p>}
        {(repo.branches ?? []).length > 0 && treeError && <p style={{ color: "var(--danger)" }}>{treeError}</p>}
        {(repo.branches ?? []).length > 0 && !treeError && tree.length === 0 && <p>No files pushed to this branch yet.</p>}
        {(() => {
          const currentBranch = (repo.branches ?? []).find((b) => b.name === (selectedRef ?? repo.default_branch));
          if (!currentBranch || tree.length === 0) return null;
          return (
            <div
              className="repo-row"
              style={{ background: "var(--card-alt, rgba(127,127,127,0.08))", borderRadius: 6, padding: "8px 10px", marginBottom: 8 }}
            >
              <div>
                <strong>{currentBranch.lastCommitAuthorEmail}</strong>{" "}
                <span>{currentBranch.lastCommitMessage}</span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--muted)", fontSize: 12 }}>
                <span className="mono">{currentBranch.headSha.slice(0, 7)}</span>
                <span>{timeAgo(currentBranch.lastCommitDate)}</span>
              </div>
            </div>
          );
        })()}
        {tree.map((entry) => (
          <FileRow key={entry.path} repo={repo} refName={selectedRef ?? repo.default_branch} entry={entry} />
        ))}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Pull requests</h3>
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
    </div>
  );
}
