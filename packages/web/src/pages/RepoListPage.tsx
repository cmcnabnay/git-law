import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Repo } from "../api/client.js";

export function RepoListPage() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [participantsText, setParticipantsText] = useState("");
  const [creating, setCreating] = useState(false);

  function load() {
    setLoading(true);
    api
      .listRepos()
      .then(setRepos)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const participants = participantsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((spec) => {
          const match = spec.match(/^(.*)<(.+)>$/);
          if (!match) throw new Error(`Invalid participant "${spec}" — use "Name <email>"`);
          return { displayName: match[1].trim(), email: match[2].trim() };
        });
      await api.createRepo(name.trim(), participants);
      setName("");
      setParticipantsText("");
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <h2>Repos</h2>

      <form className="card" onSubmit={handleCreate}>
        <h3 style={{ marginTop: 0 }}>Create a repo</h3>
        <div style={{ marginBottom: 10 }}>
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. nda-with-acme" />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label>Participants (comma-separated, "Name &lt;email&gt;")</label>
          <input
            value={participantsText}
            onChange={(e) => setParticipantsText(e.target.value)}
            placeholder="Alice <alice@example.com>, Bob <bob@example.com>"
          />
        </div>
        <button className="primary" disabled={creating || !name.trim()}>
          {creating ? "Creating..." : "Create repo"}
        </button>
      </form>

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      {loading && <p>Loading...</p>}

      <div className="card">
        {repos.length === 0 && !loading && <p>No repos yet.</p>}
        {repos.map((r) => (
          <div className="repo-row" key={r.id}>
            <div>
              <Link to={`/repos/${r.id}`}>
                <strong>{r.name}</strong>
              </Link>
              <div className="mono">{r.bare_path}</div>
            </div>
            <span className="badge open">{r.openPrCount ?? 0} open PR{r.openPrCount === 1 ? "" : "s"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
