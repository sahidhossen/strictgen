//! Checks the serde bridge (`serdeBridge` in `strictgen.json`): a generated type inside a
//! hand-written serde type decodes with the strict decoder, and reports its errors in the compact
//! form, with paths relative to the generated value.

use std::collections::BTreeMap;

use example_basic::{Decode, Event, Shipment, User, UserId};
use serde::Deserialize;

/// A hand-written envelope, which serde decodes, holding generated types.
#[derive(Debug, Deserialize)]
struct Envelope {
    user: User,
    events: Vec<Event>,
}

const USER: &str = r#"{"id":"usr_8f2k","email":"ada@example.com","role":"member","labels":{},"createdAt":"2026-01-15T09:30:00Z"}"#;

/// A valid event, with `attempt` as the JSON text of its attempt key.
fn event(attempt: &str) -> String {
    format!(
        r#"{{"id":"evt_1","type":"user.created","occurredAt":"2026-01-15T09:30:00Z","attempt":{attempt},"user":{USER}}}"#
    )
}

#[test]
fn decodes_generated_types_inside_serde_types() {
    let text = format!(r#"{{"user":{USER},"events":[{}]}}"#, event("1"));
    let envelope: Envelope = serde_json::from_str(&text).expect("a valid envelope");
    assert_eq!(envelope.user, User::from_json(USER).expect("a valid user"));
    let want = Event::from_json(event("1")).expect("a valid event");
    assert_eq!(envelope.events, vec![want]);
}

#[test]
fn reports_the_compact_form_with_the_path_inside_the_value() {
    let (good, bad) = (event("1"), event("12.0"));
    let text = format!(r#"{{"user":{USER},"events":[{good},{bad}]}}"#);
    let error = serde_json::from_str::<Envelope>(&text).expect_err("12.0 is not an integer");
    // The path is inside the event, not /events/1/attempt.
    let compact = Event::from_json(&bad)
        .expect_err("12.0 is not an integer")
        .compact();
    assert_eq!(
        compact,
        "/attempt wrong_type, expected an integer, found 12.0"
    );
    assert_eq!(
        error.to_string(),
        format!(
            "{compact} at line {} column {}",
            error.line(),
            error.column()
        )
    );
    assert!(error.is_data());
}

#[test]
fn keeps_every_strict_check_inside_the_value() {
    let twice = r#"{"id":"usr_1","id":"usr_2"}"#;
    let error = serde_json::from_str::<User>(twice).expect_err("id is given twice");
    let compact = User::from_json(twice)
        .expect_err("id is given twice")
        .compact();
    assert!(compact.starts_with("/id duplicate_key"), "{compact}");
    assert!(error.to_string().starts_with(&compact), "{error}");

    let unknown = USER.replace(r#""role""#, r#""nickname":"ada","role""#);
    let error = serde_json::from_str::<User>(&unknown).expect_err("nickname is not a key");
    assert!(
        error.to_string().starts_with("/nickname unknown_key"),
        "{error}"
    );
}

#[test]
fn leaves_what_is_around_the_value_to_serde() {
    // The envelope is serde's own: it ignores a key it doesn't know, which the strict decoder
    // never would.
    let text = format!(r#"{{"user":{USER},"events":[],"extra":true}}"#);
    assert!(serde_json::from_str::<Envelope>(&text).is_ok());
    // A serde map keeps the last of two equal keys; each value is still decoded strictly.
    let ids: BTreeMap<String, UserId> =
        serde_json::from_str(r#"{"a":"usr_1","a":"usr_2"}"#).expect("serde keeps the last key");
    assert_eq!(ids.get("a"), Some(&UserId("usr_2".to_owned())));
}

#[test]
fn reads_a_serde_json_value_through_its_text() {
    let value = serde_json::json!({"id": "usr_1", "email": "a@example.com", "role": "member", "labels": {}, "createdAt": "2026-01-15T09:30:00Z"});
    let user: User = serde_json::from_value(value).expect("a valid user");
    assert_eq!(user.id, UserId("usr_1".to_owned()));
}

/// A serde type that buffers its input before decoding the generated type in it.
#[derive(Debug, Deserialize)]
#[allow(dead_code, reason = "only decoded")]
struct Flattened {
    #[serde(flatten)]
    inner: Owner,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code, reason = "only decoded")]
struct Owner {
    owner: UserId,
}

#[test]
fn fails_where_serde_buffers_the_input() {
    let error = serde_json::from_str::<Flattened>(r#"{"owner":"usr_1"}"#)
        .expect_err("flatten buffers the input, which has no raw text");
    assert!(
        error
            .to_string()
            .starts_with("invalid type: newtype struct, expected any valid JSON value"),
        "{error}"
    );
}

/// Levels of a hand-written serde type around a shipment.
#[derive(Debug, Deserialize)]
#[allow(dead_code, reason = "only decoded")]
struct Nest {
    next: Option<Box<Nest>>,
    shipment: Option<Shipment>,
}

/// A valid shipment whose `extra` holds one value `depth` arrays deep.
fn shipment(depth: usize) -> String {
    format!(
        r#"{{"id":"123e4567-e89b-12d3-a456-426614174000","tracking":"AB123456789US","shippedAt":"2024-02-29T23:59:60Z","extra":[{}{}]}}"#,
        "[".repeat(depth),
        "]".repeat(depth)
    )
}

/// `levels` levels of `Nest`, the last holding `inner`.
fn nest(levels: usize, inner: &str) -> String {
    let mut text = format!(r#"{{"shipment":{inner}}}"#);
    for _ in 1..levels {
        text = format!(r#"{{"next":{text}}}"#);
    }
    text
}

#[test]
fn counts_depth_from_the_bridged_value() {
    // 70 levels of serde's own around a value 120 deep: the raw text serde_json collects isn't
    // counted, and the strict limit counts from the shipment.
    assert!(serde_json::from_str::<Nest>(&nest(70, &shipment(120))).is_ok());
    // Past the strict limit inside the value, too_deep, with the path inside the shipment.
    let error = serde_json::from_str::<Nest>(&nest(2, &shipment(130))).expect_err("too deep");
    assert!(error.to_string().starts_with("/extra/0/0/"), "{error}");
    assert!(error.to_string().contains(" too_deep, "), "{error}");
    // Past serde_json's own limit in the hand-written levels.
    let error = serde_json::from_str::<Nest>(&nest(140, &shipment(0))).expect_err("too deep");
    assert!(
        error.to_string().starts_with("recursion limit exceeded"),
        "{error}"
    );
}
