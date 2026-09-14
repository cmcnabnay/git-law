export interface Repo {
  id: string;
  name: string;
  bare_path: string;
  default_branch: string;
  created_at: string;
  openPrCount?: number;
  participants?: Participant[];
  branches?: BranchInfo[];
  clonePath?: string;
  cloneUrl?: string;
}

export interface Participant {
  id: string;
  repo_id: string;
  display_name: string;
  email: string;
  role: string;
}

export interface BranchInfo {
  name: string;
  headSha: string;
  lastCommitMessage: string;
  lastCommitAuthorEmail: string;
  lastCommitDate: string;
}

export type PrStatus = "open" | "rejected" | "merged" | "closed";

export interface PullRequest {
  id: string;
  repo_id: string;
  branch: string;
  target_branch: string;
  status: PrStatus;
  base_branch: string | null;
  author_email: string | null;
  turn_email: string | null;
  head_sha: string;
  base_sha: string;
  created_at: string;
  updated_at: string;
}

export interface PrEvent {
  id: number;
  pr_id: string;
  type: "created" | "pushed" | "approved" | "rejected" | "merged" | "comment";
  actor_email: string | null;
  sha: string | null;
  comment: string | null;
  created_at: string;
}

export interface RedlineChange {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface FileDiff {
  path: string;
  redline: { changes: RedlineChange[]; stats: { added: number; removed: number } };
  oldHtml: string | null;
  newHtml: string | null;
}

export interface PrDetail {
  pr: PullRequest;
  events: PrEvent[];
  diffs: FileDiff[];
  compareBranch: string;
  compareSha: string;
}

export interface TreeEntry {
  path: string;
  size: number;
  lastCommitSha: string;
  lastCommitMessage: string;
  lastCommitDate: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  listRepos: () => request<Repo[]>("/repos"),
  createRepo: (name: string, participants: { displayName: string; email: string }[]) =>
    request<Repo>("/repos", { method: "POST", body: JSON.stringify({ name, participants }) }),
  getRepo: (repoId: string) => request<Repo>(`/repos/${repoId}`),
  deleteRepo: (repoId: string) => request<{ ok: true; deleted: Repo }>(`/repos/${repoId}`, { method: "DELETE" }),
  getTree: (repoId: string, ref: string) =>
    request<TreeEntry[]>(`/repos/${repoId}/tree?ref=${encodeURIComponent(ref)}`),
  getPreview: (repoId: string, rev: string, path: string) =>
    request<{ html: string }>(
      `/repos/${repoId}/preview?rev=${encodeURIComponent(rev)}&path=${encodeURIComponent(path)}`
    ),
  listPrs: (repoId: string) => request<PullRequest[]>(`/repos/${repoId}/prs`),
  getPr: (repoId: string, prId: string, compareTo?: string) =>
    request<PrDetail>(`/repos/${repoId}/prs/${prId}${compareTo ? `?compareTo=${encodeURIComponent(compareTo)}` : ""}`),
  deletePr: (repoId: string, prId: string) =>
    request<{ ok: true; deleted: PullRequest }>(`/repos/${repoId}/prs/${prId}`, { method: "DELETE" }),
  approvePr: (repoId: string, prId: string, actorEmail: string) =>
    request<PullRequest>(`/repos/${repoId}/prs/${prId}/approve`, {
      method: "POST",
      body: JSON.stringify({ actorEmail }),
    }),
  rejectPr: (repoId: string, prId: string, actorEmail: string, comment: string) =>
    request<PullRequest>(`/repos/${repoId}/prs/${prId}/reject`, {
      method: "POST",
      body: JSON.stringify({ actorEmail, comment }),
    }),
  addComment: (repoId: string, prId: string, actorEmail: string, comment: string) =>
    request<{ pr: PullRequest; events: PrEvent[] }>(`/repos/${repoId}/prs/${prId}/comments`, {
      method: "POST",
      body: JSON.stringify({ actorEmail, comment }),
    }),
  blobUrl: (repoId: string, rev: string, path: string) =>
    `/api/repos/${repoId}/blob?rev=${encodeURIComponent(rev)}&path=${encodeURIComponent(path)}`,
};
