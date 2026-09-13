import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type Repo } from "../api/client.js";

const SUPPORTED_EXTENSIONS = [".docx", ".doc"];

export function BlobPage() {
  const { repoId } = useParams<{ repoId: string }>();
  const [searchParams] = useSearchParams();
  const ref = searchParams.get("ref") ?? "";
  const path = searchParams.get("path") ?? "";

  const [repo, setRepo] = useState<Repo | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const lowerPath = path.toLowerCase();
  const isSupported = SUPPORTED_EXTENSIONS.some((ext) => lowerPath.endsWith(ext));
  const isLegacyDoc = lowerPath.endsWith(".doc") && !lowerPath.endsWith(".docx");

  useEffect(() => {
    if (!repoId) return;
    api.getRepo(repoId).then(setRepo).catch((e) => setError(e.message));
  }, [repoId]);

  useEffect(() => {
    if (!repoId || !ref || !path) return;
    setLoading(true);
    setError(null);
    if (!isSupported) {
      // Not a format Git Law can render — mirror GitHub's "binary file not
      // shown" behavior instead of attempting (and failing) a preview.
      setHtml(null);
      setLoading(false);
      return;
    }
    api
      .getPreview(repoId, ref, path)
      .then((r) => setHtml(r.html))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [repoId, ref, path, isSupported]);

  if (!repoId || !ref || !path) return <p style={{ color: "var(--danger)" }}>Missing ref or path.</p>;

  return (
    <div>
      <p>
        <Link to={`/repos/${repoId}`}>← Back to {repo?.name ?? "repo"}</Link>
      </p>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <div>
            <strong className="mono" style={{ fontSize: 16 }}>{path}</strong>
            <div style={{ color: "var(--muted)", fontSize: 13 }}>at {ref}</div>
          </div>
          <a href={api.blobUrl(repoId, ref, path)}>
            <button>Download</button>
          </a>
        </div>
      </div>

      <div className="card">
        {loading && <p>Loading preview...</p>}

        {!loading && error && (
          <div>
            <p style={{ color: "var(--danger)" }}>Couldn't render a preview: {error}</p>
            <p style={{ color: "var(--muted)", fontSize: 13 }}>
              Use the Download button above to open it in Word or LibreOffice instead.
            </p>
          </div>
        )}

        {!loading && !error && !isSupported && (
          <div>
            <p style={{ color: "var(--muted)" }}>
              Git Law can only render <code className="mono">.docx</code> and <code className="mono">.doc</code>{" "}
              files in the browser. This file is a different format, so there's no inline preview — download it
              above to view it.
            </p>
          </div>
        )}

        {!loading && !error && isSupported && html !== null && (
          <div>
            {isLegacyDoc && (
              <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 0 }}>
                This is a legacy <code className="mono">.doc</code> file — showing extracted text only; original
                formatting (bold, tables, styles) isn't preserved. Convert it to <code className="mono">.docx</code>{" "}
                for full-fidelity rendering and redline diffs.
              </p>
            )}
            <div className="formatted-view">
              <div dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
