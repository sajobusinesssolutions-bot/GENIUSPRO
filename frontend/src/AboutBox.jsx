// AboutBox.jsx — app identity, release notes and update guidance in one place.
//
// Modelled on the SACCO Manager dialog: icon, name, version, three tabs, then
// a developer block. Everything here reads backend/version.json through
// /system/version, so the box cannot disagree with what is actually running —
// which it previously could, four different ways.
import React, { useEffect, useState } from "react";
import api from "./lib/api.js";
import { Modal, toast, confirmDialog } from "./lib/ui.jsx";
import { Icon } from "./lib/icons.jsx";

const TABS = [
  ["about", "About"],
  ["news", "What's New"],
  ["update", "Software Update"],
];

export default function AboutBox({ onClose }) {
  const [tab, setTab] = useState("about");
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(false);

  const reload = React.useCallback(() => {
    api.get("/system/version").then(setInfo).catch(() => setFailed(true));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const version = info?.version;

  return (
    <Modal title="" onClose={onClose} wide>
      <div className="about-head">
        <span className="about-mark" aria-hidden>SB</span>
        <div className="about-id">
          <h2>Genius POS</h2>
          <div className="about-ver">
            {failed ? "Version unavailable" : version ? `Version ${version}` : "Checking…"}
            {info?.released && <span className="about-date"> · {info.released}</span>}
          </div>
        </div>
      </div>

      <div className="about-tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id}
                  className={`about-tab ${tab === id ? "on" : ""}`}
                  onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "about" && (
        <div className="about-body">
          <p>
            A complete billing, stock and accounting system for Ugandan business —
            covering the till, invoicing, customers, suppliers, stock, money in and
            out, and reporting.
          </p>
          <div className="about-dev">
            <div className="ad-label">Developed by</div>
            <div className="ad-name">SALJO TECH</div>
            <div className="ad-sub">Software &amp; Business Solutions · Est. 2025</div>
            <div className="ad-row">+256 789 069 675</div>
            <div className="ad-row">sajobusinesssolutions@gmail.com</div>
          </div>
          <div className="about-copy">© 2026 SALJO TECH. All rights reserved.</div>
        </div>
      )}

      {tab === "news" && (
        <div className="about-body">
          {failed && <p className="about-muted">Could not reach the server for release notes.</p>}
          {!failed && !info && <p className="about-muted">Loading…</p>}
          {info && info.notes.length === 0 && (
            <p className="about-muted">No notes recorded for this release.</p>
          )}
          {info && info.notes.length > 0 && (
            <>
              <div className="about-relhead">What changed in {version}</div>
              <ul className="about-notes">
                {info.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </>
          )}
        </div>
      )}

      {tab === "update" && <UpdatePane version={version} onApplied={reload} />}

      <div className="modal-foot">
        <button className="btn btn-primary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}


/**
 * UpdatePane — choose a release zip and apply it.
 *
 * The backend updater already existed (POST /system/update, with per-file
 * backup, history and rollback); nothing in the interface reached it, so the
 * only route was copying folders by hand. This exposes it.
 *
 * The endpoint takes the raw zip as the request body, so this bypasses the
 * shared api helper — that one JSON-encodes everything it is given.
 */
function UpdatePane({ version, onApplied }) {
  const [file, setFile] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [history, setHistory] = React.useState([]);
  const [drag, setDrag] = React.useState(false);
  const input = React.useRef(null);

  const loadHistory = React.useCallback(() => {
    api.get("/system/updates").then((r) => setHistory(r.rows || r || [])).catch(() => setHistory([]));
  }, []);
  React.useEffect(() => { loadHistory(); }, [loadHistory]);

  const pick = (f) => {
    if (!f) return;
    if (!/\.zip$/i.test(f.name)) return toast("Choose a .zip release file", "bad");
    setFile(f); setResult(null);
  };

  const apply = async () => {
    if (!file) return;
    if (!(await confirmDialog({
      title: `Apply ${file.name}?`,
      message: `This replaces program files in place. You are on ${version || "an unknown version"}.`,
      detail: "Every file it overwrites is backed up first, so the update can be rolled back. Your business data is not touched. Everyone else should be off the app while this runs.",
      confirmLabel: "Apply update",
    }))) return;

    setBusy(true);
    try {
      const token = localStorage.getItem("vy_token");
      const res = await fetch(`/api/system/update?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: file,
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message || "Update failed");
      setResult(json.data);
      toast(json.message || "Updated", "ok");
      loadHistory();
      onApplied?.();
    } catch (e) {
      toast(e.message, "bad");
      setResult(null);
      loadHistory();
    } finally { setBusy(false); }
  };

  const rollback = async (row) => {
    if (!(await confirmDialog({
      title: `Roll back to ${row.version_from}?`,
      message: "This restores the files that were replaced by that update.",
      detail: "Business data is unaffected. Restart the app afterwards.",
      danger: true, confirmLabel: "Roll back",
    }))) return;
    try {
      const r = await api.post(`/system/updates/${row.id}/rollback`, {});
      toast(r?.message || "Rolled back", "ok");
      loadHistory(); onApplied?.();
    } catch (e) { toast(e.message, "bad"); }
  };

  return (
    <div className="about-body">
      <p className="about-muted">
        Running <b>{version || "unknown"}</b>. Drop the update zip from SALJO TECH
        below — the smaller <i>update</i> zip is enough; the full setup
        zip only matters for a fresh install.
      </p>

      <div
        className={`upd-drop ${drag ? "on" : ""} ${file ? "has" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}
        onClick={() => input.current?.click()}
      >
        <input ref={input} type="file" accept=".zip,application/zip" hidden
               onChange={(e) => pick(e.target.files?.[0])} />
        {file ? (
          <>
            <div className="ud-name">{file.name}</div>
            <div className="ud-sub">{(file.size / 1048576).toFixed(1)} MB — ready to apply</div>
          </>
        ) : (
          <>
            <div className="ud-name">Choose or drop an update .zip</div>
            <div className="ud-sub">Nothing is changed until you press Apply</div>
          </>
        )}
      </div>

      <div className="upd-actions">
        {file && !busy && (
          <button className="btn btn-ghost" onClick={() => { setFile(null); setResult(null); }}>Clear</button>
        )}
        <button className="btn btn-primary" onClick={apply} disabled={!file || busy}>
          {busy ? "Applying…" : "Apply update"}
        </button>
      </div>

      {result && (
        <div className="upd-done">
          <b>Updated {result.version_from} → {result.version_to}</b>
          <div>{result.files} file(s) replaced.</div>
          <div className="about-muted">{result.note}</div>
        </div>
      )}

      <div className="upd-warn">
        Take a backup first — Settings → Backup &amp; restore — and make sure
        nobody else is using the app while an update runs.
      </div>

      {history.length > 0 && (
        <>
          <div className="about-relhead" style={{ marginTop: 18 }}>Update history</div>
          <table className="tw upd-hist">
            <thead><tr><th>When</th><th>Change</th><th>Result</th><th /></tr></thead>
            <tbody>
              {history.slice(0, 8).map((h) => (
                <tr key={h.id}>
                  <td>{(h.created_at || "").slice(0, 16).replace("T", " ")}</td>
                  <td>{h.version_from} → {h.version_to || "—"}</td>
                  <td className={h.status === "applied" ? "ok" : "bad"}>{h.status}</td>
                  <td>
                    {h.status === "applied" && h.backup_dir && (
                      <button className="btn btn-ghost btn-sm" onClick={() => rollback(h)}>Roll back</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
