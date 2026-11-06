//! Decodes the fixtures of the constrained alias `Tags` with `Tags::from_json` and
//! `Tags::report_from_json`, the standard entry points. A constrained alias is a type of its
//! own, so both check its constraints and fail as the registry does.

use std::fs;

use example_report::{Decode, Tags};
use serde_json::Value;

#[test]
fn tags_fixtures_through_from_json() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/order/tags");
    let mut count = 0;
    for kind in ["valid", "invalid"] {
        let mut paths: Vec<_> = fs::read_dir(format!("{root}/{kind}"))
            .expect("the tags fixtures")
            .map(|entry| entry.expect("a folder entry").path())
            .filter(|path| !path.to_string_lossy().ends_with(".expect.json"))
            .collect();
        paths.sort();
        for path in paths {
            count += 1;
            let name = path.display().to_string();
            let data = fs::read(&path).expect("a fixture");
            let decoded = Tags::from_json(&data);
            let reported = Tags::report_from_json(&data);
            if kind == "valid" {
                let value = decoded.unwrap_or_else(|error| panic!("{name}: {error}"));
                let reported = reported.unwrap_or_else(|error| panic!("{name}: {error}"));
                assert_eq!(reported.value, value, "{name}");
                assert!(reported.unknown.is_empty(), "{name}");
                let encoded = serde_json::to_value(&value).expect("encodes");
                let input: Value = serde_json::from_slice(&data).expect("JSON");
                assert_eq!(encoded, input, "{name}");
                continue;
            }
            let expect = name.trim_end_matches(".json").to_owned() + ".expect.json";
            let want: Value =
                serde_json::from_slice(&fs::read(&expect).expect("an expectation")).expect("JSON");
            for error in [
                decoded.expect_err(&name),
                reported.map(|r| r.value).expect_err(&name),
            ] {
                assert_eq!(error.path, want["path"], "{name}");
                assert_eq!(error.code, want["code"], "{name}");
            }
        }
    }
    assert!(count > 0, "no fixtures for order/tags");
}
