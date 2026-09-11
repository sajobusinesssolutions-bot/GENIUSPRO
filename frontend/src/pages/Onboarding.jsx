/**
 * Onboarding.jsx — the screens somebody sees before they have an account.
 *
 * Three flows, all of them sitting inside the sign-in screen's own furniture
 * rather than in a design of their own: creating an account, recovering a
 * password, and accepting an invitation. Every one of them is a stranger's
 * first look at this product, so they use the same box, the same fields and
 * the same one button as signing in.
 *
 * ── what these screens are careful about ──────────────────────────────────
 *
 * **One thing is asked at a time.** Sign-up is three short steps rather than
 * one long form, because the middle step — the code — cannot be filled in from
 * the same screen anyway: the person has to go to their email and come back.
 *
 * **The code field is six boxes and accepts a paste.** People copy the code
 * out of the email rather than reading and retyping it, and six separate
 * inputs that each swallow one character of a pasted string is the classic way
 * to make that fail.
 *
 * **Nothing here says whether an address is known.** The server answers
 * identically for a new address and a registered one; a screen that said
 * "that email is taken" would hand the whole property back.
 *
 * **A failure is never a dead end.** Every error leaves the person on a screen
 * with a way forward — resend, go back, or sign in instead.
 */
import React, { useEffect, useRef, useState } from "react";
import api, { setSession } from "../lib/api.js";
import { deviceToken, setDeviceToken } from "../lib/device.js";
import { checkServer, setServer } from "../lib/server.js";

/* ── shared pieces ───────────────────────────────────────────────────────── */

function Field({ label, hint, children }) {
  return (
    <label className="dk-login-field">
      <span>{label}</span>
      {children}
      {hint && <em style={{ fontSize: 11.5, color: "var(--faint)", fontStyle: "normal" }}>{hint}</em>}
    </label>
  );
}

/** Six boxes, one real input behind them — the same trick the PIN pad uses. */
function CodeBoxes({ value, onChange, onEnter }) {
  const id = "dk-code-input";
  return (
    <div style={{ position: "relative" }}>
      <div className="dk-pin dk-n" onClick={() => document.getElementById(id)?.focus()}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={`cell ${i === value.length ? "here" : ""}`}>
            {i < value.length ? value[i] : i === value.length ? <i /> : ""}
          </div>
        ))}
      </div>
      <input id={id} inputMode="numeric" autoComplete="one-time-code" autoFocus aria-label="Six-digit code"
             value={value}
             onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
             onKeyDown={(e) => { if (e.key === "Enter" && value.length === 6) onEnter(); }}
             style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%" }} />
    </div>
  );
}

/** The sign-in screen's box, reused so these screens are visibly the same product. */
function Panel({ title, sub, err, note, children, action, actionLabel, busy, disabled, back, backLabel = "Back", after }) {
  return (
    <div className="dk-login-box">
      <div>
        <h2>{title}</h2>
        <div className="who">{sub || " "}</div>
      </div>
      {err && <div className="dk-login-err">{err}</div>}
      {note && <div style={{ fontSize: 12.5, color: "var(--soft)", lineHeight: 1.6 }}>{note}</div>}
      {children}
      {/* Always rendered, disabled when the form is not ready.
          The first version omitted the button entirely until every field was
          filled, which the screenshot showed for what it is: a sign-up screen
          whose only visible action is "I already have an account". A disabled
          button says what will happen next; a missing one says nothing. */}
      {action && (
        <button className="dk-login-go" onClick={action} disabled={busy || disabled}>
          {busy ? "Working…" : actionLabel}
        </button>
      )}
      {after}
      {back && (
        <button onClick={back} style={quietLink}>{backLabel}</button>
      )}
    </div>
  );
}

/* Secondary actions are text, not buttons. There is one primary on each of
   these screens and it is the blue one; anything else competing at the same
   weight makes a stranger guess which is the way forward. */
const quietLink = {
  alignSelf: "center", background: "none", border: 0, padding: 4, cursor: "pointer",
  fontSize: 12.5, fontWeight: 650, color: "var(--soft)", textDecoration: "underline",
};

const messageOf = (e) => (e && e.message) || "That did not work";

/* ── Create an account ───────────────────────────────────────────────────── */

export function SignUp({ onIn, onBack }) {
  const [step, setStep] = useState("who");     // who → code → business
  const [f, setF] = useState({ full_name: "", email: "", password: "" });
  const [code, setCode] = useState("");
  const [ticket, setTicket] = useState("");
  /* Shown once, on their own screen, and never fetched again. */
  const [codes, setCodes] = useState(null);
  const [pending, setPending] = useState(null);
  const [biz, setBiz] = useState({ name: "", gstin: "", phone: "", address: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const setB = (k) => (e) => setBiz((s) => ({ ...s, [k]: e.target.value }));

  const signUp = async () => {
    setErr(""); setBusy(true);
    try {
      await api.post("/auth/signup", f);
      setStep("code");
    } catch (e) { setErr(messageOf(e)); }
    setBusy(false);
  };

  const verify = async () => {
    setErr(""); setBusy(true);
    try {
      const d = await api.post("/auth/verify", { email: f.email, code });
      /* Proving the address just did, by hand, exactly what the sign-in code
         asks for — so this device is trusted from here and the next sign-in
         does not ask again. */
      setDeviceToken(d.device_token);
      if (d.backup_codes) setCodes(d.backup_codes);
      if (d.ticket) { setTicket(d.ticket); setStep(d.backup_codes ? "backup" : "business"); }
      else {
        /* Verified late, and the account already has a business — the server
           hands back a real session instead of a ticket. */
        if (d.backup_codes) { setPending(d); setStep("backup"); }
        else { setSession(d); onIn(d.user); }
      }
    } catch (e) { setErr(messageOf(e)); setCode(""); }
    setBusy(false);
  };

  const resend = async () => {
    setErr("");
    try { await api.post("/auth/resend", { email: f.email, purpose: "verify" }); setErr(""); setCode(""); }
    catch (e) { setErr(messageOf(e)); }
  };

  const create = async () => {
    setErr(""); setBusy(true);
    try {
      const d = await api.post("/auth/first-company", { ticket, ...biz });
      setSession(d);
      onIn(d.user);
    } catch (e) { setErr(messageOf(e)); }
    setBusy(false);
  };

  if (step === "who") {
    const ready = f.full_name.trim() && f.email.trim() && f.password.length >= 8;
    return (
      <Panel title="Create your account" sub="It takes about a minute" err={err} busy={busy}
             action={signUp} disabled={!ready} actionLabel="Send me a code"
             back={onBack} backLabel="I already have an account">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Your name">
            <input value={f.full_name} autoFocus onChange={set("full_name")} />
          </Field>
          <Field label="Email address" hint="This is how you sign in, and where your businesses are tied.">
            <input type="email" value={f.email} autoComplete="username" onChange={set("email")} />
          </Field>
          <Field label="Choose a password" hint="At least 8 characters.">
            <input type="password" value={f.password} autoComplete="new-password" onChange={set("password")}
                   onKeyDown={(e) => e.key === "Enter" && ready && signUp()} />
          </Field>
        </div>
      </Panel>
    );
  }

  if (step === "code") {
    /* The address is on the subtitle line already, so the note does not repeat
       it — the first version said the same address three times on one small
       screen. */
    return (
      <Panel title="Check your email" sub={f.email} err={err} busy={busy}
             note="Type the six-digit code we have just sent. It lasts 15 minutes."
             action={verify} disabled={code.length !== 6} actionLabel="Confirm"
             after={<button onClick={resend} style={quietLink}>Send it again</button>}
             back={() => { setStep("who"); setErr(""); }} backLabel="Use a different address">
        <CodeBoxes value={code} onChange={setCode} onEnter={() => code.length === 6 && verify()} />
      </Panel>
    );
  }

  if (step === "backup") {
    return (
      <BackupCodes
        codes={codes}
        onDone={() => {
          setCodes(null);
          /* Verified late, with a business already there: the session was held
             back until the codes had been seen, precisely so this screen could
             not be skipped past. */
          if (pending) { setSession(pending); onIn(pending.user); return; }
          setStep("business");
        }}
      />
    );
  }

  return (
    <Panel title="Tell us about the business" sub={f.email} err={err} busy={busy}
           note="Everything you sell, buy and owe lives inside a business. You can add more later."
           action={create} disabled={!biz.name.trim()} actionLabel="Open the shop">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Business name"><input value={biz.name} autoFocus onChange={setB("name")}
                                            placeholder="e.g. Kampala Hardware" /></Field>
        <Field label="Tax number (TIN)" hint="Optional — you can add it later."><input value={biz.gstin} onChange={setB("gstin")} /></Field>
        <Field label="Phone"><input value={biz.phone} onChange={setB("phone")} /></Field>
      </div>
    </Panel>
  );
}

/* ── Forgotten password ──────────────────────────────────────────────────── */

export function Forgot({ onBack }) {
  const [step, setStep] = useState("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    setErr(""); setBusy(true);
    try { await api.post("/auth/forgot", { email }); setStep("code"); }
    catch (e) { setErr(messageOf(e)); }
    setBusy(false);
  };

  const finish = async () => {
    setErr(""); setBusy(true);
    try { await api.post("/auth/reset", { email, code, password }); setStep("done"); }
    catch (e) { setErr(messageOf(e)); }
    setBusy(false);
  };

  if (step === "email") {
    return (
      <Panel title="Forgotten your password?" sub="We will send a code" err={err} busy={busy}
             note="Type the address you signed up with. If it is on our system, a six-digit code will arrive."
             action={ask} disabled={!email.trim()} actionLabel="Send the code"
             back={onBack} backLabel="Back to sign in">
        <Field label="Email address">
          <input type="email" value={email} autoFocus autoComplete="username"
                 onChange={(e) => setEmail(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && email.trim() && ask()} />
        </Field>
      </Panel>
    );
  }

  if (step === "code") {
    const ready = code.length === 6 && password.length >= 8;
    return (
      <Panel title="Set a new password" sub={email} err={err} busy={busy}
             note="The code lasts 30 minutes. Using it signs this account out everywhere else."
             action={finish} disabled={!ready} actionLabel="Change my password"
             back={() => { setStep("email"); setErr(""); }} backLabel="Back">
        <CodeBoxes value={code} onChange={setCode} onEnter={() => ready && finish()} />
        <Field label="New password" hint="At least 8 characters.">
          <input type="password" value={password} autoComplete="new-password"
                 onChange={(e) => setPassword(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && ready && finish()} />
        </Field>
      </Panel>
    );
  }

  return (
    <Panel title="Password changed" sub={email}
           note="Every device that was signed into this account has been signed out. Sign in with the new password."
           action={onBack} actionLabel="Sign in" />
  );
}

/* ── Accepting an invitation ─────────────────────────────────────────────── */

export function AcceptInvite({ token, onIn, onBack }) {
  const [look, setLook] = useState(null);      // null = still asking
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    api.get(`/auth/invitation/${encodeURIComponent(token)}`)
      .then(setLook)
      .catch((e) => setLook({ dead: messageOf(e) }));
  }, [token]);

  const accept = async () => {
    setErr(""); setBusy(true);
    try {
      const d = await api.post("/auth/invitation/accept", { token, password, full_name: fullName });
      setSession(d);
      onIn(d.user);
    } catch (e) { setErr(messageOf(e)); }
    setBusy(false);
  };

  if (!look) return <Panel title="One moment" sub="Checking that invitation" />;

  /* An expired or withdrawn link is a dead end unless the screen offers one
     way out, and the only honest one is: ask the person who invited you. */
  if (look.dead) {
    return (
      <Panel title="That link does not work" sub="" err={look.dead}
             note="Ask whoever invited you to send a new one — invitations expire after seven days and can only be used once."
             action={onBack} actionLabel="Go to sign in" />
    );
  }

  const known = look.have_account;
  const ready = known ? password.length > 0 : password.length >= 8;
  return (
    <Panel title={`Join ${look.company}`} sub={look.email} err={err} busy={busy}
           note={look.is_owner
             ? "You have been invited as an owner of this business."
             : look.role ? `You have been invited as ${look.role}.` : "You have been invited to help run this business."}
           action={accept} disabled={!ready}
           actionLabel={known ? "Join the business" : "Create my account and join"}
           back={onBack} backLabel="Not now">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {!known && (
          <Field label="Your name"><input value={fullName} autoFocus onChange={(e) => setFullName(e.target.value)} /></Field>
        )}
        <Field label={known ? "Your password" : "Choose a password"}
               hint={known
                 ? "You already have an account with this address — sign in to accept."
                 : "At least 8 characters. This becomes your account."}>
          <input type="password" value={password} autoFocus={known}
                 autoComplete={known ? "current-password" : "new-password"}
                 onChange={(e) => setPassword(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && ready && accept()} />
        </Field>
      </div>
    </Panel>
  );
}

/* ── The sign-in code ─────────────────────────────────────────────────────
 *
 * Shown when the password was right but this device has not been used before.
 * The password step already succeeded, so nothing here is an error state until
 * somebody mistypes — the tone is "one more step", not "access denied".
 *
 * The backup-code way in is deliberately present but quiet. It is the thing a
 * person needs at the worst possible moment — the email has not come, the
 * shop is open, the queue is growing — so it must be findable without being
 * so prominent that it becomes the habitual path past the second factor.
 */
export function SignInCode({ challenge, sentTo, backupCodesLeft = 0, onDone, onBack }) {
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(""); setNote(""); setBusy(true);
    try {
      const d = await api.post("/auth/login-verify", {
        challenge,
        ...(useBackup ? { backup_code: backup } : { code }),
        remember_device: remember,
      });
      /* Only kept when the server actually issued one — declining to remember
         must not leave yesterday's token in place. */
      if (d.device_token) setDeviceToken(d.device_token);
      setSession(d);
      onDone(d);
      return;
    } catch (e) {
      /* An expired challenge is not a wrong code, and telling somebody to
         "check the code" when the sign-in itself has timed out sends them
         round a loop they cannot get out of. */
      if (e && e.errors && e.errors.restart) { onBack(messageOf(e)); return; }
      setErr(messageOf(e)); setCode(""); setBackup("");
    }
    setBusy(false);
  };

  const resend = async () => {
    setErr(""); setNote(""); setCode("");
    try {
      await api.post("/auth/login-resend", { challenge });
      setNote("We have sent another code.");
    } catch (e) {
      if (e && e.errors && e.errors.restart) { onBack(messageOf(e)); return; }
      setErr(messageOf(e));
    }
  };

  const rememberBox = (
    <label style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 12.5,
                    color: "var(--soft)", lineHeight: 1.5, cursor: "pointer" }}>
      <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)}
             style={{ marginTop: 2 }} />
      <span>
        Remember this device for 30 days
        <em style={{ display: "block", fontStyle: "normal", color: "var(--faint)", fontSize: 11.5 }}>
          Leave this off on a shared or borrowed computer.
        </em>
      </span>
    </label>
  );

  if (useBackup) {
    return (
      <Panel title="Use a backup code" sub={sentTo} err={err} busy={busy}
             note="Type one of the codes from the sheet you printed when this account was set up. Each one works once."
             action={submit} disabled={backup.trim().length < 6} actionLabel="Sign in"
             back={() => { setUseBackup(false); setErr(""); }} backLabel="Back to the emailed code">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Backup code" hint="Dashes and capitals do not matter.">
            <input value={backup} autoFocus autoComplete="one-time-code" placeholder="ABCD-2345"
                   onChange={(e) => setBackup(e.target.value)}
                   onKeyDown={(e) => e.key === "Enter" && backup.trim().length >= 6 && submit()} />
          </Field>
          {rememberBox}
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="One more step" sub={sentTo} err={err} busy={busy}
           note="This device has not signed in before, so we have emailed a six-digit code. It lasts 10 minutes."
           action={submit} disabled={code.length !== 6} actionLabel="Sign in"
           after={
             <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
               {note && <div style={{ fontSize: 12, color: "var(--soft)" }}>{note}</div>}
               <button onClick={resend} style={quietLink}>Send it again</button>
               {backupCodesLeft > 0 && (
                 <button onClick={() => { setUseBackup(true); setErr(""); }} style={quietLink}>
                   Email not arriving? Use a backup code
                 </button>
               )}
             </div>
           }
           back={() => onBack("")} backLabel="Sign in as someone else">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <CodeBoxes value={code} onChange={setCode} onEnter={() => code.length === 6 && submit()} />
        {rememberBox}
      </div>
    </Panel>
  );
}

/* ── The backup codes, shown once ────────────────────────────────────────
 *
 * This screen exists because of one failure: the email does not arrive — the
 * provider is down, the address has changed, the phone is lost — and a shop
 * cannot open its own books. Ten printed codes turn that from a support call
 * with no good answer into an inconvenience.
 *
 * It is shown once and cannot be reached again, because the codes are stored
 * hashed and the server genuinely cannot produce them a second time. So the
 * screen is deliberately hard to leave by accident: the button says what is
 * about to happen, and it is not enabled until the person has confirmed they
 * have actually kept them.
 */
export function BackupCodes({ codes, onDone }) {
  const [kept, setKept] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = (codes || []).join("\n");

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch { setCopied(false); }
  };

  return (
    <Panel title="Your backup codes" sub="Print these or write them down"
           note="If your email is ever unavailable, one of these will let you sign in. Each works once. This is the only time they can be shown — they are stored scrambled, so nobody, including us, can read them out to you later."
           action={onDone} disabled={!kept} actionLabel="I have kept them safe"
           after={
             <div style={{ display: "flex", gap: 14, justifyContent: "center" }}>
               <button onClick={copy} style={quietLink}>{copied ? "Copied" : "Copy"}</button>
               <button onClick={() => window.print()} style={quietLink}>Print</button>
             </div>
           }>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontSize: 14.5, fontWeight: 650, letterSpacing: ".04em",
                    background: "var(--sunk, rgba(127,127,127,.08))", borderRadius: 10, padding: "14px 16px" }}>
        {(codes || []).map((c) => <div key={c}>{c}</div>)}
      </div>
      <label style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 12.5,
                      color: "var(--soft)", lineHeight: 1.5, cursor: "pointer" }}>
        <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} style={{ marginTop: 2 }} />
        <span>I have written these down or printed them, and they are somewhere I can find them.</span>
      </label>
    </Panel>
  );
}

/* ── Which shop's server is this? ─────────────────────────────────────────
 *
 * Only the packaged Android app ever sees this screen, and only once. A
 * browser was served by the server it talks to, so it already knows; a
 * downloaded APK is identical for every shop and cannot guess.
 *
 * The address is checked before it is saved. Without that, one wrong
 * character produces "wrong email or password" on every attempt for the rest
 * of the evening — an error about what the person was doing rather than about
 * what was actually wrong, which is the kind of thing that ends with the app
 * being uninstalled.
 */
export function ConnectServer({ onDone, current = "", onCancel }) {
  const [url, setUrl] = useState(current);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setErr(""); setBusy(true);
    const typed = url.trim();
    /* Typing "shop.example.com" is what people do, and refusing it over a
       missing prefix would be pedantry. https is assumed rather than http,
       because guessing the unencrypted one would silently send a password
       over plain text. */
    const guess = /^https?:\/\//i.test(typed) ? typed : `https://${typed}`;
    const r = await checkServer(guess);
    if (!r.ok) { setErr(r.why); setBusy(false); return; }
    setServer(guess);
    setBusy(false);
    onDone(guess, r.version);
  };

  return (
    <Panel title="Connect to your shop" sub="One time only"
           err={err} busy={busy}
           note="Type the web address of your shop's Genius POS server. Whoever set it up will have it — it looks like https://yourshop.onrender.com."
           action={go} disabled={!url.trim()} actionLabel="Connect"
           back={onCancel} backLabel="Cancel">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Server address" hint="Not your email, and not the database address.">
          <input value={url} autoFocus inputMode="url" autoCapitalize="none" autoCorrect="off"
                 placeholder="https://yourshop.onrender.com"
                 onChange={(e) => setUrl(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && url.trim() && go()} />
        </Field>
      </div>
    </Panel>
  );
}
