/* ── Users & roles ─────────────────────────────────────────────────────────
 *
 * Its own screen, reached from the ⋯ beside the business name.
 *
 * It used to be a page inside Settings, which put "who may sign in" four
 * levels down — rail, then Settings, then Users & roles in a list of ten, then
 * a tab. It is not a preference about how the shop runs; it is the register of
 * the people who work here and what each of them is trusted with. That belongs
 * beside the other things you do ABOUT the business rather than in it:
 * Manage companies, Sync, Updates.
 *
 * Everything below moved here from pages/Settings.jsx unchanged, except the
 * four sign-in settings at the foot, which came with it — a switch that turns
 * PINs on belongs on the screen where PINs are set, not on a different one.
 */
import React, { useEffect, useMemo, useState } from "react";
import api, { can } from "../lib/api.js";
import { Field, toast, confirmDialog, Modal } from "../lib/ui.jsx";
import { PageDock, LoadingRows } from "../lib/deckui.jsx";
import { SettingRow, SettingSection, settingsIn } from "../lib/settingsui.jsx";
import { Icon } from "../lib/icons.jsx";

/* The columns of the permission matrix, in the order a person reads them:
   what you may look at, then what you may put in, change and take out, then
   the two that only apply to businesses.

   Taken from the server's catalogue action ids. An area that does not have one
   of these leaves the cell blank — Reports, for instance, is view or nothing,
   because nothing behind it creates, edits or deletes anything. */
const ACTION_COLS = [
  ["view",   "See",     "Open the screen and read what is on it"],
  ["create", "Add",     "Put something new in"],
  ["edit",   "Change",  "Alter something already there"],
  ["delete", "Remove",  "Take something out"],
  ["grant",  "Give access", "Let another person into this business"],
  ["panel",  "Branch panel", "Open the panel that manages every business at once"],
];

/* The screen. Two tabs and, under the people, the handful of settings that
   describe how they sign in. */
export default function UsersRoles() {
  const [catalog, setCatalog] = useState([]);
  const [values, setValues] = useState({});
  const [dirty, setDirty] = useState({});
  const [busy, setBusy] = useState(false);

  const load = () => api.get("/settings")
    .then((d) => { setCatalog(d.catalog || []); setValues(d.values || {}); setDirty({}); })
    .catch(() => {});
  useEffect(() => { load(); }, []);

  const setVal = (k, v) => { setValues((s) => ({ ...s, [k]: v })); setDirty((d) => ({ ...d, [k]: true })); };
  const nDirty = Object.keys(dirty).length;

  const save = async () => {
    setBusy(true);
    try {
      await api.put("/settings", values);
      window.dispatchEvent(new CustomEvent("vy-settings-saved"));
      setDirty({});
      toast("Saved");
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  const signin = settingsIn(catalog, "users");

  return (
    <div className="dk-page">
      <UsersAndRoles signin={signin} values={values} setVal={setVal} dirty={dirty} />

      {/* The same dock Settings uses, so saving a switch feels identical
          wherever the switch happens to live. */}
      <PageDock show={nDirty > 0}>
        <span className="dk-dock-note">
          {nDirty} unsaved change{nDirty === 1 ? "" : "s"}
        </span>
        <button className="dk-sbtn" disabled={busy} onClick={load}>Discard</button>
        <button className="dk-sbtn primary" disabled={busy} onClick={save}>
          {busy ? "Saving…" : `Save ${nDirty} change${nDirty === 1 ? "" : "s"}`}
        </button>
      </PageDock>
    </div>
  );
}

/* ── Users & roles ────────────────────────────────────────────────────────
   Two tabs, because there are two nouns here: the people, and the roles they
   are put on. There used to be three — "Staff accounts", "Access by screen"
   and "Plain-English questions" — and the last two were not a third subject
   at all, they were two ways of editing the same thing. A tab bar is for
   subjects; offering a person a choice between two editors of one subject at
   the same level as the subject itself is what made this screen hard to read.

   The two editors survive, as a view switch inside the Roles tab. Both write
   the module/action pairs the server actually checks — that mapping lives on
   the server, so neither screen can show a permission as allowed while the
   endpoint behind it refuses. */
function UsersAndRoles({ signin, values, setVal, dirty }) {
  const [view, setView] = useState("users");
  return (
    <>
      <div className="dk-tabs">
        <div className="grp">
          {[["users", "Users"], ["roles", "Roles"]].map(([id, label]) => (
            <button key={id} className={`dk-tab ${view === id ? "on" : ""}`} onClick={() => setView(id)}>{label}</button>
          ))}
        </div>
      </div>
      {view === "users" ? (
        <>
          <StaffList />
          {/* The four settings that describe how these people sign in and are
              paid. They were on Settings → Users & roles; they came here with
              the screen, because a switch that turns PINs on belongs where
              PINs are set. */}
          {signin.length > 0 && (
            <>
              <SettingSection title="Signing in"
                              hint="How the sign-in screen behaves for the people at the counter.">
                {signin.filter((c) => c.key.startsWith("login_")).map((c) => (
                  <SettingRow key={c.key} c={c} values={values} setVal={setVal} dirty={dirty} />
                ))}
              </SettingSection>
              <SettingSection title="Pay and hours"
                              hint="Defaults used when working out commission and lateness.">
                {signin.filter((c) => !c.key.startsWith("login_")).map((c) => (
                  <SettingRow key={c.key} c={c} values={values} setVal={setVal} dirty={dirty} />
                ))}
              </SettingSection>
            </>
          )}
        </>
      ) : <RolesTab />}
    </>
  );
}

/* The Roles tab. One subject, two ways of editing it: the grid, which is a box
   per action and is what you want for "may see Purchases, must never delete a
   bill"; and the questions, which read as English and are the right way to
   hand a role to somebody new. The switch is deliberately small and sits over
   the editor — it is a preference about this pane, not a place to go. */
function RolesTab() {
  const [mode, setMode] = useState("grid");
  return (
    <>
      <div className="dk-viewswitch">
        <span className="lb">Edit permissions</span>
        <div className="grp">
          <button className={mode === "grid" ? "on" : ""} onClick={() => setMode("grid")}>By screen</button>
          <button className={mode === "ask" ? "on" : ""} onClick={() => setMode("ask")}>In plain English</button>
        </div>
      </div>
      {mode === "grid" ? <RoleGrid /> : <RoleMatrix />}
    </>
  );
}

/* Create a role. Offered from both role editors, so "add another role" is
   never a thing you have to leave the screen to do — which it was: the only
   way to get a fourth role was a seeded database.

   Copying is the default because an empty role is not a useful starting
   point. "Like Cashier, but may also take a return" is what people actually
   ask for. */
/* The two role editors describe a role's size with different fields — the grid
   ships raw `permissions` pairs, the questions screen ships `granted` ids — and
   this dialog is opened from both. */
const permCount = (r) => ((r && (r.permissions || r.granted)) || []).length;

function NewRoleDialog({ roles, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [copyFrom, setCopyFrom] = useState(() => {
    /* Default to the least-privileged role there is, so a mis-click creates
       somebody who can do too little rather than too much. */
    const sorted = [...(roles || [])].sort((a, b) => permCount(a) - permCount(b));
    return String((sorted[0] || {}).id || "");
  });
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const r = await api.post("/users/roles", {
        name: name.trim(),
        copy_from: copyFrom === "" ? 0 : Number(copyFrom),
      });
      toast("Role created");
      onCreated(r && r.id);
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title="New role" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <Field label="What is this role called?">
            <input className="dk-input" value={name} autoFocus maxLength={60}
                   placeholder="e.g. Supervisor"
                   onChange={(e) => setName(e.target.value)}
                   onKeyDown={(e) => e.key === "Enter" && !busy && create()} />
          </Field>
          <div className="dk-fieldnote">What you would call the job — Cashier, Stock clerk, Supervisor.</div>
        </div>
        <div>
          <Field label="Start from">
            <select className="dk-input" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
              {(roles || []).map((r) => (
                <option key={r.id} value={r.id}>{r.name} — {permCount(r)} permissions</option>
              ))}
              <option value="">Nothing — start with no permissions at all</option>
            </select>
          </Field>
          <div className="dk-fieldnote">
            The new role begins with the same permissions as the one you pick, and you adjust from there.
          </div>
        </div>
      </div>
      <div className="modal-foot" style={{ marginTop: 20 }}>
        <button className="dk-sbtn" onClick={onClose}>Cancel</button>
        <button className="dk-sbtn primary" disabled={!name.trim() || busy} onClick={create}>
          {busy ? "Creating…" : "Create role"}
        </button>
      </div>
    </Modal>
  );
}

/* ── Access by screen ─────────────────────────────────────────────────────
 *
 * The questions screen below reads well and is the right way to hand a role
 * to a new cashier — but it sets several permissions at once, and when what
 * you actually want is "may see Purchases, must never delete a bill" it is
 * thirty questions and a guess about which one owns that cell.
 *
 * This is the same permissions as a grid: one card per area of the app, a box
 * per action, laid out the way the rail is. It writes `module.action` rows
 * directly, so what is ticked here is exactly what the server checks.
 *
 * The cards are built from the server's catalogue rather than a list kept
 * here, which is what stops the screen offering a box for something no
 * endpoint enforces — a permission that changes nothing is worse than no
 * permission at all, because it is believed.
 */
function RoleGrid() {
  const [d, setD] = useState(null);
  const [roleId, setRoleId] = useState(null);
  const [held, setHeld] = useState([]);          // ["sales.view", …]
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);

  const load = (select) => api.get("/users/permission-grid").then((r) => {
    setD(r);
    setRoleId((cur) => {
      const want = select ?? cur;
      return want && r.roles.some((x) => x.id === want) ? want : (r.roles[0] || {}).id ?? null;
    });
  }).catch(() => setD(false));
  useEffect(() => { load(); }, []);

  /* Rename and delete are on the role, not on the list, because both are
     things you do to the one you are looking at. Both are refused server-side
     for built-in roles and for a role somebody is still on. */
  const rename = async (r) => {
    const next = window.prompt("Rename this role to:", r.name);
    if (next == null || !next.trim() || next.trim() === r.name) return;
    try { await api.put(`/users/roles/${r.id}`, { name: next.trim() }); toast("Role renamed"); load(r.id); }
    catch (e) { toast(e.message, "bad"); }
  };
  const remove = async (r) => {
    const ok = await confirmDialog({
      title: `Delete the ${r.name} role?`,
      message: "The permissions on it go with it. Nobody is on this role, so no one loses access.",
      confirmLabel: "Delete role", danger: true,
    });
    if (!ok) return;
    try { await api.delete(`/users/roles/${r.id}`); toast("Role deleted"); setRoleId(null); load(); }
    catch (e) { toast(e.message, "bad"); }
  };

  const role = d && d.roles ? d.roles.find((r) => r.id === roleId) : null;
  const roleHeld = useMemo(
    () => (role ? role.permissions.map((p) => `${p.module}.${p.action}`) : []),
    [role]);
  useEffect(() => { setHeld(roleHeld); }, [roleHeld]);

  const total = d && d.modules ? d.modules.reduce((a, m) => a + m.actions.length, 0) : 0;
  const dirty = role && (held.length !== roleHeld.length || held.some((k) => !roleHeld.includes(k)));

  const has = (k) => held.includes(k);
  const set = (k, on) => setHeld((cur) => (on ? [...new Set([...cur, k])] : cur.filter((x) => x !== k)));

  /* "View" is the floor. Ticking Create on a module the role cannot even see
     grants a permission it can never reach, and unticking View while Create
     is on leaves the same broken pair the questions screen warns about — so
     the two move together rather than being left to be got right by hand. */
  const setCell = (mod, action, on) => {
    const key = `${mod.id}.${action}`;
    if (on && action !== "view" && mod.actions.some((a) => a.action === "view")) {
      setHeld((cur) => [...new Set([...cur, key, `${mod.id}.view`])]);
      return;
    }
    if (!on && action === "view") {
      setHeld((cur) => cur.filter((x) => !x.startsWith(`${mod.id}.`)));
      return;
    }
    set(key, on);
  };

  const allOf = (mod) => mod.actions.map((a) => `${mod.id}.${a.action}`);
  const modState = (mod) => {
    const keys = allOf(mod);
    const on = keys.filter(has).length;
    return on === 0 ? "none" : on === keys.length ? "all" : "some";
  };
  const toggleModule = (mod) => {
    const keys = allOf(mod);
    setHeld((cur) => (modState(mod) === "all"
      ? cur.filter((x) => !keys.includes(x))
      : [...new Set([...cur, ...keys])]));
  };

  const save = async () => {
    setBusy(true);
    try {
      const permissions = held.map((k) => {
        const [module, action] = k.split(".");
        return { module, action };
      });
      await api.put(`/users/roles/${roleId}/permissions`, { permissions });
      toast(`${role.name} saved`);
      load();
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  if (d === false) return <div className="dk-card"><div className="dk-empty">Could not read the roles.</div></div>;

  const needle = q.trim().toLowerCase();
  const mods = !d || !d.modules ? [] : d.modules.filter((m) => !needle
    || m.label.toLowerCase().includes(needle)
    || (m.screens || []).some((sc) => sc.toLowerCase().includes(needle))
    || m.actions.some((a) => a.label.toLowerCase().includes(needle)));

  return (
    <div className="dk-perm">
      <div className="dk-card flush">
        {/* Adding a role lives at the top of the list of roles, which is the
            only place anybody looks for it. Before this there was no way to
            make one at all: the three that shipped were the three you had. */}
        <div className="dk-card-head">
          <h3>Roles</h3>
          <button className="dk-sbtn" onClick={() => setAdding(true)}>
            <Icon n="plus" size={14} /> New role
          </button>
        </div>
        {d === null ? <div className="dk-empty">Loading…</div> : d.roles.map((r) => (
          <button key={r.id} className={`dk-rolerow ${roleId === r.id ? "on" : ""}`} onClick={() => setRoleId(r.id)}>
            <span className="top">
              <span className="nm">{r.name}</span>
              <span className="cnt dk-n">{r.user_count} {r.user_count === 1 ? "person" : "people"}</span>
            </span>
            <span className="note dk-n">
              {r.permissions.length} of {total} permissions{r.is_system ? " · built in" : ""}
            </span>
          </button>
        ))}
        <div style={{ padding: "14px 18px", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.55 }}>
          Every box here is a check the server makes. Only the actions the app
          actually enforces are offered — where a card has no Delete, nothing
          behind that screen deletes anything.
        </div>
      </div>

      <div className="dk-card flush">
        {!role ? <div className="dk-empty">Pick a role.</div> : (
          <>
            <div className="dk-permhead">
              <div style={{ minWidth: 0 }}>
                <h3>{role.name}</h3>
                <div className="sub">
                  {role.user_count} {role.user_count === 1 ? "person" : "people"} on this role
                  {role.is_system ? " · built in" : ""}
                </div>
              </div>
              <div className="dk-permtally">
                <div>
                  <div className="v dk-n" style={{ color: "var(--good)" }}>{held.length}</div>
                  <div className="l">allowed</div>
                </div>
                <div>
                  <div className="v dk-n" style={{ color: "var(--danger)" }}>{total - held.length}</div>
                  <div className="l">blocked</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {/* Only on roles the shop made. Admin and Cashier are named in
                    the sign-in hint and in the seed, so renaming or deleting
                    one would break sentences elsewhere — the server refuses
                    both, and the buttons say so by not being here. */}
                {!role.is_system && (
                  <>
                    <button className="dk-sbtn" onClick={() => rename(role)}>Rename</button>
                    <button className="dk-sbtn" onClick={() => remove(role)}>Delete</button>
                  </>
                )}
                <button className="dk-sbtn" disabled={!dirty || busy} onClick={() => setHeld(roleHeld)}>Reset</button>
                <button className="dk-sbtn primary" disabled={!dirty || busy} onClick={save}>
                  {busy ? "Saving…" : "Save role"}
                </button>
              </div>
            </div>

            <div className="dk-permsearch">
              <input className="dk-input" value={q} onChange={(e) => setQ(e.target.value)}
                     placeholder="Find a screen or an action" />
              <span>{mods.length} of {(d.modules || []).length} areas</span>
            </div>

            {/* ── One matrix, one screen ────────────────────────────────────
                This was eleven cards, each with a heading, a sentence and up
                to six checkboxes carrying their own descriptions — about
                1,800px of page for a role that can be stated in a grid of
                tickboxes. Reading it meant scrolling, and comparing "may
                Purchases be deleted?" against "may Sales be deleted?" meant
                scrolling twice and remembering.

                It is now a row per area and a column per action, which fits a
                whole role on one screen at laptop height. Nothing is lost:
                the descriptions the cards spelled out are on the cells as
                tooltips, and the column headings say what each one means. */}
            <div className="dk-permmatrix-wrap dk-s">
              <table className="dk-permmatrix">
                <thead>
                  <tr>
                    <th className="mod">Area of the app</th>
                    {ACTION_COLS.map(([a, label, note]) => (
                      <th key={a} title={note}>{label}</th>
                    ))}
                    <th className="all" />
                  </tr>
                </thead>
                <tbody>
                  {mods.map((m) => {
                    const st = modState(m);
                    const by = new Map(m.actions.map((a) => [a.action, a]));
                    return (
                      <tr key={m.id} className={st}>
                        <th scope="row" className="mod">
                          <span className="t">{m.label}</span>
                          <span className="sc">{(m.screens || []).join(" · ") || m.note}</span>
                        </th>
                        {ACTION_COLS.map(([a]) => {
                          const act = by.get(a);
                          /* An action this area does not have is left blank
                             rather than drawn as an unticked box — an empty
                             box says "off", and off is not the same as "there
                             is nothing here to allow". */
                          if (!act) return <td key={a} className="na" aria-hidden="true" />;
                          const key = `${m.id}.${a}`;
                          return (
                            <td key={a}>
                              <label className="dk-check" title={`${act.label} — ${act.note}`}>
                                <input type="checkbox" checked={has(key)}
                                       aria-label={`${m.label}: ${act.label}`}
                                       onChange={(e) => setCell(m, a, e.target.checked)} />
                                <span className="box" />
                              </label>
                            </td>
                          );
                        })}
                        <td className="all">
                          <button type="button" className="dk-permall" onClick={() => toggleModule(m)}>
                            {st === "all" ? "None" : "All"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ padding: "16px 24px", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6, borderTop: "1px solid var(--line)" }}>
              Seeing a screen is the floor: ticking anything else on a card turns
              its view on with it, and turning view off clears the card. The two
              were separable before, and a role given “create” without “view”
              held a permission it could never reach.
            </div>
          </>
        )}
      </div>

      {adding && (
        <NewRoleDialog roles={(d && d.roles) || []} onClose={() => setAdding(false)}
                       onCreated={(id) => { setAdding(false); load(id); }} />
      )}
    </div>
  );
}

function StaffList() {
  const [users, setUsers] = useState(null);
  const [roles, setRoles] = useState([]);
  const [editor, setEditor] = useState(null);
  const [pinFor, setPinFor] = useState(null);

  const load = () => {
    api.get("/users").then((d) => setUsers(d.rows || d)).catch(() => setUsers([]));
    api.get("/users/roles").then(setRoles).catch(() => setRoles([]));
  };
  useEffect(() => { load(); }, []);

  const toggle = async (u) => {
    if (u.status === "active" && !(await confirmDialog({
      title: `Switch off ${u.full_name || u.username}?`,
      message: "They will not be able to sign in until the account is switched back on. Nothing they recorded is deleted.",
      danger: true, confirmLabel: "Switch off",
    }))) return;
    try {
      await api.put(`/users/${u.id}`, { status: u.status === "active" ? "inactive" : "active" });
      toast(u.status === "active" ? `${u.full_name || u.username} switched off` : `${u.full_name || u.username} switched on`);
      load();
    } catch (e) { toast(e.message, "bad"); }
  };

  return (
    <>
      <div className="dk-card dk-tablecard">
        <div className="dk-tablehead">
          <h3>Staff accounts</h3>
          <div className="spacer" />
          {can("users", "create") && <button className="dk-create" style={{ height: 38 }} onClick={() => setEditor({})}>+ Add staff</button>}
        </div>
        <div className="dk-tablewrap dk-s">
          <table className="dk-table">
            <thead>
              <tr><th>Name</th><th>Username</th><th>Role</th><th>PIN</th><th>Status</th><th style={{ width: 220 }} /></tr>
            </thead>
            <tbody>
              {users === null ? <LoadingRows cols={6} />
                : users.length === 0 ? <tr><td colSpan={6}><div className="dk-empty">No staff accounts yet.</div></td></tr>
                : users.map((u) => (
                  <tr key={u.id}>
                    <td className="strong">{u.full_name || "—"}</td>
                    <td className="tight dk-n dim">{u.username}</td>
                    <td className="tight">{u.role_name || "—"}</td>
                    <td className="tight">
                      <span className={`dk-tpill ${u.has_pin ? "good" : ""}`}>{u.has_pin ? "set" : "none"}</span>
                    </td>
                    <td className="tight">
                      <span className={`dk-tpill ${u.status === "active" ? "good" : ""}`}>{u.status || "active"}</span>
                    </td>
                    <td className="r" style={{ whiteSpace: "nowrap" }}>
                      {can("users", "edit") && (
                        <>
                          <button className="dk-minibtn ghost" onClick={() => setPinFor(u)}>
                            {u.has_pin ? "Change PIN" : "Set PIN"}
                          </button>
                          {/* Switching an account off locks a person out — it
                              must not look like the neutral "Set PIN" beside it. */}
                          <button className="dk-minibtn ghost" onClick={() => toggle(u)}
                                  title={u.status === "active" ? "Deactivate this account — they can no longer sign in" : "Let this person sign in again"}
                                  style={u.status === "active"
                                    ? { marginLeft: 6, color: "var(--danger)", borderColor: "var(--danger)", background: "var(--danger-soft)" }
                                    : { marginLeft: 6 }}>
                            {u.status === "active" ? "Switch off" : "Switch on"}
                          </button>
                        </>
                      )}
                      {/* Removing is not switching off, and the wording says so.
                          An account that ever sold anything is retired rather
                          than erased — its id is on every invoice it rang up —
                          and the server decides which of the two happens. */}
                      {can("users", "delete") && u.status !== "removed" && (
                        <button className="dk-minibtn ghost" style={{ marginLeft: 6 }}
                                title="Take this person off the business entirely"
                                onClick={() => remove(u)}>Remove</button>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
      {editor && <StaffEditor roles={roles} onClose={() => setEditor(null)}
        onSaved={() => { setEditor(null); load(); toast("Staff account created"); }} />}
      {pinFor && <PinEditor user={pinFor} onClose={() => setPinFor(null)}
        onSaved={() => { setPinFor(null); load(); }} />}
    </>
  );
}

function StaffEditor({ roles, onClose, onSaved }) {
  const [f, setF] = useState({ full_name: "", username: "", password: "", role_id: "" });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!f.username.trim() || !f.password) return toast("A username and password are needed", "bad");
    setBusy(true);
    try { await api.post("/users", { ...f, role_id: f.role_id ? Number(f.role_id) : undefined }); onSaved(); }
    catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title="Add a staff account" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <label className="dk-field"><span>Full name</span>
          <input className="dk-input" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} autoFocus />
        </label>
        <label className="dk-field"><span>Username</span>
          <input className="dk-input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
        </label>
        <label className="dk-field"><span>Password</span>
          <input className="dk-input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </label>
        <label className="dk-field"><span>Role</span>
          <select className="dk-input" value={f.role_id} onChange={(e) => setF({ ...f, role_id: e.target.value })}>
            <option value="">Choose a role…</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
        <button className="dk-sbtn" onClick={onClose}>Cancel</button>
        <button className="dk-sbtn primary" disabled={busy} onClick={save}>{busy ? "Creating…" : "Create account"}</button>
      </div>
    </Modal>
  );
}

/* Set or clear a counter PIN. The PIN is never read back — it is hashed the
   moment it is saved, so this can set a new one but never show the old. */
function PinEditor({ user, onClose, onSaved }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (value) => {
    setBusy(true);
    try {
      const r = await api.put(`/users/${user.id}/pin`, { pin: value });
      toast(r.message || (value ? "PIN set" : "PIN removed"));
      onSaved();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title={`${user.has_pin ? "Change" : "Set"} PIN — ${user.full_name || user.username}`} onClose={onClose}>
      <p style={{ marginTop: 0, color: "var(--faint)", fontSize: 13.5, lineHeight: 1.55 }}>
        Four digits, typed at the sign-in screen instead of a password. It is stored scrambled, so nobody —
        including you — can read it back afterwards.
      </p>
      <label className="dk-field">
        <span>New PIN</span>
        <input className="dk-input dk-n" inputMode="numeric" placeholder="••••" autoFocus
               value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
               onKeyDown={(e) => { if (e.key === "Enter" && pin.length === 4) save(pin); }} />
      </label>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 20 }}>
        {user.has_pin
          ? <button className="dk-sbtn" disabled={busy} onClick={() => save("")}>Remove PIN</button>
          : <span />}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="dk-sbtn" onClick={onClose}>Cancel</button>
          <button className="dk-sbtn primary" disabled={busy || pin.length !== 4} onClick={() => save(pin)}>
            {busy ? "Saving…" : "Save PIN"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RoleMatrix() {
  const [d, setD] = useState(null);
  const [roleId, setRoleId] = useState(null);
  const [granted, setGranted] = useState([]);
  const [busy, setBusy] = useState(false);

  const [adding, setAdding] = useState(false);

  const load = (select) => api.get("/users/permission-catalogue").then((r) => {
    setD(r);
    setRoleId((cur) => {
      const want = select ?? cur;
      return want && r.roles.some((x) => x.id === want) ? want : (r.roles[0] || {}).id ?? null;
    });
  }).catch(() => setD(false));
  useEffect(() => { load(); }, []);

  const role = d && d.roles ? d.roles.find((r) => r.id === roleId) : null;
  useEffect(() => { setGranted(role ? [...role.granted] : []); }, [roleId, d]);

  const total = d && d.groups ? d.groups.reduce((a, g) => a + g.rows.length, 0) : 0;
  const dirty = role && (granted.length !== role.granted.length
    || granted.some((g) => !role.granted.includes(g)));

  const set = (id, on) => setGranted((g) => (on ? [...new Set([...g, id])] : g.filter((x) => x !== id)));

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/users/roles/${roleId}/catalogue`, { granted });
      toast(`${role.name} saved`);
      load();
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  if (d === false) return <div className="dk-card"><div className="dk-empty">Could not read the roles.</div></div>;

  return (
    <div className="dk-perm">
      <div className="dk-card flush">
        {/* The same New role control as the grid view. Whichever editor
            somebody happens to be in is where they will look for it. */}
        <div className="dk-card-head">
          <h3>Roles</h3>
          <button className="dk-sbtn" onClick={() => setAdding(true)}>
            <Icon n="plus" size={14} /> New role
          </button>
        </div>
        {d === null ? <div className="dk-empty">Loading…</div> : d.roles.map((r) => (
          <button key={r.id} className={`dk-rolerow ${roleId === r.id ? "on" : ""}`} onClick={() => setRoleId(r.id)}>
            <span className="top">
              <span className="nm">{r.name}</span>
              <span className="cnt dk-n">{r.user_count} {r.user_count === 1 ? "person" : "people"}</span>
            </span>
            <span className="note dk-n">{r.granted.length} of {total} allowed</span>
          </button>
        ))}
        <div style={{ padding: "14px 18px", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.55 }}>
          A role is a set of answers to “can they?”. Change the role and everyone on it changes with it.
        </div>
      </div>

      <div className="dk-card flush">
        {!role ? <div className="dk-empty">Pick a role.</div> : (
          <>
            <div className="dk-permhead">
              <div style={{ minWidth: 0 }}>
                <h3>{role.name}</h3>
                <div className="sub">
                  {role.user_count} {role.user_count === 1 ? "person" : "people"} on this role
                  {role.is_system ? " · built in" : ""}
                </div>
              </div>
              <div className="dk-permtally">
                <div>
                  <div className="v dk-n" style={{ color: "var(--good)" }}>{granted.length}</div>
                  <div className="l">allowed</div>
                </div>
                <div>
                  <div className="v dk-n" style={{ color: "var(--danger)" }}>{total - granted.length}</div>
                  <div className="l">blocked</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="dk-sbtn" disabled={!dirty || busy} onClick={() => setGranted([...role.granted])}>Reset</button>
                <button className="dk-sbtn primary" disabled={!dirty || busy} onClick={save}>
                  {busy ? "Saving…" : "Save role"}
                </button>
              </div>
            </div>

            {role.orphans && role.orphans.length > 0 && (
              <div style={{ padding: "14px 24px", background: "var(--warn-soft)", color: "var(--warnc)",
                            fontSize: 12.5, lineHeight: 1.6, borderBottom: "1px solid var(--line)" }}>
                <b>This role holds {role.orphans.length} stray permission{role.orphans.length === 1 ? "" : "s"}</b> that
                no question above fully covers — {role.orphans.join(", ")}. It was given half of what a question needs,
                so that question reads as blocked. Saving this role will drop the stray half.
              </div>
            )}

            {d.groups.map((g) => (
              <div key={g.group}>
                <div className="dk-permgroup">{g.group}</div>
                {g.rows.map((p) => {
                  const on = granted.includes(p.id);
                  return (
                    <div className="dk-permrow" key={p.id}>
                      <div className="t">
                        <div>{p.label}</div>
                        <div>{p.note}</div>
                      </div>
                      <div className="dk-permseg">
                        <button className={`allow ${on ? "on" : ""}`} onClick={() => set(p.id, true)}>Allowed</button>
                        <button className={`block ${!on ? "on" : ""}`} onClick={() => set(p.id, false)}>Blocked</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}

            <div style={{ padding: "16px 24px", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6, borderTop: "1px solid var(--line)" }}>
              The design also offers a middle setting — “needs a nod”, where a manager approves at the moment it
              happens. Nothing in the app can ask for that approval yet, so it is not offered here rather than
              being shown and quietly ignored.
            </div>
          </>
        )}
      </div>

      {adding && (
        <NewRoleDialog roles={(d && d.roles) || []} onClose={() => setAdding(false)}
                       onCreated={(id) => { setAdding(false); load(id); }} />
      )}
    </div>
  );
}

