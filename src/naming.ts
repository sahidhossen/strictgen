/**
 * Turns a schema name, title or enum value into PascalCase, like `headingBlock`
 * to `HeadingBlock`, `sans-serif` to `SansSerif` and `GET` to `Get`. Returns an
 * empty string when there are no letters or digits.
 */
export function pascal(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => {
      const shouted = word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word);
      const rest = shouted ? word.slice(1).toLowerCase() : word.slice(1);
      return word.charAt(0).toUpperCase() + rest;
    })
    .join("");
}

/**
 * Names a variant from a JSON value, like `_blank` to `Blank`. Names that would
 * start with a digit, be empty, or clash with a reserved word get a fixed fix:
 * `419` becomes `V419`, `""` becomes `Empty` and `_self` becomes `SelfValue`.
 */
export function variantName(value: string): string {
  const name = pascal(value);
  if (name === "") return "Empty";
  if (/^[0-9]/.test(name)) return `V${name}`;
  if (name === "Self") return "SelfValue";
  return name;
}
