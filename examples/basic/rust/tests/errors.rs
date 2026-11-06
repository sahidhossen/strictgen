//! Checks the shared decode error: its shape, message and compact form, the codes for input that
//! isn't JSON, how values show in `found`, and the key order of enum-keyed maps, as the Go and
//! TypeScript tests do.

use example_basic::{Decode, DecodeError, Event, Order, Role, User};

#[test]
fn decode_error_shape() {
    let error =
        Event::from_json(r#"{"id":"evt_1","type":"user.created","occurredAt":"t","attempt":12.0}"#)
            .expect_err("12.0 is not an integer");
    let want = DecodeError {
        path: "/attempt".to_owned(),
        code: DecodeError::WRONG_TYPE,
        expected: Some("an integer".to_owned()),
        found: Some("12.0".to_owned()),
    };
    assert_eq!(error, want);
    assert_eq!(
        error.to_string(),
        "/attempt: wrong type, expected an integer, found 12.0"
    );
    assert_eq!(
        error.compact(),
        "/attempt wrong_type, expected an integer, found 12.0"
    );
}

#[test]
fn messages_leave_out_what_is_absent() {
    let error = User::from_json("{}").expect_err("id is required");
    assert_eq!(error.to_string(), "/id: missing key");
    assert_eq!(error.compact(), "/id missing_key");
    let error = Role::from_json("null").expect_err("null is not a role");
    assert_eq!(error.to_string(), "null not allowed, expected a string");
    assert_eq!(error.compact(), "null_not_allowed, expected a string");
}

#[test]
fn json_error_codes() {
    let deep = format!("{}{}", "[".repeat(128), "]".repeat(128));
    let cases: [(&str, &[u8], &str); 7] = [
        ("syntax error", br#"{"id":"#, DecodeError::INVALID_JSON),
        ("invalid UTF-8", b"\"\xff\"", DecodeError::INVALID_JSON),
        ("lone surrogate", br#""\ud800""#, DecodeError::INVALID_JSON),
        ("trailing data", b"{} {}", DecodeError::INVALID_JSON),
        ("number out of range", b"1e400", DecodeError::INVALID_JSON),
        (
            "duplicate key",
            br#"{"id":"usr_1","id":"usr_2"}"#,
            DecodeError::DUPLICATE_KEY,
        ),
        ("too deep", deep.as_bytes(), DecodeError::TOO_DEEP),
    ];
    for (name, input, code) in cases {
        let error = User::from_json(input).expect_err(name);
        assert_eq!(error.code, code, "{name}: {error}");
    }
}

#[test]
fn json_error_texts() {
    let cases: [(&[u8], &str); 5] = [
        (
            br#"{"labels":{"a":1 "b":2}}"#,
            "/labels: invalid JSON, found a missing comma or closing brace at offset 17",
        ),
        (
            br#"{"id":"u","id":"v"}"#,
            "/id: duplicate key, found \"id\" at offset 10",
        ),
        (
            b"{} x",
            "invalid JSON, found trailing characters at offset 3",
        ),
        (
            br#"{"a":["\ud800"]}"#,
            "/a/0: invalid JSON, found a lone surrogate at offset 7",
        ),
        (
            b"\xef\xbb\xbf{}",
            "invalid JSON, found an invalid value at offset 0",
        ),
    ];
    for (input, want) in cases {
        let error = User::from_json(input).expect_err(want);
        assert_eq!(error.to_string(), want);
    }
    let error = User::from_json("[".repeat(128)).expect_err("too deep");
    assert_eq!(
        error.to_string(),
        format!(
            "{}: too deep, expected at most 127 nested arrays and objects, found more at offset 127",
            "/0".repeat(127)
        )
    );
}

/// Strings in `found` follow the same rule as Go and TypeScript: quoted, `"` and `\` escaped,
/// control characters, U+2028 and U+2029 as `\u` escapes, and cut to 64 code points.
#[test]
fn found_strings() {
    let smiles = "\u{1f600}".repeat(64);
    let cases = [
        (r#""a\"b\\c""#.to_owned(), r#""a\"b\\c""#.to_owned()),
        (
            "\"\\u0000\\u001f\u{7f}\u{85}\u{2028}\u{2029}\u{e9}\u{1f600}\"".to_owned(),
            "\"\\u0000\\u001f\\u007f\\u0085\\u2028\\u2029\u{e9}\u{1f600}\"".to_owned(),
        ),
        (format!("\"{smiles}\""), format!("\"{smiles}\"")),
        (format!("\"{smiles}\u{1f600}\""), format!("\"{smiles}\"...")),
    ];
    for (input, want) in cases {
        let error = Role::from_json(&input).expect_err("not a role");
        assert_eq!(error.code, DecodeError::NOT_IN_ENUM);
        assert_eq!(error.found.as_deref(), Some(want.as_str()), "{input}");
    }
}

/// An enum-keyed map writes its keys in code point order, like Go and TypeScript, not in the
/// enum's order.
#[test]
fn enum_keys_encode_in_code_point_order() {
    let user = User::from_json(
        r#"{"id":"usr_1","email":"a@example.com","role":"member","labels":{},"createdAt":"2024-01-02T03:04:05Z","quota":{"owner":1,"member":2,"admin":3}}"#,
    )
    .expect("a user");
    let text = serde_json::to_string(&user).expect("encodes");
    assert!(
        text.contains(r#""quota":{"admin":3,"member":2,"owner":1}"#),
        "{text}"
    );
    assert!(Role::Admin < Role::Member && Role::Member < Role::Owner);
}

/// The messages of constraint errors, the same as Go's `TestConstraintMessages` and the
/// TypeScript tests: counts in code points, items and keys, and numbers as JavaScript writes them.
#[test]
fn constraint_messages() {
    // An order with every required key, then the keys of the case.
    let order = |note: &str, rest: &str| {
        format!(r#"{{"id":"ord_5h1c","note":{note},"quantity":1,"tags":["a"]{rest}}}"#)
    };
    let cases = [
        (
            r#""😀""#,
            r#","price":1"#,
            "/note: too short, expected at least 2 characters, found 1 character",
        ),
        (
            r#""e\u0301e\u0301e\u0301""#,
            r#","price":1"#,
            "/note: too long, expected at most 5 characters, found 6 characters",
        ),
        (
            r#""ab""#,
            r#","price":1,"packSize":7"#,
            "/packSize: not a multiple, expected a multiple of 6, found 7",
        ),
        (
            r#""ab""#,
            r#","price":1,"packSize":50"#,
            "/packSize: too large, expected < 50, found 50",
        ),
        (
            r#""ab""#,
            r#","price":1E3"#,
            "/price: too large, expected < 1000, found 1000",
        ),
        (
            r#""ab""#,
            r#","price":1e-7"#,
            "/price: too small, expected >= 0.5, found 1e-7",
        ),
        (
            r#""ab""#,
            r#","price":1,"discount":-0"#,
            "/discount: too small, expected > 0, found -0",
        ),
        (
            r#""ab""#,
            r#","price":1,"discount":1e21"#,
            "/discount: too large, expected <= 0.75, found 1e+21",
        ),
        (
            r#""ab""#,
            r#","price":1,"attributes":{"c":"abc","b":"abc","a":"abc"}"#,
            "/attributes: too long, expected at most 2 keys, found 3 keys",
        ),
        (
            r#""ab""#,
            r#","price":1,"attributes":{"b":"x","a":"y"}"#,
            "/attributes/a: too short, expected at least 3 characters, found 1 character",
        ),
        (
            r#""a""#,
            r#","price":"1""#,
            "/price: wrong type, expected a number, found \"1\"",
        ),
    ];
    for (note, rest, want) in cases {
        let text = order(note, rest);
        let error = Order::from_json(&text).expect_err(want);
        assert_eq!(error.to_string(), want, "{text}");
    }
    let error =
        Order::from_json(r#"{"id":"ord_5h1c","note":"ab","quantity":1,"price":1,"tags":[]}"#)
            .expect_err("no tags");
    assert_eq!(
        error.to_string(),
        "/tags: too short, expected at least 1 item, found 0 items"
    );
}

#[test]
fn every_code_is_a_constant() {
    let codes = [
        (DecodeError::UNKNOWN_KEY, "unknown_key"),
        (DecodeError::MISSING_KEY, "missing_key"),
        (DecodeError::NULL_NOT_ALLOWED, "null_not_allowed"),
        (DecodeError::WRONG_TYPE, "wrong_type"),
        (DecodeError::BAD_TAG, "bad_tag"),
        (DecodeError::NOT_IN_ENUM, "not_in_enum"),
        (DecodeError::NOT_CONST, "not_const"),
        (DecodeError::TOO_SHORT, "too_short"),
        (DecodeError::TOO_LONG, "too_long"),
        (DecodeError::TOO_SMALL, "too_small"),
        (DecodeError::TOO_LARGE, "too_large"),
        (DecodeError::NOT_MULTIPLE_OF, "not_multiple_of"),
        (DecodeError::PATTERN_MISMATCH, "pattern_mismatch"),
        (DecodeError::BAD_FORMAT, "bad_format"),
        (DecodeError::NOT_UNIQUE, "not_unique"),
        (DecodeError::OUT_OF_RANGE_INTEGER, "out_of_range_integer"),
        (DecodeError::INVALID_JSON, "invalid_json"),
        (DecodeError::DUPLICATE_KEY, "duplicate_key"),
        (DecodeError::TOO_DEEP, "too_deep"),
    ];
    for (constant, code) in codes {
        assert_eq!(constant, code);
    }
}
