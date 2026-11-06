/** The text of each built in profile file, `profiles/<name>.json`, by name. The build script supplies it. */
declare module "strictgen:profiles" {
  const texts: Readonly<Record<string, string>>;
  export default texts;
}
