import React, { useEffect, useRef, useState } from "react";
import api from "../lib/api.js";
import { toast } from "../lib/ui.jsx";

/**
 * Update.jsx — what version this is, what the new one is, and how far it has got.
 *
 * Until now the updater spoke only through native message boxes. That means a
 * shopkeeper could not answer any of the three questions people actually have
 * — what am I running, what changed, is it nearly done — except by waiting for
 * a box to appear on the updater's own schedule, usually mid-queue. And when
 * one did appear it offered "Install and restart" with no way to read what was
 * in the release first.
 *
 * So the same information is a screen. The dialogs stay for the background
 * check, because somebody who never opens this screen still has to be told.
 */
const STAGES = {
  idle:        { title: "Ready to look", tone: "" },
  checking:    { title: "Looking for a new version…", tone: "" },
  current:     { title: "This is the newest version", tone: "good" },
  downloading: { title: "Downloading the new version…", tone: "" },
  ready:       { title: "A new version is ready to install", tone: "good" },
  failed:      { title: "Could not check for a new version", tone: "bad" },
};

export default function Update() {
  const [s, setS] = useState(null);
  const [serverVersion, setServerVersion] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  const bridge = typeof window !== "undefined" ? window.geniusUpdate : null;

  /* Poll while something is happening, and stop when it is not. A screen that
     polls for ever costs a shop's battery to tell it nothing. */
  const refresh = () => {
    if (!bridge) return;
    bridge.status().then((st) => {
      setS(st);
      const moving = st && (st.checking || st.status === "downloading");
      clearTimeout(timer.current);
      if (moving) timer.current = setTimeout(refresh, 1200);
    }).catch(() => {});
  };

  useEffect(() => {
    refresh();
    /* The version the server was built as, which is what a browser-only
       installation can be told even with no updater behind it. */
    api.get("/system/version").then((v) => setServerVersion(v && v.version)).catch(() => {});
    return () => clearTimeout(timer.current);
  }, []);

  const check = async () => {
    setBusy(true);
    try { await bridge.check(); } catch (e) { toast(String(e.message || e), "bad"); }
    setBusy(false);
    setTimeout(refresh, 300);
  };

  /* The background schedule, on or off. Turning it off does not mean "never
     update" — the Check now button below still works, and still says what is
     available. It exists for a shop on a metered phone connection, where a
     90MB installer downloading silently in the background is money, and for a
     shop that has settled on a version that works. */
  const setAuto = async (on) => {
    if (!bridge.setAuto) return toast("This build cannot change that setting", "bad");
    const r = await bridge.setAuto(on).catch((e) => ({ ok: false, why: String(e.message || e) }));
    if (!r || !r.ok) return toast((r && r.why) || "That could not be saved", "bad");
    toast(on ? "Genius POS will check on its own again" : "Automatic checking is off");
    refresh();
  };

  const install = async () => {
    setBusy(true);
    const r = await bridge.install().catch((e) => ({ ok: false, why: String(e.message || e) }));
    if (!r || !r.ok) { toast((r && r.why) || "Nothing to install", "bad"); setBusy(false); return; }
    toast("Installing — the till will close and come back on its own");
  };

  /* No desktop shell behind this window: a browser cannot update a program it
     is not running. Said plainly, with the version and where to get the new
     one, rather than showing a Check button that could never do anything. */
  if (!bridge || !bridge.available) {
    return (
      <div className="upd">
        <div className="upd-card">
          <div className="upd-badge">Version {serverVersion || "—"}</div>
          <h2>Updates are handled by the desktop app</h2>
          <p>
            This window is the till running in a browser, and a browser cannot replace a program
            it is not running. On the computer where Genius POS is installed, the app checks for
            a new version by itself and offers to install it.
          </p>
          <p className="upd-note">
            If this <em>is</em> the installed app and you are seeing this, the copy was started from
            source or is the portable build — both update by downloading the newest file.
          </p>
        </div>
      </div>
    );
  }

  if (!s) return <div className="upd"><div className="upd-card"><h2>Reading the updater…</h2></div></div>;

  const stage = s.checking ? STAGES.checking : (STAGES[s.status] || STAGES.idle);
  const pct = Number(s.percent) || 0;

  return (
    <div className="upd">
      <div className={`upd-card ${stage.tone}`}>
        <div className="upd-badge">Version {s.current || serverVersion || "—"}</div>
        <h2>{stage.title}</h2>

        {s.status === "downloading" && (
          <>
            <p>Version {s.version} is coming down. The till keeps working — nothing stops until you install it.</p>
            <div className="upd-bar"><i style={{ width: `${pct}%` }} /></div>
            <div className="upd-pct dk-n">{pct}%</div>
          </>
        )}

        {s.status === "ready" && (
          <p>
            Version {s.version} is on this computer and waiting. Installing takes about half a
            minute and closes the till while it runs, so finish serving anybody at the counter first.
          </p>
        )}

        {s.status === "current" && (
          <p>Nothing to do. This copy is the newest one published.</p>
        )}

        {s.status === "failed" && (
          <>
            <p>{s.why || "The check did not go through."}</p>
            <p className="upd-note">
              This is the ordinary case when the shop is offline, and it changes nothing:
              the till carries on working exactly as it is, with the books on this computer.
            </p>
          </>
        )}

        {!s.updatable && (
          <p className="upd-note">
            {s.portable
              ? "This is the portable build. It cannot replace itself — download the newest file and put it in place of this one. Your books are kept separately and are not touched."
              : !s.packaged
                ? "This copy is running from source, so there is nothing to update. Pull and rebuild instead."
                : "This copy cannot update itself. The newest version is always on the downloads page."}
          </p>
        )}

        {/* Where it looks, and when it last looked. A shop told "could not
            check for a new version" with no idea what it was checking has
            nothing it can report to anybody. */}
        <div className="upd-src">
          <span>
            Checks <b>{s.repo || "the project's GitHub releases"}</b> on GitHub
            {s.lastCheck ? ` · last looked ${new Date(s.lastCheck).toLocaleString()}` : " · not looked yet"}
          </span>
        </div>

        <div className="upd-acts">
          {s.status === "ready" ? (
            <button className="btn btn-primary" onClick={install} disabled={busy}>
              Install version {s.version} and restart
            </button>
          ) : (
            <button className="btn btn-primary" onClick={check} disabled={busy || !s.updatable || s.checking}>
              {s.checking ? "Looking…" : "Check now"}
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => bridge.releases()}>
            What is new — open the releases page
          </button>
        </div>
      </div>

      {s.notes ? (
        <div className="upd-card">
          <h3>What changed in {s.version}</h3>
          <div className="upd-notes"
               dangerouslySetInnerHTML={{ __html: sanitiseNotes(s.notes) }} />
        </div>
      ) : null}

      {/* The switch, on its own card. It is a decision about this
          installation rather than a step in checking, and putting it beside
          the Check button would make it look like part of the check. */}
      {s.packaged && !s.portable && (
        <div className="upd-card">
          <label className="upd-auto">
            <input type="checkbox" checked={s.auto !== false}
                   onChange={(e) => setAuto(e.target.checked)} />
            <span>
              <b>Check for new versions on its own</b>
              <em>
                Looks every few hours and downloads quietly in the background, then waits here
                until somebody installs it. Turn it off on a metered connection, or when this shop
                has settled on a version that works — the Check now button above still works either
                way, so nothing is out of reach.
              </em>
            </span>
          </label>
        </div>
      )}

      <div className="upd-card upd-quiet">
        <h3>What an update does and does not touch</h3>
        <ul>
          <li><b>Your books are not in the program.</b> The database lives outside it and is untouched by an update — installing one cannot lose a sale.</li>
          <li><b>Nothing installs by itself.</b> A new version downloads quietly in the background and then waits here until somebody says so — and the downloading can be switched off too.</li>
          <li><b>It watches one place.</b> The releases published to this project's GitHub repository, named above. Nothing else can offer this till an update.</li>
          <li><b>An update can be postponed for ever.</b> The till does not stop working because a newer one exists.</li>
        </ul>
      </div>
    </div>
  );
}

/**
 * Release notes come from GitHub as HTML written by whoever published the
 * release. It is our own release page, but it is still markup arriving from a
 * network fetch and being put into the page — so only the handful of tags a
 * release note needs survive, and everything else is shown as the text it was.
 */
function sanitiseNotes(html) {
  const allowed = /^(p|br|ul|ol|li|b|strong|i|em|code|pre|h3|h4|hr)$/i;
  return String(html).replace(/<(\/?)([a-zA-Z0-9-]+)[^>]*>/g,
    (_m, slash, tag) => (allowed.test(tag) ? `<${slash}${tag.toLowerCase()}>` : ""));
}
