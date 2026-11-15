/**
 * Shared `--flag value` parser for the small v4 CLIs (design, story-review, ui).
 *
 * One definition so the three never drift: `--json` is a boolean, every other
 * `--name` takes exactly one value (a following `--other` is "needs a value"),
 * and bare words land in `_` in order. `onError(msg)` is the caller's usage()
 * and is expected not to return.
 */
export function parseFlags(args, onError) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") { o.json = true; continue; }
    if (a.startsWith("--")) {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) onError(`${a} needs a value`);
      o[a.slice(2)] = v;
    } else o._.push(a);
  }
  return o;
}
