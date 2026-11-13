// Pure TypeScript Code128-B Encoder (SVG Data URI) & 1D Pixel Scanline Decoder
// Zero external dependencies; works 100% offline and inside sandboxed iframes.

const CODE128_PATTERNS: string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112",
];

const PATTERN_TO_VALUE: Map<string, number> = new Map(
  CODE128_PATTERNS.slice(0, 106).map((p, idx) => [p, idx])
);

const START_CODE_B = 104;
const STOP_CODE = 106;

export function encodeCode128SvgDataUrl(text: string): string {
  const clean = text.trim();
  const codes: number[] = [START_CODE_B];
  let checksum = START_CODE_B;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean.charCodeAt(i);
    const val = ch >= 32 && ch <= 126 ? ch - 32 : 0;
    codes.push(val);
    checksum += val * (i + 1);
  }

  codes.push(checksum % 103);
  codes.push(STOP_CODE);

  const quietZone = 10;
  let x = quietZone;
  const rects: string[] = [];

  for (const code of codes) {
    const pat = CODE128_PATTERNS[code];
    for (let i = 0; i < pat.length; i++) {
      const w = Number(pat[i]);
      if (i % 2 === 0) {
        rects.push(`<rect x="${x}" y="0" width="${w}" height="64" fill="#000000"/>`);
      }
      x += w;
    }
  }

  const totalWidth = x + quietZone;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} 64" width="${totalWidth * 2}" height="80" shape-rendering="crispEdges"><rect width="${totalWidth}" height="64" fill="#ffffff"/>${rects.join("")}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export interface DecodedBarcodeHit {
  text: string;
  format: string;
  bbox: [number, number, number, number]; // normalized 0..1
}

function tryDecodeRunLengths(
  runs: number[],
  runStartX: number[],
  imgWidth: number,
  yNorm: number
): DecodedBarcodeHit | null {
  // Need at least Start + 4 chars + Checksum + Stop => (6 * 6) + 7 = 43 bars/spaces
  if (runs.length < 43) return null;

  for (let s = 0; s <= runs.length - 43; s++) {
    // Start bar must be dark; in runs array, callers pass alternating runs. Check 6 runs for Start B (2,1,1,2,1,4 -> sum=11)
    const slice6 = runs.slice(s, s + 6);
    const total11 = slice6.reduce((a, b) => a + b, 0);
    if (total11 < 9) continue;
    const moduleW = total11 / 11;

    const q = slice6.map((r) => Math.max(1, Math.min(4, Math.round(r / moduleW))));
    if (q.reduce((a, b) => a + b, 0) !== 11) continue;
    const pat0 = q.join("");
    const startVal = PATTERN_TO_VALUE.get(pat0);
    if (startVal !== START_CODE_B && startVal !== 103 && startVal !== 105) continue;

    // Decode symbols until STOP_CODE
    const values: number[] = [startVal];
    let pos = s + 6;
    let foundStop = false;

    while (pos + 6 <= runs.length && values.length < 40) {
      // Check if next 7 runs match STOP pattern "2331112" (13 modules)
      if (pos + 7 <= runs.length) {
        const s7 = runs.slice(pos, pos + 7);
        const m7 = s7.reduce((a, b) => a + b, 0) / 13;
        if (Math.abs(m7 - moduleW) <= moduleW * 0.38) {
          const q7 = s7.map((r) => Math.max(1, Math.min(4, Math.round(r / m7))));
          if (q7.join("") === "2331112") {
            foundStop = true;
            pos += 7;
            break;
          }
        }
      }

      const s6 = runs.slice(pos, pos + 6);
      const sum6 = s6.reduce((a, b) => a + b, 0);
      const localMod = sum6 / 11;
      if (Math.abs(localMod - moduleW) > moduleW * 0.42) break;

      let q6 = s6.map((r) => Math.max(1, Math.min(4, Math.round(r / localMod))));
      // Small rounding repair if sum is 10 or 12
      const qSum = q6.reduce((a, b) => a + b, 0);
      if (qSum === 10 || qSum === 12) {
        let bestIdx = 0;
        let bestErr = -1;
        for (let k = 0; k < 6; k++) {
          const exact = s6[k] / localMod;
          const diff = qSum === 10 ? exact - q6[k] : q6[k] - exact;
          if (diff > bestErr && (qSum === 10 ? q6[k] < 4 : q6[k] > 1)) {
            bestErr = diff;
            bestIdx = k;
          }
        }
        q6 = [...q6];
        q6[bestIdx] += qSum === 10 ? 1 : -1;
      }

      const symVal = PATTERN_TO_VALUE.get(q6.join(""));
      if (symVal === undefined) break;
      values.push(symVal);
      pos += 6;
    }

    if (!foundStop || values.length < 3) continue;

    const expectedCheck = values[values.length - 1];
    let calcCheck = values[0];
    for (let i = 1; i < values.length - 1; i++) {
      calcCheck += values[i] * i;
    }
    if (calcCheck % 103 !== expectedCheck) continue;

    // Reconstruct string (Code128-B / C)
    let mode: "A" | "B" | "C" =
      startVal === 103 ? "A" : startVal === 105 ? "C" : "B";
    let decoded = "";
    for (let i = 1; i < values.length - 1; i++) {
      const v = values[i];
      if (mode === "B") {
        if (v === 99) mode = "C";
        else if (v === 101) mode = "A";
        else if (v >= 0 && v <= 95) decoded += String.fromCharCode(v + 32);
      } else if (mode === "C") {
        if (v === 100) mode = "B";
        else if (v === 101) mode = "A";
        else if (v >= 0 && v <= 99) decoded += String(v).padStart(2, "0");
      } else {
        if (v === 100) mode = "B";
        else if (v === 99) mode = "C";
        else if (v >= 0 && v <= 63) decoded += String.fromCharCode(v + 32);
      }
    }

    if (decoded.trim().length >= 4) {
      const x1 = Math.max(0, runStartX[s] / imgWidth);
      const endIdx = Math.min(runStartX.length - 1, pos);
      const x2 = Math.min(1, runStartX[endIdx] / imgWidth);
      return {
        text: decoded.trim(),
        format: "Code128",
        bbox: [x1, Math.max(0, yNorm - 0.06), x2, Math.min(1, yNorm + 0.06)],
      };
    }
  }

  return null;
}

export function decodeCode128FromImageData(
  imageData: ImageData
): DecodedBarcodeHit[] {
  const { data, width, height } = imageData;
  const found: Map<string, DecodedBarcodeHit> = new Map();

  // Sample 18 horizontal scanlines across the frame
  const numLines = 18;
  for (let lineIdx = 1; lineIdx <= numLines; lineIdx++) {
    const y = Math.floor((height * lineIdx) / (numLines + 1));
    const rowOffset = y * width * 4;

    // Extract grayscale row & local adaptive threshold
    const lum = new Uint8Array(width);
    let minL = 255;
    let maxL = 0;
    for (let x = 0; x < width; x++) {
      const p = rowOffset + x * 4;
      const g = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
      lum[x] = g;
      if (g < minL) minL = g;
      if (g > maxL) maxL = g;
    }
    if (maxL - minL < 45) continue;

    // Windowed local mean threshold (window = 32px)
    const win = 32;
    const isDark = new Uint8Array(width);
    let runningSum = 0;
    for (let x = 0; x < Math.min(width, win); x++) runningSum += lum[x];
    for (let x = 0; x < width; x++) {
      const right = x + (win >> 1);
      const left = x - (win >> 1) - 1;
      if (right < width && x >= win >> 1) runningSum += lum[right];
      if (left >= 0) runningSum -= lum[left];
      const count =
        Math.min(width - 1, x + (win >> 1)) - Math.max(0, x - (win >> 1)) + 1;
      const localMean = runningSum / count;
      isDark[x] = lum[x] < localMean - 6 ? 1 : 0;
    }

    // Build run-lengths starting ONLY on dark bars (so even indices = dark bars, odd = white spaces)
    const runs: number[] = [];
    const runStartX: number[] = [];
    let x = 0;
    while (x < width && isDark[x] === 0) x++;
    while (x < width) {
      const cur = isDark[x];
      const startX = x;
      while (x < width && isDark[x] === cur) x++;
      runs.push(x - startX);
      runStartX.push(startX);
    }
    runStartX.push(width);

    // Ensure we check only dark-starting indices (0, 2, 4, ...)
    for (let offset = 0; offset < runs.length - 43; offset += 2) {
      const hit = tryDecodeRunLengths(
        runs.slice(offset),
        runStartX.slice(offset),
        width,
        y / height
      );
      if (hit) {
        const prev = found.get(hit.text);
        if (!prev) {
          found.set(hit.text, hit);
        } else {
          prev.bbox = [
            Math.min(prev.bbox[0], hit.bbox[0]),
            Math.min(prev.bbox[1], hit.bbox[1]),
            Math.max(prev.bbox[2], hit.bbox[2]),
            Math.max(prev.bbox[3], hit.bbox[3]),
          ];
        }
        break;
      }
    }
  }

  return Array.from(found.values());
}
