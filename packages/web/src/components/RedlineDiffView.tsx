import type { FileDiff, RedlineChange } from "../api/client.js";
import { ROW_START, CELL_SEP } from "@gitlaw/core/src/diff/tableMarkers.js";

type Segment = { kind: "text"; changes: RedlineChange[] } | { kind: "table"; rows: RedlineChange[][][] };

/** Regroups the flat change list into runs of plain text and tables: the
 * redline marks each table row with a ROW_START change, CELL_SEP changes
 * between cells, and a closing "\n\n" change (see tableMarkers.ts), and
 * consecutive rows belong to the same table. */
function toSegments(changes: RedlineChange[]): Segment[] {
  const segments: Segment[] = [];
  let row: RedlineChange[][] | null = null;
  for (const c of changes) {
    if (c.value === ROW_START) {
      const last = segments[segments.length - 1];
      row = [[]];
      if (last?.kind === "table") last.rows.push(row);
      else segments.push({ kind: "table", rows: [row] });
    } else if (row && c.value === CELL_SEP) {
      row.push([]);
    } else if (row && c.value === "\n\n") {
      row = null;
    } else if (row) {
      row[row.length - 1].push(c);
    } else {
      const last = segments[segments.length - 1];
      if (last?.kind === "text") last.changes.push(c);
      else segments.push({ kind: "text", changes: [c] });
    }
  }
  return segments;
}

function Changes({ changes }: { changes: RedlineChange[] }) {
  return (
    <>
      {changes.map((c, i) =>
        c.added ? <ins key={i}>{c.value}</ins> : c.removed ? <del key={i}>{c.value}</del> : <span key={i}>{c.value}</span>
      )}
    </>
  );
}

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
        {toSegments(diff.redline.changes).map((seg, i) =>
          seg.kind === "text" ? (
            <Changes key={i} changes={seg.changes} />
          ) : (
            <table key={i} className="redline-table">
              <tbody>
                {seg.rows.map((cells, r) => (
                  <tr key={r} className={cells.some((cell) => cell.some((c) => c.added || c.removed)) ? "changed" : ""}>
                    {cells.map((cell, k) => (
                      <td key={k}>
                        <Changes changes={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>
    </div>
  );
}
