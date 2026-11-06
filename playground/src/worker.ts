/**
 * The playground's worker: generation and decoding run here, so the page stays responsive and a
 * decoder that never returns (a catastrophic pattern) is stopped by terminating the worker.
 */
import profiles from "strictgen:profiles";
import ts from "typescript";

import { transpiler } from "./decode.js";
import type { Request } from "./session.js";
import { respond, Session } from "./session.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: unknown) => void;
}

const scope = self as unknown as WorkerScope;
const session = new Session(transpiler(ts), profiles);

scope.onmessage = (event) => {
  try {
    scope.postMessage(respond(session, event.data));
  } catch (error) {
    // A bug in the playground itself; the page shows it rather than waiting for the timeout.
    scope.postMessage({ id: event.data.id, failure: error instanceof Error ? error.message : String(error) });
  }
};
scope.postMessage({ ready: true });
