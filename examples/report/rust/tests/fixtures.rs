//! Decodes every fixture under `examples/report/fixtures` through the generated registry, in
//! report mode.
//!
//! A fixture lives in `<schema>/valid` or `<schema>/invalid` for a schema's root type, and in
//! `<schema>/<def>/valid` or `<schema>/<def>/invalid` for one of its defs. A valid case must
//! decode with the unknown key paths in `<case>.expect.json`, `{"unknown": [...]}`, in that
//! order, give the same paths to the hook, and encode again to the same JSON value without the
//! unknown keys. An invalid case must fail with the path and code in `<case>.expect.json` and
//! call no hook, as in Go and TypeScript.

#[path = "generated/registry.rs"]
mod registry;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use registry::Failure;
use serde_json::Value;

/// Ends the file next to a case that holds what it expects.
const EXPECT_SUFFIX: &str = ".expect.json";

/// What the hook got, one entry per call.
static HOOKED: Mutex<Vec<Vec<String>>> = Mutex::new(Vec::new());

/// The calls the hook got since the last time.
fn take_hooked() -> Vec<Vec<String>> {
    std::mem::take(&mut *HOOKED.lock().expect("the hook's calls"))
}

/// One fixture file and the folder it belongs to, like `order/delivery`.
struct Case {
    key: String,
    valid: bool,
    path: PathBuf,
}

/// What a case expects.
enum Want {
    /// A valid case: the paths of its unknown keys, in input order.
    Unknown(Vec<String>),
    /// An invalid case: the path and code of its error.
    Error(String, String),
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
/// is an expectation without a case next to it.
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
            // An expectation belongs to a case next to it, and is not a case itself.
            if !Path::new(&format!("{case}.json")).is_file() {
                failures.push(format!("{}: no case next to it", parts.join("/")));
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

/// What a case expects, from `<case>.expect.json`: `{"unknown": [...]}` for a valid case and
/// `{"path": ..., "code": ...}` for an invalid one. No other key is allowed.
fn expectation(case: &Case) -> Result<Want, String> {
    let name = case.path.to_string_lossy();
    let file = PathBuf::from(format!(
        "{}{EXPECT_SUFFIX}",
        name.strip_suffix(".json").unwrap_or(&name)
    ));
    let text = fs::read_to_string(&file).map_err(|error| {
        let name = file.file_name().unwrap_or_default().to_string_lossy();
        format!("every case needs {name}: {error}")
    })?;
    let shape = if case.valid {
        "{\"unknown\": [...]}"
    } else {
        "{\"path\": ..., \"code\": ...}"
    };
    let wrong = || format!("{}: expected {shape}", file.display());
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(&text) else {
        return Err(wrong());
    };
    if case.valid {
        let (Some(Value::Array(items)), 1) = (object.get("unknown"), object.len()) else {
            return Err(wrong());
        };
        let paths: Option<Vec<String>> = items
            .iter()
            .map(|item| item.as_str().map(str::to_owned))
            .collect();
        return paths.map(Want::Unknown).ok_or_else(wrong);
    }
    match (object.get("path"), object.get("code"), object.len()) {
        (Some(Value::String(path)), Some(Value::String(code)), 2) => {
            Ok(Want::Error(path.clone(), code.clone()))
        }
        _ => Err(wrong()),
    }
}

/// Removes the key a JSON Pointer names from a JSON value.
fn remove(value: &mut Value, path: &str) -> bool {
    let Some((parent, key)) = path.rsplit_once('/') else {
        return false;
    };
    let key = key.replace("~1", "/").replace("~0", "~");
    value
        .pointer_mut(parent)
        .and_then(Value::as_object_mut)
        .and_then(|object| object.remove(&key))
        .is_some()
}

#[test]
fn fixtures_round_trip() {
    example_report::set_unknown_key_hook(|paths| {
        HOOKED.lock().expect("the hook's calls").push(paths.to_vec());
    });
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
        take_hooked();
        let result = registry::round_trip(schema, def, &json);
        let hooked = take_hooked();
        let want = match expectation(case) {
            Ok(want) => want,
            Err(why) => {
                failures.push(format!("{name}: {why}"));
                continue;
            }
        };
        match (result, want) {
            (None, _) => failures.push(format!("{name}: no generated type for {}", case.key)),
            (Some(Ok((encoded, unknown))), Want::Unknown(expected)) => {
                if unknown != expected {
                    failures.push(format!(
                        "{name}: got unknown keys {unknown:?}, expected {expected:?}"
                    ));
                }
                let once = if unknown.is_empty() {
                    hooked.is_empty()
                } else {
                    hooked == [unknown.clone()]
                };
                if !once {
                    failures.push(format!(
                        "{name}: the hook got {hooked:?}, expected {unknown:?} once"
                    ));
                }
                let mut input: Value = serde_json::from_slice(&json).expect("valid JSON");
                for path in &unknown {
                    if !remove(&mut input, path) {
                        failures.push(format!("{name}: {path} is not a key of the input"));
                    }
                }
                if encoded != input {
                    failures.push(format!("{name}: encodes as {encoded}"));
                }
            }
            (Some(Err(error)), Want::Unknown(_)) => failures.push(format!("{name}: {error:?}")),
            (Some(Ok((encoded, _))), Want::Error(..)) => {
                failures.push(format!(
                    "{name}: decoded, expected an error, encodes as {encoded}"
                ));
            }
            (Some(Err(Failure::Encode(error))), Want::Error(..)) => {
                failures.push(format!("{name}: decoded, then failed to encode: {error}"));
            }
            (Some(Err(Failure::Decode(error))), Want::Error(path, code)) => {
                if error.path != path || error.code != code {
                    failures.push(format!(
                        "{name}: got path {:?} code {:?} ({error}), expected path {path:?} code {code:?}",
                        error.path, error.code
                    ));
                }
                if !hooked.is_empty() {
                    failures.push(format!("{name}: a failed decode called the hook with {hooked:?}"));
                }
            }
        }
    }
    example_report::clear_unknown_key_hook();
    assert!(
        failures.is_empty(),
        "{} of {} fixtures failed:\n{}",
        failures.len(),
        all.len(),
        failures.join("\n")
    );
}
