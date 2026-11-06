//! Runs the shared LLM vectors through the LLM decoders. Go and TypeScript run the same file, so
//! the three languages decode every payload to the same value, which equals the value the normal
//! decoder makes of the same JSON, and report the same error for every near miss.

use std::collections::BTreeSet;
use std::fmt::Debug;
use std::fs;

use example_llm::{
    Billing, Boxes, Card, Contact, Customer, Decode, DecodeError, Invoice, Line, OrderRequest,
    Payment, Picks, Remark, Sku, Status, Stock, decode_billing_from_llm, decode_boxes_from_llm,
    decode_card_from_llm, decode_contact_from_llm, decode_customer_from_llm,
    decode_invoice_from_llm, decode_line_from_llm, decode_order_request_from_llm,
    decode_payment_from_llm, decode_picks_from_llm, decode_remark_from_llm, decode_sku_from_llm,
    decode_status_from_llm, decode_stock_from_llm,
};
use serde_json::Value;

/// One vector: the payload a model sends, and the normal JSON of its value or its error.
struct Vector {
    name: String,
    llm: String,
    json: Option<String>,
    error: Option<String>,
}

/// Decodes the vector with the LLM decoder and checks the value or the error.
fn check<T: Decode + PartialEq + Debug>(v: &Vector, decode: fn(&str) -> Result<T, DecodeError>) {
    let got = decode(&v.llm);
    match (&v.json, &v.error) {
        (Some(json), None) => {
            let got = got.unwrap_or_else(|error| panic!("{}: {}", v.name, error.compact()));
            let want = T::from_json(json)
                .unwrap_or_else(|error| panic!("{}: the normal decoder fails: {error}", v.name));
            assert_eq!(got, want, "{}", v.name);
        }
        (None, Some(error)) => match got {
            Ok(value) => panic!("{}: decoded {value:?}, expected {error}", v.name),
            Err(got) => assert_eq!(&got.compact(), error, "{}", v.name),
        },
        _ => panic!("{}: needs one of json or error", v.name),
    }
}

#[test]
fn llm_vectors() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../llm-vectors.json");
    let text = fs::read_to_string(path).expect("the LLM vectors");
    let vectors: Vec<Value> = serde_json::from_str(&text).expect("a JSON array of vectors");
    assert!(vectors.len() >= 1000, "expected the full set of vectors");
    let mut seen = BTreeSet::new();
    for vector in &vectors {
        let object = vector.as_object().expect("a vector is an object");
        // A misspelled key would leave a vector half read, so only these keys are allowed.
        for key in object.keys() {
            assert!(
                ["name", "type", "llm", "json", "error"].contains(&key.as_str()),
                "unknown key {key} in {vector}"
            );
        }
        let field = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
        let v = Vector {
            name: field("name").expect("a name"),
            llm: field("llm").expect("an llm payload"),
            json: field("json"),
            error: field("error"),
        };
        let kind = field("type").expect("a type");
        match kind.as_str() {
            "Billing" => check::<Billing>(&v, decode_billing_from_llm),
            "Boxes" => check::<Boxes>(&v, decode_boxes_from_llm),
            "Card" => check::<Card>(&v, decode_card_from_llm),
            "Contact" => check::<Contact>(&v, decode_contact_from_llm),
            "Customer" => check::<Customer>(&v, decode_customer_from_llm),
            "Invoice" => check::<Invoice>(&v, decode_invoice_from_llm),
            "Line" => check::<Line>(&v, decode_line_from_llm),
            "OrderRequest" => check::<OrderRequest>(&v, decode_order_request_from_llm),
            "Payment" => check::<Payment>(&v, decode_payment_from_llm),
            "Picks" => check::<Picks>(&v, decode_picks_from_llm),
            "Remark" => check::<Remark>(&v, decode_remark_from_llm),
            "Sku" => check::<Sku>(&v, decode_sku_from_llm),
            "Status" => check::<Status>(&v, decode_status_from_llm),
            "Stock" => check::<Stock>(&v, decode_stock_from_llm),
            other => panic!("{}: no decoder for type {other}", v.name),
        }
        seen.insert(kind);
    }
    assert_eq!(
        seen.len(),
        14,
        "the vectors cover every type with an LLM decoder"
    );
}

/// An LLM decode leaves no LLM state behind on its thread: a normal decode after it still fails
/// on null for an optional key.
#[test]
fn llm_state_is_restored() {
    assert!(decode_customer_from_llm(r#"{"name": "Ann", "email": null, "contact": null}"#).is_ok());
    let error = Customer::from_json(r#"{"name": "Ann", "email": null}"#).expect_err("null fails");
    assert_eq!(
        error.compact(),
        "/email null_not_allowed, expected a string"
    );
}
