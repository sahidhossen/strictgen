//! Decodes every fixture under `examples/basic/fixtures` through the generated registry.
//!
//! A fixture lives in `<schema>/valid` or `<schema>/invalid` for a schema's root type, and in
//! `<schema>/<def>/valid` or `<schema>/<def>/invalid` for one of its defs. A valid case must
//! decode and encode again to the same JSON value. An invalid case must fail to decode.

#[path = "generated/registry.rs"]
mod registry;

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// One fixture file and the folder it belongs to, like `payment-method/card`.
struct Case {
    key: String,
    valid: bool,
    path: PathBuf,
}

/// Every fixture below `dir`, sorted by path.
fn cases(root: &Path, dir: &Path, out: &mut Vec<Case>) {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("reading {}: {error}", dir.display()))
        .map(|entry| entry.expect("a folder entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if !path.is_dir() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if name == "valid" || name == "invalid" {
            let key = dir.strip_prefix(root).expect("a folder below the root");
            let key = key
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>();
            let mut files: Vec<PathBuf> = fs::read_dir(&path)
                .expect("a fixture folder")
                .map(|entry| entry.expect("a fixture").path())
                .filter(|p| p.extension().is_some_and(|e| e == "json"))
                .collect();
            files.sort();
            for file in files {
                out.push(Case {
                    key: key.join("/"),
                    valid: name == "valid",
                    path: file,
                });
            }
        } else {
            cases(root, &path, out);
        }
    }
}

#[test]
fn fixtures_round_trip() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures");
    let mut all = Vec::new();
    cases(&root, &root, &mut all);
    assert!(!all.is_empty(), "no fixtures under {}", root.display());

    let mut failures = Vec::new();
    for case in &all {
        let json = fs::read_to_string(&case.path).expect("a readable fixture");
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
                let expected: Value = serde_json::from_str(&json).expect("valid JSON");
                if encoded != expected {
                    failures.push(format!("{name}: encodes as {encoded}"));
                }
            }
            (Some(Err(error)), true) => failures.push(format!("{name}: {error}")),
            (Some(Ok(encoded)), false) => {
                failures.push(format!(
                    "{name}: decoded, expected an error, encodes as {encoded}"
                ));
            }
            (Some(Err(_)), false) => {}
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
