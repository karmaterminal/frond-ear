// The one `canticle.tune` matcher. `hear`, the guide, delivery and the record v1 live set's
// shares all read a record through it, so "tuned here" means the same thing everywhere.

/** Does a `station:stream` tune (`*` for any station) take in this record's stream? */
export function tunes(
  patterns: readonly string[],
  station: string,
  stream: string,
): boolean {
  return patterns.some((p) => {
    const at = p.indexOf(":");
    const s = p.slice(0, at);
    return (s === "*" || s === station) && p.slice(at + 1) === stream;
  });
}
