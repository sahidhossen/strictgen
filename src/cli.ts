import { main } from "./main.js";

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

// A placeholder until the config-driven CLI lands: checks that the schemas in a folder map,
// without writing anything.
const dir = process.argv[2];
if (dir === undefined || process.argv.length > 3) {
  write("usage: strictgen <schema-dir>");
  process.exitCode = 2;
} else {
  process.exitCode = main({ schemaDir: dir, rootDir: process.cwd(), targets: [] }, write);
}
