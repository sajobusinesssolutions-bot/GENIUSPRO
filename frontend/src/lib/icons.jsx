// icons.jsx — line icons for row actions and page controls.
//
// Deliberately not a package. The frontend ships with react and react-dom and
// nothing else (blueprint §2), and pulling in an icon library to draw sixteen
// glyphs would trade that for a few hundred kilobytes. These are the standard
// Lucide shapes, drawn with the same 24×24 stroke geometry the app already
// uses for its nav icons, so everything matches.
//
// Replaces the emoji and dingbats (👁 🗑 ✎ ⎙ ➦ ⧉) that were serving as action
// icons. Those render differently on every platform, sit on a different visual
// baseline to the rest of the interface, and are the single clearest tell of
// an unfinished product.
import React from "react";

/* Pipe-separated subpaths, matching the existing IC/RIc convention. */
export const ICONS = {
  eye:      "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z|M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  eyeOff:   "M9.9 5.1A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1|M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4.2-.9|M3 3l18 18",
  trash:    "M3 6h18|M8 6V4h8v2|M6 6l1 14h10l1-14|M10 11v6|M14 11v6",
  edit:     "M12 20h9|M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
  print:    "M6 9V3h12v6|M6 18H4v-7h16v7h-2|M8 14h8v7H8z",
  check:    "M20 6 9 17l-5-5",
  play:     "M6 4l14 8-14 8z",
  pause:    "M9 4v16|M15 4v16",
  copy:     "M9 9h11v11H9z|M5 15H4V4h11v1",
  send:     "M22 2 11 13|M22 2l-7 20-4-9-9-4z",
  download: "M12 3v12|M7 11l5 5 5-5|M4 21h16",
  close:    "M18 6 6 18|M6 6l12 12",
  star:     "M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z",
  ban:      "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18|M5.6 5.6l12.8 12.8",
  undo:     "M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5",
  plus:     "M12 5v14|M5 12h14",
  chevron:  "M6 9l6 6 6-6",
  lock:     "M5 11h14v10H5z|M8 11V7a4 4 0 0 1 8 0v4",
  wand:     "M15 4V2|M15 16v-2|M8 9h2|M20 9h2|M17.8 11.8L19 13|M15 9h0|M17.8 6.2L19 5|M3 21l9-9|M12.2 6.2L11 5",
  barcode:  "M3 5v14|M6 5v14|M10 5v14|M14 5v9|M18 5v14|M21 5v14",
  box:      "M21 8l-9-5-9 5v8l9 5 9-5z|M3 8l9 5 9-5|M12 13v10",
  split:    "M3 4h6l4 8 4 8h4|M17 4h4l-4 4|M17 20h4l-4-4",
  list:     "M8 6h13|M8 12h13|M8 18h13|M3 6h.01|M3 12h.01|M3 18h.01",
  tag:      "M20.6 13.4L13 21l-9-9V4h8l8.6 8.6a2 2 0 0 1 0 2.8z|M7.5 7.5h.01",
  /* Cash and bank. Money.jsx drew both of these as inline <svg> because the
     set had none, which made its account tiles the one place in the app whose
     icons could drift from everything else's stroke weight. */
  wallet:   "M3 7h15a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H5a2 2 0 0 1-2-2z|M3 7V6a2 2 0 0 1 2-2h11|M17 13h1",
  bank:     "M3 10 12 4l9 6|M5 10v8|M10 10v8|M14 10v8|M19 10v8|M3 20h18",
  /* Mobile money. MTN and Airtel float is not a bank account and not the
     drawer — it is a real balance somebody reconciles, and it needed its own
     glyph so the Cash & bank tiles do not file it under a building. */
  mobile:   "M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z|M10 18h4",
  /* Expiry warnings needed a glyph and the set had none, so every notice that
     wanted one was going to reach for an emoji, which does not take the
     stroke weight or the theme colour the rest of the row is drawn in. */
  alert:    "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z|M12 9v4|M12 17h.01",
  clock:    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18|M12 7v5l3 2",
};

/**
 * Icon — one glyph by name.
 * `n` is a key of ICONS; unknown names render nothing rather than throwing,
 * so a typo in a row-action list cannot take a whole page down.
 */
export function Icon({ n, size = 16, strokeWidth = 1.8 }) {
  const d = ICONS[n];
  if (!d) return null;
  return (
    <svg className="ic" style={{ width: size, height: size }} viewBox="0 0 24 24"
         fill="none" stroke="currentColor" strokeWidth={strokeWidth}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.split("|").map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

export default Icon;
