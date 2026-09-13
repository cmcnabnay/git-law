import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Repo, type PullRequest, type TreeEntry } from "../api/client.js";

function StatusBadge({ status }: { status: PullRequest["status"] }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function FileRow({ repo, refName, entry }: { repo: Repo; refName: string; entry: TreeEntry }) {
  const blobHref = `/repos/${repo.id}/blob?ref=${encodeURIComponent(refName)}&path=${encodeURIComponent(entry.path)}`;

  return (
    <div className="repo-row">
      <div>
        <Link to={blobHref} className="mono">
          {entry.path}
        </Link>{" "}
        <span style={{ color: "var(--muted)", fontSize: 12 }}>{formatBytes(entry.size)}</span>
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
  const [repo, setRepo] = useState<Repo | null>(null);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);

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
    if (!repoId || !selectedRef) return;
    setTreeError(null);
    api
      .getTree(repoId, selectedRef)
      .then(setTree)
      .catch((e) => setTreeError(e.message));
  }, [repoId, selectedRef]);

  if (error) return <p style={{ color: "var(--danger)" }}>{error}</p>;
  if (!repo) return <p>Loading...</p>;

  return (
    <div>
      <h2>{repo.name}</h2>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Clone this repo</h3>
        <code className="clone-cmd">git clone {repo.clonePath ?? repo.bare_path} {repo.name}</code>
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
        {treeError && <p style={{ color: "var(--danger)" }}>{treeError}</p>}
        {!treeError && tree.length === 0 && <p>No files pushed to this branch yet.</p>}
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
              </div>
            </div>
            <StatusBadge status={pr.status} />
          </div>
        ))}
      </div>
    </div>
  );
}
