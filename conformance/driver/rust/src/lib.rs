//! The Rust code strictgen generates for `conformance/schemas`, once per read mode.
//!
//! The conformance runner writes `src/strict` and `src/report` before it builds the crate, so
//! the crate only builds inside the runner's temporary folder.

pub mod report;
pub mod strict;
