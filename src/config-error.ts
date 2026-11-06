/**
 * A config file that can't be read or breaks a rule of `strictgen.schema.json`. `option` is the
 * path of the offending option, like `targets.go.package`, or `""` for the whole file.
 */
export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly option: string,
    readonly problem: string,
  ) {
    super(`${file}: ${option === "" ? "" : `${option}: `}${problem}`);
    this.name = "ConfigError";
  }
}
