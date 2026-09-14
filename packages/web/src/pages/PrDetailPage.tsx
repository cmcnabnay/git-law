import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type PrDetail, type Repo } from "../api/client.js";
import { RedlineDiffView } from "../components/RedlineDiffView.js";
import { useSetRepoHeaderName } from "../context/repoHeader.js";

const EVENT_LABEL: Record<string, string> = {
  created: "opened this pull request",
  pushed: "pushed a new commit",
  approved: "approved",
  rejected: "requested changes",
  merged: "merged",
  closed: "closed this pull request (branch deleted)",
  comment: "commented",
};

export function PrDetailPage() {
  const { repoId, prId } = useParams<{ repoId: string; prId: string }>();
  const navigate = useNavigate();
  const [repo, setRepo] = useState<Repo | null>(null);
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [view, setView] = useState<"redline" | "formatted">("redline");
  const [actorEmail, setActorEmail] = useState("");
  const [rejectComment, setRejectComment] = useState("");
  const [showRejectBox, setShowRejectBox] = useState(false);
  const [comment, setComment] = useState("");
  const [compareTo, setCompareTo] = useState<string | null>(null);

  function load(compareOverride?: string) {
    if (!repoId || !prId) return;
    Promise.all([api.getRepo(repoId), api.getPr(repoId, prId, compareOverride)])
      .then(([r, d]) => {
        setRepo(r);
        setDetail(d);
        setCompareTo(d.compareBranch);
        if (!actorEmail && r.participants?.length) setActorEmail(r.participants[0].email);
      })
      .catch((e) => setError(e.message));
  }

  useEffect(load, [repoId, prId]);

  function handleCompareChange(branch: string) {
    setCompareTo(branch);
    load(branch);
  }

  async function handleApprove() {
    if (!repoId || !prId) return;
    setBusy(true);
    setError(null);
    try {
      await api.approvePr(repoId, prId, actorEmail);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    if (!repoId || !prId || !rejectComment.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.rejectPr(repoId, prId, actorEmail, rejectComment.trim());
      setRejectComment("");
      setShowRejectBox(false);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleComment(e: React.FormEvent) {
    e.preventDefault();
    if (!repoId || !prId || !comment.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addComment(repoId, prId, actorEmail, comment.trim());
      setComment("");
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeletePr() {
    if (!repoId || !prId || !detail) return;
    if (!window.confirm(`Permanently delete PR "${detail.pr.branch} → ${detail.pr.target_branch}"? This cannot be undone.`))
      return;
    setDeleting(true);
    try {
      await api.deletePr(repoId, prId);
      navigate(`/repos/${repoId}`);
    } catch (e: any) {
      setError(e.message);
      setDeleting(false);
    }
  }

  useSetRepoHeaderName(repo?.name ?? null);

  if (error && !detail) return <p style={{ color: "var(--danger)" }}>{error}</p>;
  if (!detail || !repo) return <p>Loading...</p>;

  const { pr, events, diffs } = detail;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2>
          {pr.branch} <span style={{ color: "var(--muted)" }}>→ {pr.target_branch}</span>
        </h2>
        <button className="danger" onClick={handleDeletePr} disabled={deleting}>
          {deleting ? "Deleting…" : "Delete PR"}
        </button>
      </div>
      <span className={`badge ${pr.status}`}>{pr.status}</span>{" "}
      <span style={{ color: "var(--muted)", fontSize: 13 }}>
        opened by {pr.author_email ?? "unknown"}
        {pr.turn_email && pr.status === "open" ? ` · waiting on ${pr.turn_email}` : ""}
      </span>

      <div className="card">
        <label style={{ fontSize: 13 }}>Acting as</label>
        <select value={actorEmail} onChange={(e) => setActorEmail(e.target.value)}>
          {(repo.participants ?? []).map((p) => (
            <option key={p.email} value={p.email}>
              {p.display_name} &lt;{p.email}&gt;
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 20, marginBottom: 16 }}>
        <span>comparing against</span>
        <select
          value={compareTo ?? detail.compareBranch}
          onChange={(e) => handleCompareChange(e.target.value)}
          style={{ fontSize: 20, width: "auto", padding: "4px 8px" }}
        >
          {(repo.branches ?? []).map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      {diffs.length === 0 && <p>No .docx/.doc changes detected in this pull request.</p>}

      {diffs.map((diff) => (
        <div className="card" key={diff.path}>
          <div className="tabs">
            <button className={view === "redline" ? "active" : ""} onClick={() => setView("redline")}>
              Redline
            </button>
            <button className={view === "formatted" ? "active" : ""} onClick={() => setView("formatted")}>
              Formatted
            </button>
          </div>

          {view === "redline" ? (
            <RedlineDiffView diff={diff} />
          ) : (
            <div className="formatted-columns">
              <div className="formatted-view before">
                <h4>Before ({detail.compareBranch})</h4>
                <div dangerouslySetInnerHTML={{ __html: diff.oldHtml ?? "<p><em>(file did not exist)</em></p>" }} />
              </div>
              <div className="formatted-view after">
                <h4>After ({pr.branch})</h4>
                <div dangerouslySetInnerHTML={{ __html: diff.newHtml ?? "<p><em>(file removed)</em></p>" }} />
              </div>
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <a href={api.blobUrl(repo.id, detail.compareSha, diff.path)}>Download {detail.compareBranch} version</a>
            {" · "}
            <a href={api.blobUrl(repo.id, pr.head_sha, diff.path)}>Download {pr.branch} version</a>
          </div>
        </div>
      ))}

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {pr.status === "open" && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Review</h3>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button className="primary" disabled={busy} onClick={handleApprove}>
              Approve &amp; merge
            </button>
            <button className="danger" disabled={busy} onClick={() => setShowRejectBox((v) => !v)}>
              Reject
            </button>
          </div>
          {showRejectBox && (
            <div>
              <textarea
                rows={3}
                placeholder="Explain what needs to change..."
                value={rejectComment}
                onChange={(e) => setRejectComment(e.target.value)}
              />
              <div style={{ marginTop: 8 }}>
                <button className="danger" disabled={busy || !rejectComment.trim()} onClick={handleReject}>
                  Confirm reject
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Activity</h3>
        {events.map((ev) => (
          <div className="event" key={ev.id}>
            <div>
              <strong>{ev.actor_email ?? "unknown"}</strong> {EVENT_LABEL[ev.type] ?? ev.type}
              {ev.comment ? `: "${ev.comment}"` : ""}
            </div>
            <div className="meta">{ev.created_at}</div>
          </div>
        ))}
        <form onSubmit={handleComment} style={{ marginTop: 12 }}>
          <textarea rows={2} placeholder="Add a comment..." value={comment} onChange={(e) => setComment(e.target.value)} />
          <div style={{ marginTop: 8 }}>
            <button disabled={busy || !comment.trim()}>Comment</button>
          </div>
        </form>
      </div>

      <p className="limitations">
        Note: the redline diff compares extracted text only — formatting changes (bold, tables, styles) aren't
        shown as diff markup, though the Formatted tab shows each version's real formatting. Live editing in
        Word with tracked changes isn't supported yet; use the download links above to review a version
        manually in Word.
      </p>
    </div>
  );
}
