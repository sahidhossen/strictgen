//! Decodes conformance requests with the Rust code strictgen generates, many per process.
//!
//! Reads one JSON request per line on stdin and writes one JSON result per line on stdout, in
//! request order, in the format `src/conformance/protocol.ts` describes. The runner writes the
//! generated packages, `lib.rs` and `dispatch.rs`, which maps each package and type name to the
//! generated type: its public entry points, `T::from_json` and `T::report_from_json`, its LLM
//! decoder, `decode_x_from_llm`, and the package's cleanup step, `clean_llm_json`.

use std::any::Any;
use std::io::{self, BufRead, BufWriter, Write};
use std::panic::{self, AssertUnwindSafe};
use std::process::ExitCode;

use serde_json::{Value, json};

/// The error code of a decoder that panicked instead of returning an error.
const CRASH: &str = "crash";

/// The five fields of a decode error, the same in every language.
pub struct Fields {
    path: String,
    code: String,
    expected: Option<String>,
    found: Option<String>,
    message: String,
}

/// What one decode gave.
pub enum Outcome {
    /// The value decoded with these unknown key paths, then encoded again or failed to. For the
    /// cleanup step, the text it returned.
    Accepted {
        unknown: Vec<String>,
        encoded: Result<String, String>,
    },
    /// The input was rejected.
    Rejected(Fields),
}

/// The fields of a generated `DecodeError`, which each package has its own of.
macro_rules! fields {
    ($error:expr) => {{
        let error = $error;
        $crate::Fields {
            path: error.path.clone(),
            code: error.code.to_owned(),
            expected: error.expected.clone(),
            found: error.found.clone(),
            message: error.to_string(),
        }
    }};
}

/// Decodes `$json` as `$module::$ty` in strict mode, then encodes the value again.
macro_rules! strict_outcome {
    ($module:ident, $ty:ident, $json:expr) => {
        match <$module::$ty as $module::Decode>::from_json($json) {
            Ok(value) => $crate::Outcome::Accepted {
                unknown: Vec::new(),
                encoded: serde_json::to_string(&value).map_err(|error| error.to_string()),
            },
            Err(error) => $crate::Outcome::Rejected(fields!(error)),
        }
    };
}

/// Decodes `$json` as `$module::$ty` in report mode, then encodes the value again.
macro_rules! report_outcome {
    ($module:ident, $ty:ident, $json:expr) => {
        match <$module::$ty as $module::Decode>::report_from_json($json) {
            Ok(reported) => $crate::Outcome::Accepted {
                unknown: reported.unknown,
                encoded: serde_json::to_string(&reported.value).map_err(|error| error.to_string()),
            },
            Err(error) => $crate::Outcome::Rejected(fields!(error)),
        }
    };
}

/// The outcome of an LLM decoder's result: LLM decoders are strict, so no key is unknown.
macro_rules! llm_outcome {
    ($decoded:expr) => {
        match $decoded {
            Ok(value) => $crate::Outcome::Accepted {
                unknown: Vec::new(),
                encoded: serde_json::to_string(&value).map_err(|error| error.to_string()),
            },
            Err(error) => $crate::Outcome::Rejected(fields!(error)),
        }
    };
}

mod dispatch;

/// The bytes lowercase or uppercase hex spells.
fn from_hex(hex: &str) -> Result<Vec<u8>, String> {
    if !hex.len().is_multiple_of(2) {
        return Err("hex has an odd length".to_owned());
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            hex.get(i..i + 2)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| format!("hex has a bad digit near offset {i}"))
        })
        .collect()
}

/// The message a panic carried.
fn panic_message(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a panic without a message".to_owned())
}

/// Runs one request through the decoder it names, or `None` when the package has no such type.
fn outcome(
    package: &str,
    decoder: &str,
    ty: &str,
    bytes: &[u8],
) -> Result<Option<Outcome>, String> {
    if decoder == "normal" {
        return Ok(dispatch::decode(package, ty, bytes));
    }
    // The LLM decoders and the cleanup step take text, and the runner only sends them text.
    let text =
        std::str::from_utf8(bytes).map_err(|_| format!("the {decoder} input is not UTF-8"))?;
    Ok(match decoder {
        "llm" => dispatch::llm(package, ty, text),
        "cleanup" => dispatch::clean(package, text).map(|cleaned| Outcome::Accepted {
            unknown: Vec::new(),
            encoded: Ok(cleaned),
        }),
        _ => return Err(format!("decoder {decoder:?} is not supported")),
    })
}

/// The result line for one request line.
fn answer(line: &str) -> Result<Value, String> {
    let request: Value = serde_json::from_str(line).map_err(|error| error.to_string())?;
    let text = |name: &str| {
        request
            .get(name)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("no {name}"))
    };
    let id = request
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| "no id".to_owned())?;
    let (ty, mode, decoder, package) = (
        text("type")?,
        text("mode")?,
        text("decoder")?,
        text("package")?,
    );
    if !matches!(decoder, "normal" | "llm" | "cleanup") {
        return Err(format!("decoder {decoder:?} is not supported"));
    }
    if mode != "strict" && mode != "report" {
        return Err(format!("mode {mode:?} is not supported"));
    }
    // `T::from_json` and `T::report_from_json` are both the public entry points and what the
    // generated fixture registry calls, so both entries decode the same way.
    let entry = text("entry")?;
    if entry != "public" && entry != "registry" {
        return Err(format!("entry {entry:?} is not supported"));
    }
    let bytes = from_hex(text("hex")?)?;
    let outcome = panic::catch_unwind(AssertUnwindSafe(|| outcome(package, decoder, ty, &bytes)))
        .unwrap_or_else(|payload| {
            Ok(Some(Outcome::Rejected(Fields {
                path: String::new(),
                code: CRASH.to_owned(),
                expected: None,
                found: None,
                message: panic_message(payload.as_ref()),
            })))
        })?
        .ok_or_else(|| format!("no {decoder} decoder for type {ty} in package {package}"))?;
    Ok(match outcome {
        Outcome::Accepted { unknown, encoded } => {
            let (encoded, encode_error) = match encoded {
                Ok(text) => (Some(text), None),
                Err(why) => (None, Some(why)),
            };
            json!({
                "id": id,
                "accepted": true,
                "error": null,
                "unknown": unknown,
                "encoded": encoded,
                "encodeError": encode_error,
            })
        }
        Outcome::Rejected(error) => json!({
            "id": id,
            "accepted": false,
            "error": {
                "path": error.path,
                "code": error.code,
                "expected": error.expected,
                "found": error.found,
                "message": error.message,
            },
            "unknown": null,
            "encoded": null,
            "encodeError": null,
        }),
    })
}

fn main() -> ExitCode {
    // A panic in a decoder is a result, reported with the code "crash", so keep it off stderr.
    panic::set_hook(Box::new(|_| {}));
    let mut out = BufWriter::new(io::stdout().lock());
    for (index, line) in io::stdin().lock().lines().enumerate() {
        let written = line
            .map_err(|error| error.to_string())
            .and_then(|line| answer(&line))
            .and_then(|result| writeln!(out, "{result}").map_err(|error| error.to_string()));
        if let Err(why) = written {
            eprintln!("conformance-driver: request on line {}: {why}", index + 1);
            return ExitCode::from(2);
        }
    }
    if let Err(error) = out.flush() {
        eprintln!("conformance-driver: {error}");
        return ExitCode::from(2);
    }
    ExitCode::SUCCESS
}
