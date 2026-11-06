import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseConfig, loadConfig } from "./config.js";
import { generateProject } from "./main.js";
import type { MemorySchema } from "./memory.js";
import { defaultSettings, generateInMemory, memorySchemas } from "./memory.js";
import { BUILTIN_PROFILES, builtinProfileFromText } from "./llm-profile.js";
import { builtinProfile, builtinProfileFile } from "./profile-files.js";
import { CodegenError } from "./schema.js";
import { loadSchemas } from "./schema-files.js";
import { mainOptions, targetSettings } from "./targets.js";

const EXAMPLES = join(import.meta.dirname, "..", "examples");

/** Every `*.json` file of a folder, as text, in the order the folder lists them. */
function schemaTexts(dir: string): MemorySchema[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

/** A built in profile as the playground loads it: from the text of its file. */
function profileFromFile(name: string) {
  return builtinProfileFromText(name, readFileSync(builtinProfileFile(name), "utf8"));
}

describe("generateInMemory", () => {
  for (const example of ["basic", "report", "llm"]) {
    it(`gives the CLI's unformatted output, byte for byte, for examples/${example}`, () => {
      const config = loadConfig(join(EXAMPLES, example, "strictgen.json"));
      const cli = generateProject(mainOptions(config));
      const settings = targetSettings(config);
      const memory = generateInMemory({
        schemas: schemaTexts(config.schemas).reverse(),
        settings: {
          ...settings,
          // The profiles as the browser reads them, from the text of the built in files.
          ...(settings.llm === undefined
            ? {}
            : { llm: { ...settings.llm, profiles: settings.llm.profiles.map((p) => profileFromFile(p.name)) } }),
        },
        ...(config.idBase === undefined ? {} : { idBase: config.idBase }),
        ...(config.ids === undefined ? {} : { ids: config.ids }),
        validation: config.validation,
      });
      expect(cli.length).toBeGreaterThan(10);
      expect(memory.files.map((f) => f.path)).toEqual(cli.map((f) => f.path));
      for (const [i, file] of cli.entries()) expect(memory.files[i]?.contents, file.path).toBe(file.contents);
      expect(memory.schemas).toEqual(loadSchemas(config.schemas));
    });
  }

  it("reads a broken schema text with the error loadSchemas gives", () => {
    const fail = (text: string): string => {
      try {
        memorySchemas([{ name: "order.json", text }]);
      } catch (error) {
        expect(error).toBeInstanceOf(CodegenError);
        return (error as CodegenError).message;
      }
      throw new Error("no error");
    };
    expect(fail("{")).toMatch(/^order\.json: invalid-json: not valid JSON: /);
    expect(fail("[]")).toBe("order.json#: invalid-schema: schema is not an object");
  });

  it("refuses a file name without .json and a name given twice", () => {
    expect(() => memorySchemas([{ name: "order", text: "{}" }])).toThrow('schema file "order" must end in .json');
    const twice = [
      { name: "a.json", text: "{}" },
      { name: "a.json", text: "{}" },
    ];
    expect(() => memorySchemas(twice)).toThrow('schema file "a.json" is given twice');
  });
});

describe("defaultSettings", () => {
  it("are the settings a config with only the output folders gives", () => {
    for (const read of ["strict", "report"] as const) {
      for (const cleanup of [false, true]) {
        const config = parseConfig(
          {
            targets: { typescript: { out: "ts", read }, rust: { out: "rust", read }, go: { out: "go", read } },
            llm: { profiles: [...BUILTIN_PROFILES], out: "llm", cleanup },
          },
          join(EXAMPLES, "virtual", "strictgen.json"),
        );
        const profiles = BUILTIN_PROFILES.map(profileFromFile);
        expect(defaultSettings({ read, profiles, cleanup })).toEqual(targetSettings(config));
      }
    }
    const plain = parseConfig(
      { targets: { typescript: { out: "ts" }, rust: { out: "rust" }, go: { out: "go" } } },
      join(EXAMPLES, "virtual", "strictgen.json"),
    );
    expect(defaultSettings({ read: "strict", profiles: [], cleanup: false })).toEqual(targetSettings(plain));
  });
});

describe("builtinProfileFromText", () => {
  it("reads each built in profile as builtinProfile does", () => {
    for (const name of BUILTIN_PROFILES) expect(profileFromFile(name)).toEqual(builtinProfile(name));
  });

  it("fails for a file that names another profile, as builtinProfile does", () => {
    const text = readFileSync(builtinProfileFile("openai"), "utf8");
    expect(() => builtinProfileFromText("gemini", text)).toThrow("profiles/gemini.json: name: must be gemini");
  });
});
