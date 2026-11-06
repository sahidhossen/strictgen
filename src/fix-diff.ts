/** Unified diffs of whole files, for `strictgen fix` without `--write`. */

interface Lines {
  readonly lines: readonly string[];
  /** Whether the last line ends with a newline. */
  readonly final: boolean;
}

function linesOf(text: string): Lines {
  if (text === "") return { lines: [], final: true };
  const final = text.endsWith("\n");
  return { lines: (final ? text.slice(0, -1) : text).split("\n"), final };
}

type Op = { readonly kind: " " | "-" | "+"; readonly a: number; readonly b: number };

/**
 * The shortest edit script from `a` to `b` (Myers), as kept, removed and added lines, each with
 * its index in `a` and `b`. Lines compare by their key, so a last line without a newline differs
 * from the same line with one.
 */
function editScript(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  const middle: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const saved = trace[d] ?? new Int32Array(0);
    const at = (k: number): number => saved[k + d + 1] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      middle.push({ kind: " ", a: start + x, b: start + y });
    }
    if (down) middle.push({ kind: "+", a: start + x, b: start + prevY });
    else middle.push({ kind: "-", a: start + prevX, b: start + y });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    middle.push({ kind: " ", a: start + x, b: start + y });
  }
  middle.reverse();
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: " ", a: i, b: i });
  ops.push(...middle);
  for (let i = 0; i < a.length - endA; i++) ops.push({ kind: " ", a: endA + i, b: endB + i });
  return ops;
}

/** The lines of a range in a hunk header: `start,count`, with the line before for an empty one. */
function range(first: number, count: number): string {
  if (count === 0) return `${String(first)},0`;
  return count === 1 ? String(first + 1) : `${String(first + 1)},${String(count)}`;
}

/**
 * A unified diff from `before` to `after`, with three lines of context, under the names
 * `a/<path>` and `b/<path>`, as lines without their newlines. Empty when the texts are equal.
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string[] {
  if (before === after) return [];
  const old = linesOf(before);
  const next = linesOf(after);
  const NO_NEWLINE = "\\ No newline at end of file";
  const key = (side: Lines) =>
    side.lines.map((line, i) =>
      i === side.lines.length - 1 && !side.final ? `${line}${String.fromCharCode(0)}` : line,
    );
  const ops = editScript(key(old), key(next));
  const out = [`--- a/${path}`, `+++ b/${path}`];
  const changes = ops.map((op, i) => (op.kind === " " ? -1 : i)).filter((i) => i >= 0);
  let i = 0;
  while (i < changes.length) {
    const first = changes[i] ?? 0;
    let last = first;
    while (i + 1 < changes.length && (changes[i + 1] ?? 0) - last <= 2 * context) {
      i++;
      last = changes[i] ?? last;
    }
    i++;
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    const hunk = ops.slice(from, to + 1);
    const startOp = hunk[0];
    if (startOp === undefined) continue;
    const countA = hunk.filter((op) => op.kind !== "+").length;
    const countB = hunk.filter((op) => op.kind !== "-").length;
    const firstA = hunk.find((op) => op.kind !== "+")?.a ?? startOp.a;
    const firstB = hunk.find((op) => op.kind !== "-")?.b ?? startOp.b;
    out.push(`@@ -${range(firstA, countA)} +${range(firstB, countB)} @@`);
    for (const op of hunk) {
      const side = op.kind === "+" ? next : old;
      const index = op.kind === "+" ? op.b : op.a;
      out.push(`${op.kind}${side.lines[index] ?? ""}`);
      if (index === side.lines.length - 1 && !side.final) out.push(NO_NEWLINE);
    }
  }
  return out;
}
