//! Decodes every fixture under `examples/basic/fixtures` through the generated registry.
//!
//! A fixture lives in `<schema>/valid` or `<schema>/invalid` for a schema's root type, and in
//! `<schema>/<def>/valid` or `<schema>/<def>/invalid` for one of its defs. A valid case must
//! decode and encode again to the same JSON value. An invalid case must fail to decode with the
//! path and code in `<case>.expect.json` next to it, as in Go and TypeScript.

#[path = "generated/registry.rs"]
mod registry;

use std::fs;
use std::path::{Path, PathBuf};

use registry::Failure;
use serde_json::Value;

/// Ends the file next to an invalid case that holds the error it expects.
const EXPECT_SUFFIX: &str = ".expect.json";

/// One fixture file and the folder it belongs to, like `payment-method/card`.
struct Case {
    key: String,
    valid: bool,
    path: PathBuf,
}

/// Every `.json` file below `dir`, sorted by path.
fn json_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("reading {}: {error}", dir.display()))
        .map(|entry| entry.expect("a folder entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            json_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "json") {
            out.push(path);
        }
    }
}

/// Every fixture below `root`. A `.json` file that isn't directly in a `valid` or `invalid`
/// folder below a schema folder is a failure, so a misspelled folder never skips a case, and so
/// is an expectation without an invalid case next to it.
fn cases(root: &Path, failures: &mut Vec<String>) -> Vec<Case> {
    let mut files = Vec::new();
    json_files(root, &mut files);
    let mut out = Vec::new();
    for path in files {
        let rel = path.strip_prefix(root).expect("a file below the root");
        let parts: Vec<String> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        let folder = parts.len().checked_sub(2).map(|i| parts[i].as_str());
        if parts.len() < 3 || !matches!(folder, Some("valid" | "invalid")) {
            failures.push(format!(
                "{}: not in a valid or invalid folder",
                parts.join("/")
            ));
            continue;
        }
        let name = path.to_string_lossy();
        if let Some(case) = name.strip_suffix(EXPECT_SUFFIX) {
            // An expectation belongs to an invalid case next to it, and is not a case itself.
            if folder != Some("invalid") || !Path::new(&format!("{case}.json")).is_file() {
                failures.push(format!("{}: no invalid case next to it", parts.join("/")));
            }
            continue;
        }
        out.push(Case {
            key: parts[..parts.len() - 2].join("/"),
            valid: folder == Some("valid"),
            path,
        });
    }
    out
}

/// The path and code an invalid case expects, from `<case>.expect.json`. Both are required and
/// no other key is allowed.
fn expectation(case: &Path) -> Result<(String, String), String> {
    let name = case.to_string_lossy();
    let file = PathBuf::from(format!(
        "{}{EXPECT_SUFFIX}",
        name.strip_suffix(".json").unwrap_or(&name)
    ));
    let text = fs::read_to_string(&file).map_err(|error| {
        let name = file.file_name().unwrap_or_default().to_string_lossy();
        format!("every invalid case needs {name}: {error}")
    })?;
    let shape = || {
        format!(
            "{}: expected {{\"path\": ..., \"code\": ...}}",
            file.display()
        )
    };
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(&text) else {
        return Err(shape());
    };
    match (object.get("path"), object.get("code"), object.len()) {
        (Some(Value::String(path)), Some(Value::String(code)), 2) => {
            Ok((path.clone(), code.clone()))
        }
        _ => Err(shape()),
    }
}

#[test]
fn fixtures_round_trip() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures");
    let mut failures = Vec::new();
    let all = cases(&root, &mut failures);
    assert!(!all.is_empty(), "no fixtures under {}", root.display());

    for case in &all {
        let json = fs::read(&case.path).expect("a readable fixture");
        let (schema, def) = match case.key.split_once('/') {
            Some((schema, def)) => (schema, Some(def)),
            None => (case.key.as_str(), None),
        };
        let name = case
            .path
            .strip_prefix(&root)
            .unwrap_or(&case.path)
            .display();
        match (registry::round_trip(schema, def, &json), case.valid) {
            (None, _) => failures.push(format!("{name}: no generated type for {}", case.key)),
            (Some(Ok(encoded)), true) => {
                let expected: Value = serde_json::from_slice(&json).expect("valid JSON");
                if encoded != expected {
                    failures.push(format!("{name}: encodes as {encoded}"));
                }
            }
            (Some(Err(error)), true) => failures.push(format!("{name}: {error:?}")),
            (Some(Ok(encoded)), false) => {
                failures.push(format!(
                    "{name}: decoded, expected an error, encodes as {encoded}"
                ));
            }
            (Some(Err(Failure::Encode(error))), false) => {
                failures.push(format!("{name}: decoded, then failed to encode: {error}"));
            }
            (Some(Err(Failure::Decode(error))), false) => match expectation(&case.path) {
                Err(why) => failures.push(format!("{name}: {why}")),
                Ok((path, code)) if error.path != path || error.code != code => {
                    failures.push(format!(
                        "{name}: got path {:?} code {:?} ({error}), expected path {path:?} code {code:?}",
                        error.path, error.code
                    ));
                }
                Ok(_) => {}
            },
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} fixtures failed:\n{}",
        failures.len(),
        all.len(),
        failures.join("\n")
    );
}
