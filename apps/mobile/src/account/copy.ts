/** One placeholder helper for the account copy tables. An unknown placeholder stays visible instead of
 *  rendering `undefined` into a user-facing sentence. */
export function fill(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, name) => values[name] === undefined ? match : String(values[name]));
}
