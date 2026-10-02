import { useEffect, useState } from "react";
import { api, type PullRequest, type Repo } from "../api/client.js";
import { formatBytes } from "../format.js";
import { FsaFs } from "../local/fsaFs.js";
import {
  saveDirHandle,
  loadDirHandle,
  clearDirHandle,
  queryReadWritePermission,
  requestReadWritePermission,
} from "../local/handleStore.js";
import {
  isGitWorkingRepo,
  getStatus,
  checkoutBranch,
  addAndCommitAll,
  pushBranch,
  syncFromRemote,
  createBranch,
  listWorkingFiles,
  getGitIdentity,
  setGitIdentity,
  type LocalStatus,
  type LocalFileEntry,
} from "../local/localGit.js";
import { isPreviewableDocument, docxBytesToHtml } from "../local/docxPreview.js";
// Deep imports, like docxPreview's: browser-safe modules only.
import { htmlToNumberedText } from "@gitlaw/core/src/diff/numberedText.js";
import { overlayLocalEdits, type EditableChange } from "@gitlaw/core/src/diff/editableRedline.js";
import { saveParagraphEditsToDocx } from "@gitlaw/core/src/diff/docxPatch.js";
import { RedlineEditor } from "./RedlineEditor.js";

type Phase = "checking" | "no-handle" | "needs-permission" | "not-a-repo" | "ready";

// Prototype-only stand-in identity: the Local tab has no login, so there's
// no real per-person identity to ask for. Silently written into a folder's
// .git/config the first time it's missing, so isomorphic-git's commit
// never throws — see getGitIdentity/setGitIdentity in local/localGit.ts.
const PLACEHOLDER_IDENTITY = { name: "Git Law user", email: "local@git-law.local" };

const SUPPORTED = typeof window !== "undefined" && "showDirectoryPicker" in window;

export function LocalPanel({ repo, onPushed }: { repo: Repo; onPushed?: () => void }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [handle, setHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [tree, setTree] = useState<LocalFileEntry[]>([]);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // The PR the checked-out branch was created from to revise (see
  // "Revise on a new branch" on the PR page), if any — its redline is what
  // the "PR changes" view edits against.
  const [originPr, setOriginPr] = useState<PullRequest | null>(null);
  const [previewMode, setPreviewMode] = useState<"document" | "changes">("document");
  const [editorChanges, setEditorChanges] = useState<EditableChange[] | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  const [commitMessage, setCommitMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const [showCreateBranch, setShowCreateBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [newBranchFrom, setNewBranchFrom] = useState("");

  async function init() {
    setError(null);
    const stored = await loadDirHandle(repo.id);
    if (!stored) {
      setPhase("no-handle");
      return;
    }
    setHandle(stored);
    const perm = await queryReadWritePermission(stored);
    setPermission(perm);
    if (perm !== "granted") {
      setPhase("needs-permission");
      return;
    }
    await afterGranted(stored);
  }

  useEffect(() => {
    if (SUPPORTED) init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.id]);

  async function afterGranted(dirHandle: FileSystemDirectoryHandle) {
    const isRepo = await isGitWorkingRepo(dirHandle);
    if (!isRepo) {
      setPhase("not-a-repo");
      return;
    }
    const fs = new FsaFs(dirHandle);
    const identity = await getGitIdentity(fs);
    if (!identity.name || !identity.email) {
      await setGitIdentity(fs, PLACEHOLDER_IDENTITY);
    }
    setPhase("ready");
    await refreshStatus(dirHandle);
  }

  async function refreshStatus(dirHandle: FileSystemDirectoryHandle) {
    setError(null);
    try {
      const fs = new FsaFs(dirHandle);
      const s = await getStatus(fs);
      setStatus(s);
      setOriginPr(
        s.currentBranch ? (await api.getBranchOrigin(repo.id, s.currentBranch).catch(() => ({ pr: null }))).pr : null
      );
      if (s.currentBranch) {
        setTreeError(null);
        try {
          setTree(await listWorkingFiles(fs));
        } catch (e: any) {
          setTreeError(e.message);
        }
      } else {
        setTree([]);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }

  useEffect(() => {
    if (status?.branches?.length && !newBranchFrom) {
      setNewBranchFrom(status.currentBranch ?? status.branches[0].name);
    }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleChooseFolder() {
    setError(null);
    try {
      const picked = await window.showDirectoryPicker({ mode: "readwrite" });
      await saveDirHandle(repo.id, picked);
      setHandle(picked);
      setPermission("granted");
      await afterGranted(picked);
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(e.message);
    }
  }

  async function handleGrantAccess() {
    if (!handle) return;
    setError(null);
    try {
      const perm = await requestReadWritePermission(handle);
      setPermission(perm);
      if (perm === "granted") await afterGranted(handle);
      else setError("Access was not granted — the Local tab can't read or write this folder without it.");
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleForget() {
    await clearDirHandle(repo.id);
    setHandle(null);
    setPermission(null);
    setStatus(null);
    setTree([]);
    setPhase("no-handle");
  }

  async function handleCheckout(branch: string) {
    if (!handle) return;
    setBusy("checkout");
    setError(null);
    try {
      const fs = new FsaFs(handle);
      await checkoutBranch(fs, branch);
      await refreshStatus(handle);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleCommit() {
    if (!handle || !commitMessage.trim()) return;
    setBusy("commit");
    setError(null);
    try {
      const fs = new FsaFs(handle);
      await addAndCommitAll(fs, commitMessage.trim());
      setCommitMessage("");
      await refreshStatus(handle);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handlePush() {
    if (!handle || !status?.currentBranch) return;
    setBusy("push");
    setError(null);
    try {
      const fs = new FsaFs(handle);
      await pushBranch(fs, status.currentBranch);
      await refreshStatus(handle);
      onPushed?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleSync() {
    if (!handle) return;
    setBusy("sync");
    setError(null);
    setSyncMsg(null);
    try {
      const fs = new FsaFs(handle);
      const { created } = await syncFromRemote(fs);
      setSyncMsg(
        created.length > 0
          ? `Pulled down ${created.length} new branch${created.length === 1 ? "" : "es"}: ${created.join(", ")}`
          : "Already up to date — no new remote branches."
      );
      await refreshStatus(handle);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleOpenFile(path: string) {
    if (!handle) return;
    setError(null);
    setPreviewPath(path);
    setPreviewHtml(null);
    setPreviewError(null);
    setPreviewMode("document");
    setEditorChanges(null);
    setEditorError(null);
    if (!isPreviewableDocument(path)) {
      setPreviewError("not-supported");
      return;
    }
    setPreviewLoading(true);
    try {
      const fs = new FsaFs(handle);
      const data = (await fs.promises.readFile(path)) as Uint8Array;
      setPreviewHtml(await docxBytesToHtml(data));
    } catch (e: any) {
      setPreviewError(e.message);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handlePreviewModeChange(mode: "document" | "changes") {
    setPreviewMode(mode);
    if (mode === "changes" && previewPath) await loadChanges(previewPath);
  }

  /** The origin PR's redline for this file, with whatever the file on disk
   * has changed since the PR's version overlaid as the user's own edits. */
  async function loadChanges(path: string) {
    if (!handle || !originPr) return;
    setEditorLoading(true);
    setEditorError(null);
    setEditorChanges(null);
    try {
      const fs = new FsaFs(handle);
      const [detail, head, bytes] = await Promise.all([
        api.getPr(repo.id, originPr.id),
        // 404s when the file doesn't exist in the PR's version.
        api.getPreview(repo.id, originPr.head_sha, path).catch(() => null),
        fs.promises.readFile(path) as Promise<Uint8Array>,
      ]);
      const headText = head ? htmlToNumberedText(head.html) : "";
      const currentText = htmlToNumberedText(await docxBytesToHtml(bytes));
      // A file the PR didn't touch has no redline: all of it is unchanged.
      const prChanges = detail.diffs.find((d) => d.path === path)?.redline.changes ?? (headText ? [{ value: headText }] : []);
      const changes = overlayLocalEdits(prChanges, headText, currentText);
      if (!changes) throw new Error("The pull request's redline doesn't line up with its version of this file.");
      setEditorChanges(changes);
    } catch (e: any) {
      setEditorError(e.message);
    } finally {
      setEditorLoading(false);
    }
  }

  async function handleSaveEdits(original: string[], edited: string[]) {
    if (!handle || !previewPath) return;
    const fs = new FsaFs(handle);
    const bytes = (await fs.promises.readFile(previewPath)) as Uint8Array;
    await fs.promises.writeFile(previewPath, await saveParagraphEditsToDocx(bytes, original, edited));
    await refreshStatus(handle);
  }

  async function handleDownloadFile(path: string) {
    if (!handle) return;
    setError(null);
    try {
      const fs = new FsaFs(handle);
      const data = (await fs.promises.readFile(path)) as Uint8Array;
      const blob = new Blob([new Uint8Array(data)]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = path.split("/").pop() || path;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleCreateBranch(e: React.FormEvent) {
    e.preventDefault();
    if (!handle || !newBranchName.trim() || !newBranchFrom) return;
    setBusy("branch");
    setError(null);
    try {
      const fs = new FsaFs(handle);
      await createBranch(fs, newBranchName.trim(), newBranchFrom);
      setNewBranchName("");
      setShowCreateBranch(false);
      await refreshStatus(handle);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  const showChanges = previewMode === "changes" && originPr !== null;

  if (!SUPPORTED) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0, color: "var(--danger)" }}>Not supported in this browser</h3>
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          The Local tab uses the File System Access API to read and write a real folder on your machine, which is
          currently only available in Chromium-based browsers (Chrome, Edge). Use the Remote tab instead, or reopen
          this page in Chrome/Edge.
        </p>
      </div>
    );
  }

  if (phase === "checking") return <p>Loading...</p>;

  if (phase === "no-handle") {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Link a local clone</h3>
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          Choose the folder on this machine where you've cloned this repo. Everything below then runs against that
          real folder — real commits, real branches, real pushes — using your browser's own file access, no install
          required.
        </p>
        <button className="primary" onClick={handleChooseFolder}>
          Choose folder…
        </button>
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      </div>
    );
  }

  if (phase === "needs-permission") {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Reconnect to {handle?.name}</h3>
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          Your browser needs you to re-confirm access to this folder{permission === "denied" ? " (access was denied)" : ""}.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="primary" onClick={handleGrantAccess}>
            Grant access
          </button>
          <button onClick={handleForget}>Choose a different folder</button>
        </div>
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      </div>
    );
  }

  if (phase === "not-a-repo") {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0, color: "var(--danger)" }}>Not a git repo</h3>
        <p style={{ color: "var(--danger)" }}>"{handle?.name}" doesn't have a .git folder in it.</p>
        <button onClick={handleForget}>Choose a different folder</button>
      </div>
    );
  }

  if (!status) {
    return (
      <div>
        <p>Loading...</p>
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
            {status.dirty ? "uncommitted changes" : "clean"} · <span className="mono">{handle?.name}</span>
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleSync} disabled={busy !== null}>
            {busy === "sync" ? "Syncing…" : "Sync"}
          </button>
          <button onClick={() => setShowCreateBranch((v) => !v)} disabled={busy !== null}>
            Create branch
          </button>
          <button onClick={handleForget} disabled={busy !== null}>
            Unlink
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
          <div
            className="repo-row"
            key={entry.path}
            onClick={() => handleOpenFile(entry.path)}
            style={{ cursor: "pointer", background: previewPath === entry.path ? "var(--card-alt, rgba(127,127,127,0.08))" : undefined }}
          >
            <div>
              <span className="mono">{entry.path}</span>
              <div style={{ color: "var(--muted)", fontSize: 12 }}>
                {formatBytes(entry.size)}
                {entry.mtimeMs > 0 && <> · {new Date(entry.mtimeMs).toLocaleString()}</>}
              </div>
            </div>
          </div>
        ))}
      </div>

      {previewPath && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
            <strong className="mono" style={{ fontSize: 16 }}>
              {previewPath}
            </strong>
            <div style={{ display: "flex", gap: 8 }}>
              {originPr && isPreviewableDocument(previewPath) && (
                <select
                  value={previewMode}
                  onChange={(e) => handlePreviewModeChange(e.target.value as "document" | "changes")}
                  style={{ width: "auto" }}
                >
                  <option value="document">Document</option>
                  <option value="changes">
                    PR changes ({originPr.branch} → {originPr.base_branch ?? originPr.target_branch})
                  </option>
                </select>
              )}
              <button onClick={() => handleDownloadFile(previewPath)}>Download</button>
              <button onClick={() => setPreviewPath(null)}>Close</button>
            </div>
          </div>

          {showChanges && (
            <div style={{ marginTop: 12 }}>
              {editorLoading && <p>Loading changes...</p>}
              {editorError && <p style={{ color: "var(--danger)" }}>Couldn't load the pull request's changes: {editorError}</p>}
              {editorChanges && <RedlineEditor changes={editorChanges} onSave={handleSaveEdits} />}
            </div>
          )}

          {!showChanges && previewLoading && <p>Loading preview...</p>}

          {!showChanges && !previewLoading && previewError === "not-supported" && (
            <p style={{ color: "var(--muted)" }}>
              Git Law can only render <code className="mono">.docx</code> files in the browser. This file is a
              different format, so there's no inline preview — use Download above to open it.
            </p>
          )}

          {!showChanges && !previewLoading && previewError && previewError !== "not-supported" && (
            <div>
              <p style={{ color: "var(--danger)" }}>Couldn't render a preview: {previewError}</p>
              <p style={{ color: "var(--muted)", fontSize: 13 }}>Use Download above to open it in Word instead.</p>
            </div>
          )}

          {!showChanges && !previewLoading && !previewError && previewHtml !== null && (
            <div className="formatted-view">
              <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
