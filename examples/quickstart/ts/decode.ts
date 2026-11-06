// Decodes one payload as an Order and gives what happened, as lines. The decoder is "json" for
// the normal one, "llm" for the one that reads a model's answer. scripts/docs.mjs reads the
// files and calls this, as the Rust and Go programs do from the command line.
import { DecodeError, decodeOrderFromJson, decodeOrderFromLlm, encodeOrderToJson } from "./generated/index.js";

export function decode(decoder: string, text: string): string[] {
  try {
    // docs:start decode
    const order = decoder === "llm" ? decodeOrderFromLlm(text) : decodeOrderFromJson(text);
    // docs:end decode
    return [`ok ${encodeOrderToJson(order)}`];
  } catch (error) {
    if (error instanceof DecodeError) return [`error ${error.message}`, `compact ${error.compact()}`];
    throw error;
  }
}
