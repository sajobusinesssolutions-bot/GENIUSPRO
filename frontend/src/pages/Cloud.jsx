import React, { useEffect, useState } from "react";
import api, { can } from "../lib/api.js";
import { toast, confirmDialog, Empty } from "../lib/ui.jsx";
import { LoadFailed } from "../lib/deckui.jsx";
import { Icon } from "../lib/icons.jsx";

/**
 * Cloud.jsx — this business's books, kept on the server.
 *
 * The screen's job is to make one thing unmistakable before either button is
 * pressed: **which copy is newer, and what pressing this would replace.**
 *
 * That is the whole risk here. Both actions are safe on their own — the upload
 * is the same verified export the Companies screen makes, the download is the
 * same restore with the same control totals — and both are catastrophic in the
 * one case where somebody presses them not knowing that the other copy has a
 * day's trading in it. So the state is stated in words at the top, the buttons
 * change their labels to match it, and a refusal from the server is shown as a
 * question rather than as an error.
 */
const kb = (n) => (!n ? "—" : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const when = (t) => (t ? new Date(String(t).replace(" ", "T")).toLocaleString() : "never");

export default function Cloud() {
  const [s, setS] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState("");

  const load = () => {
    setFailed(false);
    api.get("/system/cloud").then(setS).catch(() => setFailed(true));
  };
  useEffect(load, []);

  /* Both buttons take the same shape: try, and if the server refuses because
     of what is on the other side, put that refusal to the person as a decision
     with the consequence spelled out. Nothing is retried automatically. */
  const act = async (which) => {
    const isUp = which === "upload";
    setBusy(which);
    try {
      const r = await api.post(`/system/cloud/${which}`, {});
      toast(isUp ? "Your books are on the server" : "Your books have been brought back");
      load();
      if (!isUp) setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      const d = e.errors || {};
      if (d.conflict) {
        const ok = await confirmDialog({
          title: isUp ? "Replace the copy on the server?" : "Replace the books on this computer?",
          message: e.message,
          detail: isUp
            ? `The copy up there was sent from another computer${d.theirs && d.theirs.at ? ` on ${when(d.theirs.at)}` : ""}. ` +
              "If that computer has trading on it that this one does not, uploading loses it — and there is no undo."
            : `The copy on the server was taken ${d.taken_at ? when(d.taken_at) : "earlier"}. ` +
              "Everything recorded here since your last upload is replaced by it, and is not saved anywhere else. " +
              "Take a backup from Settings → Backup first if you are not certain.",
          danger: true,
          confirmLabel: isUp ? "Replace the server's copy" : "Replace what is here",
        });
        if (!ok) { setBusy(""); return; }
        try {
          await api.post(`/system/cloud/${which}`, { force: true });
          toast(isUp ? "Sent" : "Brought back");
          load();
          if (!isUp) setTimeout(() => window.location.reload(), 900);
        } catch (e2) { toast(e2.message, "bad"); }
      } else {
        toast(e.message, "bad");
      }
    }
    setBusy("");
  };

  if (failed) return <div className="dk-card"><LoadFailed what="the server copy" onRetry={load} /></div>;
  if (!s) return <div className="dk-card"><div className="dk-empty">Asking the server…</div></div>;

  /* ── already online ───────────────────────────────────────────────────
     When the books are hosted there is no "copy on the server" to reason
     about: there is one database, it is not on this computer, and every till
     and phone signed into this business is reading it live. The two-copies
     screen below would be actively misleading here — its Send button would
     invite somebody to write a snapshot over a live database — so it is not
     shown at all. */
  if (s.hosted) {
    return (
      <div className="dk-page sync">
        <section className="dk-card sync-verdict good">
          <h2>These books are online</h2>
          <p>
            This business is kept on a hosted database, not in a file on this computer. Every
            till, phone and computer signed in to this business is working on the same books at
            the same time — a sale rung up at the counter is on the phone in the back office the
            moment it is saved. There is nothing to send up or bring down.
          </p>
          {s.hosted_at ? (
            <p className="sync-note">
              Where they are kept: <code>{s.hosted_at}</code>
            </p>
          ) : null}
        </section>

        <section className="dk-card">
          <h3>If this computer is lost tonight</h3>
          <p className="sync-note">
            Nothing goes with it. The books are not on it. Sign in on another computer or phone
            and carry on trading.
          </p>
          <h3>Backups</h3>
          <p className="sync-note">
            Because there is no database file here, the daily copy this app used to take does not
            run. Backups are the hosting provider's job — make sure point-in-time restore is
            switched on with whoever hosts the database. You can still take a copy you hold
            yourself at any time from Companies → this business → Download a copy.
          </p>
        </section>

        <Access />
      </div>
    );
  }

  if (!s.licensed) {
    return (
      <div className="dk-page sync">
        <section className="dk-card sync-verdict">
          <h2>Keeping a copy on the server needs a licence</h2>
          <p>
            The server copy travels through the same server your licence checks in with, and it is
            part of a paid plan. Type a licence key under Settings → Licence and this screen becomes
            available.
          </p>
          <p className="sync-note">
            Until then, your books are safe the ordinary way: Settings → Backup takes a copy you can
            put on a flash drive or another computer.
          </p>
        </section>
      </div>
    );
  }

  const remote = s.remote;
  const local = { changed: s.changed_since_upload, at: s.uploaded_at };

  /* Which of the two is ahead, said as a sentence rather than as two dates the
     reader has to compare themselves. */
  const verdict = !remote ? {
    tone: "", title: "Nothing has been sent yet",
    body: "There is no copy of this business on the server. Send one and it will be safe even if this computer is lost.",
  } : local.changed ? {
    tone: "warn", title: "This computer has newer work",
    body: `Sales, payments or stock have been recorded here since the last upload on ${when(local.at)}. Send them up to make the server's copy current.`,
  } : remote.from_this_computer ? {
    tone: "good", title: "The server has this computer's books",
    body: `Sent ${when(remote.at)}. Nothing has changed here since, so the two copies agree.`,
  } : {
    tone: "warn", title: "The server's copy came from another computer",
    body: `Sent ${when(remote.at)} from a different machine. Bring it down to work on those books here — but only if this computer has nothing on it that the other one lacks.`,
  };

  return (
    <div className="dk-page sync">
      {/* ── Where this business lives ────────────────────────────────────
          The screen used to open on a verdict about two copies, which is the
          right thing to say second. The first thing somebody needs is the
          state: is this business kept on this computer, or on the server, and
          what does that mean if this machine is stolen tonight. */}
      <div className="sync-where">
        <div className={`sync-side ${!remote || local.changed ? "on" : ""}`}>
          <span className="ic" aria-hidden="true"><Icon n="box" size={19} /></span>
          <div>
            <div className="t">This computer</div>
            <div className="s">
              {local.changed ? "Holds work the server has not got" : "Matches what was last sent"}
            </div>
          </div>
        </div>

        <div className="sync-arrow" aria-hidden="true">
          <svg viewBox="0 0 40 24" width="40" height="24" fill="none" stroke="currentColor"
               strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 9h30M29 4l5 5-5 5" /><path d="M36 19H6M11 24l-5-5 5-5" />
          </svg>
        </div>

        <div className={`sync-side ${remote && !local.changed ? "on" : ""}`}>
          <span className="ic" aria-hidden="true"><Icon n="download" size={19} /></span>
          <div>
            <div className="t">The server</div>
            <div className="s">
              {remote
                ? `${kb(remote.bytes)}, taken ${when(remote.at)}`
                : "Nothing has been sent yet"}
            </div>
          </div>
        </div>
      </div>

      <section className={`dk-card sync-verdict ${verdict.tone}`}>
        <h2>{verdict.title}</h2>
        <p>{verdict.body}</p>

        {s.reachable === false && (
          <p className="sync-note">
            The server could not be reached just now{s.why ? ` — ${s.why}` : ""}. The till works exactly as it
            is; only sending and fetching need a line.
          </p>
        )}

        <div className="sync-acts">
          <button className="dk-sbtn primary" style={{ height: 44 }}
                  disabled={!!busy || s.reachable === false} onClick={() => act("upload")}>
            {busy === "upload" ? "Sending…" : "Put this business on the server"}
          </button>
          <button className="dk-sbtn" style={{ height: 44 }}
                  disabled={!!busy || !remote || s.reachable === false}
                  onClick={() => act("download")}>
            {busy === "download" ? "Fetching…" : "Bring the server's copy down"}
          </button>
        </div>
      </section>

      <Access />

      <section className="dk-card sync-facts">
        <div className="dk-card-head"><h3>What this is, and what it is not</h3></div>
        <ul>
          <li>
            <b>It is a copy off the premises, and a way to move a business to another computer.</b>
            {" "}Sending it up copies the whole business; bringing it down replaces the whole
            business, checking the same control totals a restore from a file does.
          </li>
          <li>
            <b>It is not a second till.</b> The books live in one place at a time. If this computer
            and another have both recorded work, one of them has to win, and the app asks you which
            rather than merging them — merging rows that both machines numbered the same way is how
            a sale silently becomes somebody else's.
          </li>
          <li>
            <b>The copy here does not go away.</b> Sending the books up does not delete them from
            this computer, and it should not: the till has to keep selling when the network is
            down, which is the whole reason it stores its own books in the first place.
          </li>
          <li>
            <b>Nothing is overwritten quietly.</b> Both directions refuse when the other side has
            work yours does not, and say what would be lost before you decide.
          </li>
          <li>
            <b>It travels with your licence.</b> There is no separate password to lose, and a
            blocked licence cannot reach the books.
          </li>
        </ul>
      </section>
    </div>
  );
}

/* ── Who can open this business ───────────────────────────────────────────
 *
 * The question anybody asks the moment their books leave the building, and
 * this screen could not answer it. The list is the same one the Companies
 * screen keeps — memberships against the account that owns each email — read
 * here rather than copied, so the two can never disagree.
 *
 * Read-only. Granting and revoking is a decision about a business, and it
 * belongs on the screen that manages businesses; this says who is on the list
 * and links there.
 */
function Access() {
  const [rows, setRows] = useState(null);
  const [firm, setFirm] = useState(null);

  useEffect(() => {
    if (!can("companies", "grant")) return setRows(false);
    api.get("/settings/firm")
      .then((f) => { setFirm(f || null); return api.get(`/companies/${f.id}/people`); })
      .then(setRows)
      .catch(() => setRows(false));
  }, []);

  if (rows === false) {
    return (
      <section className="dk-card sync-access">
        <div className="dk-card-head"><h3>Who can open this business</h3></div>
        <div className="dk-empty">
          You do not have permission to see the access list for this business.
        </div>
      </section>
    );
  }

  return (
    <section className="dk-card sync-access">
      <div className="dk-card-head">
        <h3>Who can open this business</h3>
        {Array.isArray(rows) && <span className="n dk-n">{rows.length} {rows.length === 1 ? "person" : "people"}</span>}
        <button className="dk-sbtn"
                onClick={() => window.dispatchEvent(new CustomEvent("vy-nav", { detail: { page: "companies" } }))}>
          Manage access
        </button>
      </div>
      {rows === null ? (
        <div className="dk-empty">Loading…</div>
      ) : rows.length === 0 ? (
        <Empty title="Only you" hint="Nobody else has been given access to this business." />
      ) : (
        <>
          <div className="sync-people">
            {rows.map((r) => (
              <div className="row" key={r.id}>
                <span className="av">
                  {String(r.full_name || r.email || "?").trim()[0].toUpperCase()}
                </span>
                <span className="who">
                  <b>{r.full_name || r.email}</b>
                  <em>{r.email}</em>
                </span>
                <span className="rl">{r.is_owner ? "Owner" : (r.role_name || "No role")}</span>
                <span className={`st ${r.status === "active" ? "on" : ""}`}>
                  {r.status === "active" ? "active" : r.status}
                </span>
              </div>
            ))}
          </div>
          <div className="sync-foot">
            These are the people who can sign in to <b>{(firm && firm.name) || "this business"}</b> from any
            computer once it is on the server. Everyone else — the cashiers with a username and a PIN —
            can only reach it from a machine that already holds the books.
          </div>
        </>
      )}
    </section>
  );
}
