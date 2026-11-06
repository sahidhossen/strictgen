//! Checks the guard that ends an LLM decode on its thread. While one runs, null for an optional
//! key means absent; outside one it is an error. A decode that panics, or one inside another,
//! must leave the thread as it found it, so the next decode reads null the way it should.
//!
//! The generated helpers are compiled into this test as a module of its own, so it can decode
//! types written here: one that panics, and one with an optional key.

// The same lints as src/generated/mod.rs allows for every generated module, and the parts of the
// helpers this test doesn't use.
#[allow(
    dead_code,
    clippy::doc_markdown,
    clippy::enum_variant_names,
    clippy::large_enum_variant,
    reason = "the generated helpers, compiled here for the guard they hold"
)]
#[path = "../src/generated/helpers.rs"]
mod helpers;

use std::panic::{self, AssertUnwindSafe};

use helpers::{Decode, DecodeError, Node, Object};

/// A type whose decoding panics.
struct Panics;

impl Decode for Panics {
    fn decode_node(_: &Node<'_>) -> Result<Self, DecodeError> {
        panic!("this decode panics on purpose");
    }
}

/// An object with one optional key, `text`.
#[derive(Debug, PartialEq)]
struct Note {
    text: Option<String>,
}

impl Decode for Note {
    fn decode_node(node: &Node<'_>) -> Result<Self, DecodeError> {
        let mut object = Object::new(node)?;
        let text = object.optional("text")?;
        object.finish()?;
        Ok(Self { text })
    }
}

/// An object whose decoding runs an LLM decode of its own that panics, catches the panic, then
/// reads its optional key `text`.
#[derive(Debug, PartialEq)]
struct Outer {
    text: Option<String>,
}

impl Decode for Outer {
    fn decode_node(node: &Node<'_>) -> Result<Self, DecodeError> {
        let inner = quietly(|| helpers::from_llm::<Panics>("{}", false));
        assert!(inner.is_err(), "the inner decode panics");
        let mut object = Object::new(node)?;
        let text = object.optional("text")?;
        object.finish()?;
        Ok(Self { text })
    }
}

/// Runs `f`, catching a panic without printing it.
fn quietly<T>(f: impl FnOnce() -> T) -> std::thread::Result<T> {
    let hook = panic::take_hook();
    panic::set_hook(Box::new(|_| {}));
    let result = panic::catch_unwind(AssertUnwindSafe(f));
    panic::set_hook(hook);
    result
}

const NULL_TEXT: &str = r#"{"text":null}"#;

#[test]
fn null_is_absent_only_in_an_llm_decode() {
    assert_eq!(
        helpers::from_llm::<Note>(NULL_TEXT, false),
        Ok(Note { text: None })
    );
    let error = Note::from_json(NULL_TEXT).expect_err("null for an optional key fails");
    assert_eq!(error.code, DecodeError::NULL_NOT_ALLOWED);
}

#[test]
fn a_panic_ends_the_llm_decode() {
    assert!(quietly(|| helpers::from_llm::<Panics>("{}", false)).is_err());
    // The panicking decode is over, so this one is a normal decode again.
    let error = Note::from_json(NULL_TEXT).expect_err("null for an optional key fails");
    assert_eq!(error.code, DecodeError::NULL_NOT_ALLOWED);
    assert_eq!(
        helpers::from_llm::<Note>(NULL_TEXT, false),
        Ok(Note { text: None })
    );
}

#[test]
fn a_decode_inside_another_restores_the_outer_one() {
    // The inner LLM decode panics inside the outer one: the outer one still reads null as absent.
    assert_eq!(
        helpers::from_llm::<Outer>(NULL_TEXT, false),
        Ok(Outer { text: None })
    );
    // Inside a normal decode, the inner one ends with the normal decode still running.
    let error = Outer::from_json(NULL_TEXT).expect_err("null for an optional key fails");
    assert_eq!(error.code, DecodeError::NULL_NOT_ALLOWED);
}

#[test]
fn a_panic_on_one_thread_leaves_the_others_alone() {
    let other =
        std::thread::spawn(|| quietly(|| helpers::from_llm::<Panics>("{}", false)).is_err());
    assert!(other.join().expect("the thread ends"));
    let error = Note::from_json(NULL_TEXT).expect_err("null for an optional key fails");
    assert_eq!(error.code, DecodeError::NULL_NOT_ALLOWED);
}
