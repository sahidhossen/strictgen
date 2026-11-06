//! Runs the shared cleanup vectors through `clean_llm_json`. Go and TypeScript run the same
//! file, so the three languages clean every input to the same output.

use std::fs;

use example_llm::clean_llm_json;
use serde_json::Value;

#[test]
fn cleanup_vectors() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../cleanup-vectors.json");
    let text = fs::read_to_string(path).expect("the cleanup vectors");
    let vectors: Vec<Value> = serde_json::from_str(&text).expect("a JSON array of vectors");
    assert!(vectors.len() > 40, "expected the full set of vectors");
    for vector in &vectors {
        let field = |key: &str| {
            vector[key]
                .as_str()
                .unwrap_or_else(|| panic!("{key} must be a string in {vector}"))
                .to_owned()
        };
        let (name, input, output) = (field("name"), field("input"), field("output"));
        assert_eq!(clean_llm_json(&input), output, "{name}");
        // A misspelled key would leave a vector half read, so every vector has exactly these.
        assert_eq!(
            vector.as_object().map(serde_json::Map::len),
            Some(3),
            "{name}: only name, input, output"
        );
    }
}
