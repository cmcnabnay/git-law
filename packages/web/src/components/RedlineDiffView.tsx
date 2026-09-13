import type { FileDiff } from "../api/client.js";

export function RedlineDiffView({ diff }: { diff: FileDiff }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong className="mono">{diff.path}</strong>
        <span style={{ fontSize: 13, color: "var(--muted)" }}>
          <span style={{ color: "var(--success)" }}>+{diff.redline.stats.added}</span>{" "}
          <span style={{ color: "var(--danger)" }}>-{diff.redline.stats.removed}</span> words
        </span>
      </div>
      <div className="redline" style={{ marginTop: 8 }}>
        {diff.redline.changes.map((c, i) =>
          c.added ? (
            <ins key={i}>{c.value}</ins>
          ) : c.removed ? (
            <del key={i}>{c.value}</del>
          ) : (
            <span key={i}>{c.value}</span>
          )
        )}
      </div>
    </div>
  );
}
