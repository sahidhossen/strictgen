/** What the playground shows before anything is typed, or when a link can't be read. */
import type { State } from "./state.js";

const ORDER = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://example.com/schemas/order.json",
  title: "Order",
  description: "An order with its lines and how it is paid.",
  type: "object",
  properties: {
    id: { description: "The order ID, like ord_1a2b.", type: "string", pattern: "^ord_[a-z0-9]+$" },
    status: { enum: ["pending", "paid", "shipped"] },
    lines: {
      description: "One to ten order lines.",
      type: "array",
      items: { $ref: "#/$defs/line" },
      minItems: 1,
      maxItems: 10,
    },
    note: { description: "A note for the packer.", type: "string", maxLength: 200 },
    payment: { $ref: "#/$defs/payment" },
  },
  required: ["id", "status", "lines", "payment"],
  additionalProperties: false,
  $defs: {
    line: {
      description: "One line of an order.",
      type: "object",
      properties: {
        sku: { description: "The stock keeping unit.", type: "string", minLength: 1 },
        quantity: { description: "How many units, 1 to 99.", type: "integer", minimum: 1, maximum: 99 },
      },
      required: ["sku", "quantity"],
      additionalProperties: false,
    },
    payment: {
      description: "How the order is paid, picked by its method key.",
      oneOf: [{ $ref: "#/$defs/card" }, { $ref: "#/$defs/invoice" }],
    },
    card: {
      description: "A payment card.",
      type: "object",
      properties: {
        method: { const: "card" },
        last4: { description: "The last four digits.", type: "string", pattern: "^[0-9]{4}$" },
      },
      required: ["method", "last4"],
      unevaluatedProperties: false,
    },
    invoice: {
      description: "An invoice, paid within the given days.",
      type: "object",
      properties: {
        method: { const: "invoice" },
        days: { description: "Days to pay, 7 to 60.", type: "integer", minimum: 7, maximum: 60 },
      },
      required: ["method", "days"],
      unevaluatedProperties: false,
    },
  },
};

const PAYLOAD = {
  id: "ord_1a2b",
  status: "paid",
  lines: [
    { sku: "TEA-01", quantity: 2 },
    { sku: "MUG-02", quantity: 0 },
  ],
  payment: { method: "card", last4: "4242" },
};

/** The example: one order schema and a payload with one problem in it. */
export const SAMPLE: State = {
  schemas: [{ name: "order.json", text: `${JSON.stringify(ORDER, null, 2)}\n` }],
  read: "strict",
  profiles: ["anthropic", "gemini", "openai"],
  cleanup: false,
  serdeBridge: false,
  ids: null,
  type: "Order",
  decoder: "normal",
  payload: `${JSON.stringify(PAYLOAD, null, 2)}\n`,
};
