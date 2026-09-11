/**
 * attempt.jsx — one reference per attempt at saving a document.
 *
 * Why a form needs this at all
 * ----------------------------
 * When the connection drops after a save has left the browser, nobody can
 * tell "the server never got it" from "the server posted it and the reply
 * died on the way back". The server side of the answer is a reference it
 * stores with the document: send the same one twice and the second is
 * recognised rather than posted. But that only works if the browser sends the
 * SAME reference on the retry — and a fresh one per button press is exactly
 * what a form does by default.
 *
 * So the reference belongs to the ATTEMPT, not the request. It is minted the
 * first time a form tries to save, kept while that attempt is unresolved —
 * including across a page reload, which is what makes it survive the reload a
 * frustrated cashier will do — and thrown away only when the document is
 * actually saved, or when the form is abandoned.
 *
 * Deliberately NOT derived from the contents. Two walk-in customers buying the
 * same thing a minute apart produce identical bodies, and a content hash would
 * refuse the second sale as a duplicate of the first. Only an explicit
 * per-attempt reference can tell a retry from a repeat.
 */
import React from "react";
import { newClientRef } from "./api.js";

const KEY = (name) => `vy_attempt_${name}`;

function read(name) {
  try { return sessionStorage.getItem(KEY(name)) || null; } catch { return null; }
}
function write(name, v) {
  try { if (v) sessionStorage.setItem(KEY(name), v); else sessionStorage.removeItem(KEY(name)); } catch { /* private mode */ }
}

/**
 * `const attempt = useAttempt("payment")` then send `client_ref: attempt.ref()`
 * and call `attempt.done()` once the server has confirmed.
 *
 * `name` scopes the reference to a kind of document, so a half-finished
 * payment and a half-finished expense do not share one. Two of the same kind
 * open at once would, which is why `done()` runs on success AND on close.
 *
 * sessionStorage rather than localStorage, and per tab on purpose: two tills
 * in two tabs of the same browser are two different attempts, and sharing a
 * reference between them would make the second till's genuine payment look
 * like a retry of the first's.
 */
export function useAttempt(name) {
  const live = React.useRef(null);
  return React.useMemo(() => ({
    ref() {
      if (!live.current) live.current = read(name) || newClientRef();
      write(name, live.current);
      return live.current;
    },
    /* Saved. The next document this form makes is a new document, so it gets
       a new reference — otherwise the server would recognise it as this one. */
    done() { live.current = null; write(name, null); },
  }), [name]);
}

/**
 * The same thing without a component around it, for a save that happens
 * outside React state — the till's cart, a bulk import loop.
 */
export function attemptRef(name) {
  const v = read(name) || newClientRef();
  write(name, v);
  return v;
}
export function attemptDone(name) { write(name, null); }
