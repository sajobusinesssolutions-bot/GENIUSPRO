/**
 * Companies.jsx — the businesses this account may open.
 *
 * Three jobs, in order of how often they are used: switch between businesses,
 * see the state of each, and manage them. The switcher is the one a shopkeeper
 * touches daily and it is the first thing on the screen; creating and deleting
 * are further down, behind more clicks, because they are done once.
 *
 * ── what the screen is careful about ──────────────────────────────────────
 *
 * **A suspended business is shown, marked, not hidden.** A business that
 * vanished from the list would read as deleted, and the shopkeeper would ring
 * up asking where their books went. "Suspended" is a state somebody can ask
 * about.
 *
 * **Switching re-issues the session.** The token carries the company, and the
 * role can differ between them, so the screen signs the session forward rather
 * than trusting the token it already holds. That is also what makes a switch
 * take effect on every other open screen.
 *
 * **Delete asks for the name in full.** Every other guard on this screen can be
 * clicked through.
 */
import React, { useEffect, useState } from "react";
import api, { can, isAdmin, currentUser, setSession } from "../lib/api.js";
import { Modal, Field, toast, confirmDialog, RowMenu } from "../lib/ui.jsx";
import { LoadFailed } from "../lib/deckui.jsx";
import { Icon } from "../lib/icons.jsx";
/* Lazy: the panel adds up every business and most visits to this screen are to
   switch between two of them. */
const CompaniesPanel = React.lazy(() => import("./CompaniesPanel.jsx"));

export default function Companies() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [create, setCreate] = useState(false);
  const [edit, setEdit] = useState(null);
  const [people, setPeople] = useState(null);
  const [restoreFor, setRestoreFor] = useState(null);
  const [panel, setPanel] = useState(false);
  const [pinFor, setPinFor] = useState(null);
  const [busy, setBusy] = useState(false);
  /* Read once per render rather than per row: the answer cannot change while
     the screen is open, and it decides nine of the ten entries in every ⋯. */
  const admin = isAdmin();

  const load = () => api.get("/companies")
    .then((d) => { setData(d); setFailed(false); })
    .catch(() => setFailed(true));
  useEffect(() => { load(); }, []);

  const switchTo = async (c) => {
    if (c.active) return;
    if (c.status !== "active") return toast("That business is suspended", "bad");
    setBusy(true);
    try {
      /* The reply is a whole new session — token, role, permissions and firm
         for the company being opened — not an acknowledgement. Storing it
         before the reload is what stops the next request being made against
         the company we just left. */
      /* A business with a PIN asks here. The screen asks first when it knows
         one is set, so the common case is one prompt rather than a refusal
         followed by a prompt; the server checks it either way. */
      let pin;
      if (c.locked) {
        pin = window.prompt(`${c.name} is locked. Enter its PIN:`);
        if (pin === null) { setBusy(false); return; }
      }
      const fresh = await api.post("/companies/switch", { firm_id: c.id, pin });
      setSession(fresh);
      /* A hard reload, deliberately. Every screen in the app holds data for the
         company it was opened with — the item list, the dashboard figures, the
         cached print settings — and re-fetching some of them while others keep
         yesterday's company is how one shop's stock ends up on another's
         screen. Starting again is the honest way to change companies. */
      toast(`Switching to ${c.name}…`);
      setTimeout(() => window.location.reload(), 400);
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  const setStatus = async (c, status) => {
    const suspending = status === "suspended";
    if (suspending && !(await confirmDialog({
      title: `Suspend ${c.name}?`,
      message: "Everyone signed into it is signed out immediately, and nobody can open it until it is restored.",
      detail: "Nothing is deleted. Stock, invoices and books stay exactly as they are.",
      danger: true, confirmLabel: "Suspend business",
    }))) return;
    try {
      const r = await api.post(`/companies/${c.id}/status`, { status });
      toast(r.message || "Done");
      load();
    } catch (e) { toast(e.message, "bad"); }
  };

  /* Downloading is a plain link rather than an api.get: the reply is a file,
     not JSON, and routing it through the JSON client would parse a database as
     text and hand back nonsense. */
  const download = async (c) => {
    try {
      const token = localStorage.getItem("vy_token");
      const r = await fetch(`/api/companies/${c.id}/export`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || "Could not take a copy");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${c.name.replace(/[^\w-]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.genius.db`;
      a.click();
      URL.revokeObjectURL(url);
      toast(`Copy of ${c.name} saved`);
    } catch (e) { toast(e.message, "bad"); }
  };

  /* Which business opens at sign-in. A toggle rather than a picker: the thing
     being said is "this one", and the way to say "not this one" is to press it
     again. */
  const makeDefault = async (c) => {
    try {
      const r = await api.post(`/companies/${c.id}/default`, { on: !c.is_default });
      toast(r.message || "Saved");
      load();
    } catch (e) { toast(e.message, "bad"); }
  };

  /* Empty a business without deleting it. Kept beside Delete because they are
     neighbours in intent and a long way apart in consequence — this one keeps
     the name, the items and the staff. */
  const reset = async (c) => {
    const typed = window.prompt(
      `Empty ${c.name}?\n\n` +
      "Every sale, purchase, payment, expense and ledger entry is thrown away. " +
      "The business, its items and its staff stay.\n\n" +
      "A copy of everything as it is now is saved to the backups folder first.\n\n" +
      "Type the business name exactly to confirm:");
    if (typed == null) return;
    const alsoItems = window.confirm("Throw away the items and customers as well?\n\nOK = yes, empty everything.\nCancel = keep the items and customers.");
    try {
      const r = await api.post(`/companies/${c.id}/reset`, { confirm: typed, also_items: alsoItems, reopen_setup: alsoItems });
      toast(r.message || "Emptied");
      if (c.active) setTimeout(() => window.location.reload(), 900); else load();
    } catch (e) { toast(e.message, "bad"); }
  };

  /* Every business in one zip, because four buttons and four files is four
     chances to end up with three. */
  const backupAll = async () => {
    try {
      const token = localStorage.getItem("vy_token");
      const r = await fetch("/api/companies/backup-all", { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || "Could not make the copy");
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `genius-all-businesses-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("A copy of every business has been saved");
    } catch (e) { toast(e.message, "bad"); }
  };

  const remove = async (c) => {
    const typed = window.prompt(
      `This destroys ${c.name} and everything in it — every invoice, every item, every ledger entry.\n\n` +
      `A copy is saved to the backups folder first, so it can be restored into a new business ` +
      `if this turns out to be a mistake.\n\n` +
      `Type the business name exactly to confirm:`);
    if (typed == null) return;
    try {
      const r = await api.delete(`/companies/${c.id}`, { confirm: typed });
      toast(r.message || "Deleted");
      load();
    } catch (e) { toast(e.message, "bad"); }
  };

  if (failed) return <div className="dk-page"><div className="dk-card"><LoadFailed what="your businesses" onRetry={load} /></div></div>;
  if (!data) return <div className="dk-page"><div className="dk-card"><div className="dk-empty">Loading…</div></div></div>;

  const list = data.companies || [];
  const owned = list.filter((c) => c.is_owner).length;

  if (panel) {
    return (
      <div className="dk-page">
        <button className="dk-sbtn" style={{ alignSelf: "flex-start", marginBottom: 12 }}
                onClick={() => setPanel(false)}>← Back to businesses</button>
        <React.Suspense fallback={<div className="dk-card"><div className="dk-empty">Opening…</div></div>}>
          <CompaniesPanel />
        </React.Suspense>
      </div>
    );
  }

  return (
    <div className="dk-page">
      <div className="dk-strip">
        <div>
          <div className="l">Businesses</div>
          <div className="big dk-n">{list.length}</div>
          <div className="s">{owned} you own · {list.length - owned} you were given access to</div>
        </div>
        <div>
          <div className="l">Open now</div>
          <div className="v">{(list.find((c) => c.active) || {}).name || "—"}</div>
          <div className="s">everything you do lands here</div>
        </div>
        <div>
          <div className="l">Suspended</div>
          <div className={`v dk-n ${list.some((c) => c.status !== "active") ? "val-watch" : "val-flat"}`}>
            {list.filter((c) => c.status !== "active").length}
          </div>
          <div className="s">locked, nothing deleted</div>
        </div>
      </div>

      <div className="dk-card flush">
        <div className="dk-card-head">
          <h3>Your businesses</h3>
          {/* Gated on `companies.panel`, which the server enforces as well —
              this is the one screen that shows one business's takings to
              somebody standing in another, so hiding the button is the
              convenience and the 403 is the control. */}
          {admin && can("companies", "edit") && list.length > 0 && (
            <button className="dk-sbtn" style={{ marginRight: 8 }} onClick={backupAll}>
              Full backup
            </button>
          )}
          {can("companies", "panel") && list.length > 0 && (
            <button className="dk-sbtn" style={{ marginRight: 8 }} onClick={() => setPanel(true)}>
              Branch panel
            </button>
          )}
          {can("companies", "create") && (
            data.can_create
              ? <button className="dk-create" style={{ height: 38 }} onClick={() => setCreate(true)}>+ New business</button>
              : <span style={{ fontSize: 12.5, color: "var(--faint)" }}>
                  {data.company_limit} businesses is this account's limit
                </span>
          )}
        </div>

        <div className="dk-scrollx">
          <table className="dk-table">
            <thead>
              <tr>
                <th>Business</th><th>Tax number</th><th>People</th>
                <th>Status</th><th className="amt">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className={c.active ? "is-active" : ""}>
                  <th scope="row" className="co-name">
                    <span className="nm">{c.name}</span>
                    <span className="sub">
                      {c.is_owner ? "You own this" : "You were given access"}
                      {c.active ? " · open now" : ""}
                      {c.is_default ? " · opens at sign-in" : ""}
                      {c.locked ? " · asks for a PIN" : ""}
                      {/* The code counter staff type to say which shop they are
                          signing in to. Shown here because the owner is the one
                          who has to tell them, and it is otherwise invisible. */}
                      {c.shop_code ? <> · shop code <b className="dk-n">{c.shop_code}</b></> : ""}
                    </span>
                  </th>
                  <td>{c.gstin || "—"}</td>
                  <td className="dk-n">{c.people}</td>
                  <td>
                    {/* The word, not only the colour — §4. */}
                    <span className={`dk-chip ${c.status === "active" ? "" : "warn"}`}>
                      {c.status === "active" ? "Active" : "Suspended"}
                    </span>
                  </td>
                  <td className="amt co-acts">
                    {!c.active && c.status === "active" && (
                      <button className="dk-sbtn primary" disabled={busy} onClick={() => switchTo(c)}>Open</button>
                    )}
                    {/* Ten buttons in a row is not ten choices, it is a wall.
                        Open is the only thing anybody does here most days, so
                        it is the only thing that stays a button; everything
                        else — including every irreversible thing, which the
                        server now also refuses to anyone but an owner or an
                        administrator — goes behind the ⋯. */}
                    <RowMenu items={[
                      { label: c.is_default ? "Stop opening this one first" : "Open this one when I sign in",
                        onClick: () => makeDefault(c) },
                      can("companies", "grant") && { label: "People with access", onClick: () => setPeople(c) },
                      admin && can("companies", "edit") && { label: "Edit details", onClick: () => setEdit(c) },
                      admin && can("companies", "edit") &&
                        { label: "Save a copy", hint: "A full backup file", onClick: () => download(c) },
                      admin && can("companies", "edit") && c.is_owner &&
                        { label: "Restore from backup…", hint: "Replaces everything in this business", onClick: () => setRestoreFor(c) },
                      admin && can("companies", "edit") && c.is_owner &&
                        { label: c.locked ? "Change PIN" : "Protect with a PIN…", onClick: () => setPinFor(c) },
                      admin && can("companies", "edit") && c.is_owner && (c.status === "active"
                        ? { label: "Suspend", hint: "Nobody can open it; nothing is deleted", onClick: () => setStatus(c, "suspended") }
                        : { label: "Un-suspend", onClick: () => setStatus(c, "active") }),
                      admin && can("companies", "delete") && c.is_owner &&
                        { label: "Reset business data", hint: "Keeps the business and its people; clears every transaction", danger: true, onClick: () => reset(c) },
                      admin && can("companies", "delete") && c.is_owner &&
                        { label: "Delete business", hint: "Removed permanently, with everything in it", danger: true, onClick: () => remove(c) },
                    ].filter(Boolean)} />
                  </td>
                </tr>
              ))}
              {!list.length && (
                <tr><td colSpan={5}><div className="dk-empty">
                  You have no businesses yet. Create one to start trading.
                </div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {create && <CompanyForm others={list.filter((c) => c.status === "active")}
                              onClose={() => setCreate(false)} onSaved={() => { setCreate(false); load(); }} />}
      {edit && <CompanyForm edit={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
      {people && <PeopleModal company={people} onClose={() => setPeople(null)} onChanged={load} />}
      {pinFor && <FirmPin company={pinFor} onClose={() => setPinFor(null)}
                          onDone={() => { setPinFor(null); load(); }} />}
      {restoreFor && <RestoreModal company={restoreFor} onClose={() => setRestoreFor(null)}
                                   onDone={() => { setRestoreFor(null); window.location.reload(); }} />}
    </div>
  );
}

/* ── A PIN on one business ────────────────────────────────────────────────
 *
 * Not the same thing as the panel's PIN and not the same as signing in. This
 * one is about a keyboard: an owner who lets a manager run the hardware shop
 * has not thereby let them open the pharmacy's books from the same computer
 * while the owner is out.
 *
 * Changing it asks for the old one, because otherwise anybody sitting at an
 * unlocked machine could lock the owner out of their own business, and a PIN
 * whose purpose is to keep people out has no reset.
 */
function FirmPin({ company, onClose, onDone }) {
  const [set, setSet] = React.useState(!!company.locked);
  const [oldPin, setOld] = React.useState("");
  const [pin, setPin] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    api.get(`/companies/${company.id}/pin`).then((r) => setSet(!!r.set)).catch(() => {});
  }, [company.id]);

  const save = async (clearing) => {
    setBusy(true);
    try {
      const r = await api.post(`/companies/${company.id}/pin`, {
        old_pin: oldPin || undefined, pin: clearing ? "" : pin });
      toast(r.message || "Saved");
      onDone();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title={`${company.name} — PIN`} onClose={onClose}>
      <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.6, marginTop: 0 }}>
        With a PIN set, opening this business from the list asks for it — even for somebody
        already signed in and entitled to open it.
      </p>
      {set && (
        <Field label="Current PIN">
          <input type="password" inputMode="numeric" value={oldPin}
                 onChange={(e) => setOld(e.target.value.replace(/\D/g, "").slice(0, 8))} />
        </Field>
      )}
      <Field label={set ? "New PIN" : "PIN — four to eight digits"}>
        <input type="password" inputMode="numeric" value={pin} autoFocus
               onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))} />
      </Field>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        {set && <button className="btn btn-ghost" onClick={() => save(true)} disabled={busy}>Remove the PIN</button>}
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => save(false)} disabled={busy || pin.length < 4}>
          {busy ? "Saving…" : set ? "Change it" : "Lock it"}
        </button>
      </div>
    </Modal>
  );
}

/* ── Create or edit ───────────────────────────────────────────────────────
   The same form both ways. A created business arrives provisioned — its own
   chart of accounts, roles, units and walk-in customer — so the only thing
   asked for here is what makes it this business rather than any other. */
function CompanyForm({ edit, onClose, onSaved, others = [] }) {
  const [f, setF] = useState(() => ({
    name: edit?.name || "", legal_name: edit?.legal_name || "", gstin: edit?.gstin || "",
    address: edit?.address || "", phone: edit?.phone || "", email: edit?.email || "",
    invoice_prefix: edit?.invoice_prefix || "INV",
    /* Only on edit: a new business is given one automatically from its name,
       and asking somebody to invent a code before they have named the shop is
       a question with no useful answer yet. */
    shop_code: edit?.shop_code || "",
    /* A second branch of the same shop sells the same things, and retyping
       four hundred items is why people stop at one business. */
    copy_from: "",
  }));
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const save = async () => {
    if (!f.name.trim()) return toast("Name the business", "bad");
    setBusy(true);
    try {
      const r = edit ? await api.put(`/companies/${edit.id}`, f) : await api.post("/companies", f);
      toast(r.message || "Saved");
      onSaved();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title={edit ? `Edit ${edit.name}` : "New business"} onClose={onClose} wide>
      {!edit && (
        <p style={{ marginTop: 0, fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6 }}>
          It starts with its own stock, customers, books and reports — nothing is shared
          with your other businesses except who can open it.
        </p>
      )}
      <Field label="Name"><input value={f.name} onChange={set("name")} autoFocus placeholder="e.g. Kampala Hardware" /></Field>
      <div className="row2">
        <Field label="Legal name (optional)"><input value={f.legal_name} onChange={set("legal_name")} /></Field>
        <Field label="Tax number (TIN)"><input value={f.gstin} onChange={set("gstin")} placeholder="Optional" /></Field>
      </div>
      <div className="row2">
        <Field label="Phone"><input value={f.phone} onChange={set("phone")} /></Field>
        <Field label="Email"><input value={f.email} onChange={set("email")} /></Field>
      </div>
      <Field label="Address"><input value={f.address} onChange={set("address")} /></Field>

      {!edit && others.length > 0 && (
        <div className="co-copy">
          <Field label="Start it with a copy of another business's items">
            <select value={f.copy_from} onChange={set("copy_from")}>
              <option value="">Start empty</option>
              {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          {f.copy_from && (
            <p style={{ fontSize: 12, color: "var(--faint)", lineHeight: 1.55, margin: "8px 0 0" }}>
              The items, their prices, their categories and their units come across. The stock does
              not — that is a count of things on a shelf in one building — and neither do the
              customers, the invoices or the books. To let somebody work both counters, give their
              account access to this business under People.
            </p>
          )}
        </div>
      )}
      <div className="row2">
        <Field label="Invoice prefix">
          <input value={f.invoice_prefix} onChange={set("invoice_prefix")} style={{ width: 120 }} />
        </Field>
        {edit && (
          <Field label="Shop code">
            <input value={f.shop_code} onChange={set("shop_code")} placeholder="kampala-hardware" />
            <em style={{ fontSize: 11.5, color: "var(--faint)", fontStyle: "normal" }}>
              What counter staff type to sign in to this business. Letters, numbers and hyphens.
            </em>
          </Field>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? "Saving…" : edit ? "Save changes" : "Create business"}
        </button>
      </div>
    </Modal>
  );
}

/* ── Who may open this business ──────────────────────────────────────────── */
function PeopleModal({ company, onClose, onChanged }) {
  const [rows, setRows] = useState(null);
  const [roles, setRoles] = useState([]);
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [busy, setBusy] = useState(false);
  const me = currentUser() || {};
  /* Ownership is per company, not per person. `currentUser().is_owner` is the
     answer for the business currently OPEN, and this modal may well be about a
     different one — so it is read from this company's own people list. */
  const iOwnThis = !!(rows || []).find((p) => p.account_id === me.account_id && p.is_owner);

  const [invites, setInvites] = useState([]);
  const [asOwner, setAsOwner] = useState(false);
  const [link, setLink] = useState(null);       // shown only when no mail provider is configured

  const load = () => {
    api.get(`/companies/${company.id}/people`).then(setRows).catch(() => setRows([]));
    api.get(`/companies/${company.id}/invitations`).then(setInvites).catch(() => setInvites([]));
  };
  useEffect(() => {
    load();
    /* Roles are per company; only this company's are offered, which is also
       what the server insists on. */
    if (company.active) api.get("/users/roles").then(setRoles).catch(() => setRoles([]));
  }, [company.id]);

  const grant = async () => {
    if (!email.trim()) return toast("Type their email address", "bad");
    setBusy(true);
    try {
      const r = await api.post(`/companies/${company.id}/people`, { email: email.trim(), role_id: roleId || null });
      toast(r.message || "Access given");
      setEmail(""); load(); onChanged?.();
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  /* The path for somebody who has no account yet — which is most people the
     first time. The link is single-use and expires in seven days. */
  const invite = async () => {
    if (!email.trim()) return toast("Type their email address", "bad");
    setBusy(true);
    try {
      const r = await api.post(`/companies/${company.id}/invitations`,
        { email: email.trim(), role_id: roleId || null, is_owner: asOwner });
      /* `api` returns the payload, not the envelope, so what the screen says
         is decided by what actually happened rather than by a hopeful
         default: an invitation whose email did not go out is not "sent". */
      toast(r.sent ? `Invitation sent to ${r.email}` : "Invitation created — the email did not go out", r.sent ? "ok" : "warn");
      /* No mail provider configured — the server hands the link back rather
         than pretending it sent something. Better to show it and let somebody
         pass it on than to leave them waiting for an email nobody sent. */
      setLink(r.url || null);
      setEmail(""); load();
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  const withdraw = async (i) => {
    try { await api.delete(`/companies/${company.id}/invitations/${i.id}`); toast("Invitation withdrawn"); load(); }
    catch (e) { toast(e.message, "bad"); }
  };

  const makeOwner = async (p) => {
    if (!(await confirmDialog({
      title: `Hand ${company.name} to ${p.full_name || p.email}?`,
      message: "They become the owner and you do not. Everyone is signed out, including you, and only they can hand it back.",
      danger: true, confirmLabel: "Transfer ownership",
    }))) return;
    try {
      const r = await api.post(`/companies/${company.id}/people/${p.account_id}/owner`, {});
      toast(r.message || "Handed over");
      /* Every session just ended, this one included. Reloading is the honest
         response — the alternative is a screen quietly making requests that
         all answer 401. */
      setTimeout(() => window.location.reload(), 900);
    } catch (e) { toast(e.message, "bad"); }
  };

  const revoke = async (p) => {
    if (!(await confirmDialog({
      title: `Remove ${p.email}?`,
      message: `They will be signed out of ${company.name} immediately and will not be able to open it again.`,
      danger: true, confirmLabel: "Revoke access",
    }))) return;
    try {
      await api.delete(`/companies/${company.id}/people/${p.account_id}`);
      toast("Access removed"); load(); onChanged?.();
    } catch (e) { toast(e.message, "bad"); }
  };

  return (
    <Modal title={`Who can open ${company.name}`} onClose={onClose} wide>
      <table className="dk-table">
        <thead><tr><th>Person</th><th>Role</th><th className="amt"></th></tr></thead>
        <tbody>
          {rows === null ? <tr><td colSpan={3}><div className="dk-empty">Loading…</div></td></tr>
           : !rows.length ? <tr><td colSpan={3}><div className="dk-empty">Nobody yet.</div></td></tr>
           : rows.map((p) => (
            <tr key={p.id}>
              <th scope="row" className="co-name">
                <span className="nm">{p.full_name || p.email}</span>
                <span className="sub">{p.email}{p.is_owner ? " · owner" : ""}</span>
              </th>
              <td>{p.role_name || "—"}</td>
              <td className="amt">
                {p.is_owner ? (
                  <span style={{ fontSize: 11.5, color: "var(--faint)" }}>cannot be removed</span>
                ) : p.account_id === me.account_id ? (
                  <span style={{ fontSize: 11.5, color: "var(--faint)" }}>this is you</span>
                ) : (
                  <span style={{ display: "inline-flex", gap: 6 }}>
                    {iOwnThis && <button className="dk-sbtn" onClick={() => makeOwner(p)}>Make owner</button>}
                    <button className="dk-sbtn danger" onClick={() => revoke(p)}>Remove</button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
        <h4 style={{ margin: "0 0 4px", fontSize: 13.5, fontWeight: 650 }}>Add somebody</h4>
        <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--faint)" }}>
          An invitation works whether or not they already have an account — the link creates one.
          Counter staff sign in with a username and PIN instead; add those under Users &amp; roles.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input className="dk-input" style={{ flex: "1 1 220px" }} placeholder="their@email.address" type="email"
                 value={email} onChange={(e) => setEmail(e.target.value)} />
          {company.active && (
            <select className="dk-input" style={{ width: 170 }} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">Role — default</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          <button className="btn btn-primary" onClick={invite} disabled={busy}>Send invitation</button>
        </div>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginTop: 9 }}>
          {/* Inviting an owner is offered only to an owner, which is also what
              the server insists on. Ownership is the one thing no role can
              restrain, so it must not be reachable from a permission an owner
              handed out for a different purpose. */}
          {iOwnThis && (
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, fontWeight: 500 }}>
              <input type="checkbox" checked={asOwner} onChange={(e) => setAsOwner(e.target.checked)} />
              Invite as an owner
            </label>
          )}
          <button className="dk-sbtn" onClick={grant} disabled={busy}>
            They already have an account — add them now
          </button>
        </div>

        {link && (
          <div style={{ marginTop: 10, fontSize: 12.5, wordBreak: "break-all", padding: "10px 12px",
                       borderRadius: 10, background: "var(--sunk)", border: "1px solid var(--line)" }}>
            No email provider is set up on this server, so nothing was sent. Pass this link on yourself —
            it works once and expires in seven days.
            <div style={{ marginTop: 6, fontFamily: "var(--mono, monospace)" }}>{link}</div>
          </div>
        )}
      </div>

      {invites.filter((i) => !i.accepted_at && !i.revoked_at && !i.expired).length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
          <h4 style={{ margin: "0 0 8px", fontSize: 13.5, fontWeight: 650 }}>Invitations waiting</h4>
          <table className="dk-table">
            <thead><tr><th>Sent to</th><th>Role</th><th className="amt"></th></tr></thead>
            <tbody>
              {invites.filter((i) => !i.accepted_at && !i.revoked_at && !i.expired).map((i) => (
                <tr key={i.id}>
                  <th scope="row" className="co-name">
                    <span className="nm">{i.email}</span>
                    <span className="sub">expires {String(i.expires_at || "").slice(0, 10)}</span>
                  </th>
                  <td>{i.is_owner ? "Owner" : (i.role_name || "—")}</td>
                  <td className="amt"><button className="dk-sbtn danger" onClick={() => withdraw(i)}>Withdraw</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}


/* ── Restore one business ─────────────────────────────────────────────────
 *
 * Two steps, and the first one is not optional: the file is examined and
 * described before the button that overwrites anything becomes pressable.
 * Round twelve found an 8 KB file whose only table was `not_genius` previewed as
 * "0 invoices, 0 parties" and was accepted — so a preview that cannot say what
 * it is holding must refuse rather than shrug.
 */
function RestoreModal({ company, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [look, setLook] = useState(null);      // null = not looked yet
  const [busy, setBusy] = useState(false);

  const send = async (path, body) => {
    const token = localStorage.getItem("vy_token");
    const r = await fetch(`/api/companies/${company.id}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.message || "That did not work");
    return j.data;
  };

  const choose = async (f) => {
    setFile(f); setLook(null);
    if (!f) return;
    setBusy(true);
    try { setLook(await send("restore/preview", await f.arrayBuffer())); }
    catch (e) { setLook({ restorable: false, reason: e.message }); }
    setBusy(false);
  };

  const go = async () => {
    if (!(await confirmDialog({
      title: `Restore ${company.name}?`,
      message: `Everything this business has done since ${String(look.manifest.taken_at).slice(0, 10)} will be replaced by what is in the file.`,
      detail: "Your other businesses are not touched. A copy of everything as it is right now is saved first, and appears in Settings → Backup.",
      danger: true, confirmLabel: "Restore backup",
    }))) return;
    setBusy(true);
    try {
      const r = await send("restore", await file.arrayBuffer());
      toast(`${r.firm_name} restored. A copy of the previous state was kept as ${r.safety}.`);
      onDone();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  const m = look && look.manifest;
  return (
    <Modal title={`Restore ${company.name}`} onClose={onClose} wide>
      <p style={{ marginTop: 0, fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6 }}>
        Put this business back to how it was in a copy you took earlier. Only this business
        changes — your others are left exactly as they are.
      </p>

      <label className="dk-field">
        <span>The copy to restore from</span>
        <input type="file" accept=".db,.sqlite,application/octet-stream"
               onChange={(e) => choose(e.target.files && e.target.files[0])} />
      </label>

      {busy && !look && <div className="dk-empty">Reading the file…</div>}

      {look && !look.restorable && (
        <div className="dk-setsec" style={{ marginTop: 14 }}>
          <div className="rows">
            <div style={{ padding: "10px 0", color: "var(--danger)", fontSize: 13.5 }}>
              {look.reason}
            </div>
          </div>
        </div>
      )}

      {look && look.restorable && m && (
        <div className="dk-setsec" style={{ marginTop: 14 }}>
          <h3>What is in this copy</h3>
          <div className="rows">
            <div className="dk-setrow"><div className="t"><div className="lb">Business</div></div>
              <div>{m.firm_name}</div></div>
            <div className="dk-setrow"><div className="t"><div className="lb">Taken</div></div>
              <div>{String(m.taken_at).replace("T", " ").slice(0, 16)}</div></div>
            <div className="dk-setrow"><div className="t"><div className="lb">Invoices</div></div>
              <div className="dk-n">{m.totals.invoices}</div></div>
            <div className="dk-setrow"><div className="t"><div className="lb">Items</div></div>
              <div className="dk-n">{m.totals.items}</div></div>
            <div className="dk-setrow"><div className="t"><div className="lb">Customers &amp; suppliers</div></div>
              <div className="dk-n">{m.totals.parties}</div></div>
          </div>
          {look.older_schema && (
            <p className="hint" style={{ marginTop: 10 }}>
              This copy was made by an older version of the app. Anything added since will come
              back empty, which is what it was at the time.
            </p>
          )}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" onClick={go}
                disabled={busy || !look || !look.restorable}>
          {busy ? "Restoring…" : "Restore this business"}
        </button>
      </div>
    </Modal>
  );
}
