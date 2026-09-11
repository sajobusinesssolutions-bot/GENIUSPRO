// barcode.js — Code 128B encoder producing an SVG string. No dependencies.
const PATTERNS = ["212222","222122","222221","121223","121322","131222","122213","122312","132212","221213","221312","231212","112232","122132","122231","113222","123122","123221","223211","221132","221231","213212","223112","312131","311222","321122","321221","312212","322112","322211","212123","212321","232121","111323","131123","131321","112313","132113","132311","211313","231113","231311","112133","112331","132131","113123","113321","133121","313121","211331","231131","213113","213311","213131","311123","311321","331121","312113","312311","332111","314111","221411","431111","111224","111422","121124","121421","141122","141221","112214","112412","122114","122411","142112","142211","241211","221114","413111","241112","134111","111242","121142","121241","114212","124112","124211","411212","421112","421211","212141","214121","412121","111143","111341","131141","114113","114311","411113","411311","113141","114131","311141","411131","211412","211214","211232","2331112"];
const START_B = 104, STOP = 106;

export function code128Svg(text, { height = 60, scale = 2, label = true } = {}) {
  const codes = [START_B];
  for (const ch of String(text)) {
    const c = ch.charCodeAt(0) - 32;
    if (c < 0 || c > 94) continue; // printable ASCII only
    codes.push(c);
  }
  let checksum = codes[0];
  for (let i = 1; i < codes.length; i++) checksum += codes[i] * i;
  codes.push(checksum % 103, STOP);

  let x = 10, bars = "";
  for (const code of codes) {
    const pat = PATTERNS[code];
    for (let i = 0; i < pat.length; i++) {
      const w = Number(pat[i]) * scale;
      if (i % 2 === 0) bars += `<rect x="${x}" y="0" width="${w}" height="${height}" fill="#000"/>`;
      x += w;
    }
  }
  const width = x + 10;
  const text_el = label ? `<text x="${width / 2}" y="${height + 14}" font-family="monospace" font-size="12" text-anchor="middle">${String(text)}</text>` : "";
  /* max-width / height:auto so the barcode scales down to whatever it is printed
     on. The width attribute stays the natural size and the viewBox lets the
     glyph scale with it. Without the cap the SVG kept its intrinsic pixel width
     and ran off the edge of a narrow thermal roll — measured at 454px of barcode
     on a 384px (2in) roll, so the tail of the invoice number was cut off and the
     code would not scan. This only ever shrinks, so full-size label printing on
     the Items barcode sheet is unaffected. */
  const h = height + (label ? 20 : 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" style="background:#fff;max-width:100%;height:auto">${bars}${text_el}</svg>`;
}
