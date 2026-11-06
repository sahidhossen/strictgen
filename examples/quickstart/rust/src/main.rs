//! Decodes each file given as an `Order` and prints what happened. The first argument picks the
//! decoder: `json` for the normal one, `llm` for the one that reads a model's answer.
//!
//! ```text
//! cargo run -q -- json ../payloads/zero-quantity.json
//! ```

use std::{env, fs, process};

use example_quickstart::{Decode, DecodeError, Order, decode_order_from_llm};

/// The lines printed for one decode: the value written again, or the error.
fn lines(result: Result<Order, DecodeError>) -> Vec<String> {
    match result {
        Ok(order) => vec![format!(
            "ok {}",
            serde_json::to_string(&order).expect("encodes")
        )],
        Err(error) => vec![
            format!("error {error}"),
            format!("compact {}", error.compact()),
        ],
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some((decoder, files)) = args.split_first() else {
        eprintln!("usage: decode json|llm <file>...");
        process::exit(2);
    };
    for file in files {
        let text = fs::read_to_string(file).unwrap_or_else(|error| {
            eprintln!("{file}: {error}");
            process::exit(2);
        });
        // docs:start decode
        let result = match decoder.as_str() {
            "llm" => decode_order_from_llm(&text),
            _ => Order::from_json(&text),
        };
        // docs:end decode
        println!("file {file}");
        for line in lines(result) {
            println!("{line}");
        }
    }
}
