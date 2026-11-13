import Tesseract from "tesseract.js";
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from "@zxing/library";
import {
  AnalyzeFrameResponse,
  FrameDetection,
  OcrOverlayRegion,
} from "../types";
import { decodeCode128FromImageData } from "./code128Codec";
import {
  DEFAULT_CUSTOMERS_LIST,
  extractCustomerFromOcrLines,
  matchKnownCustomerClient,
  OcrLineItem,
  ParsedTrackingCode,
  parseTrackingTokensClient,
} from "./labelParser";

declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats: string[] }) => {
      detect: (
        image: ImageBitmapSource
      ) => Promise<
        Array<{
          rawValue: string;
          format: string;
          boundingBox: DOMRectReadOnly;
        }>
      >;
    };
  }
}

export type LocalEngineStatus = "idle" | "loading" | "ready" | "error";

let ocrWorkerPromise: Promise<Tesseract.Worker | null> | null = null;
let ocrStatus: LocalEngineStatus = "idle";
const statusListeners = new Set<(st: LocalEngineStatus) => void>();

function notifyStatus(st: LocalEngineStatus) {
  ocrStatus = st;
  for (const fn of statusListeners) {
    try {
      fn(st);
    } catch {
      // ignore listener error
    }
  }
}

export function getLocalOcrStatus(): LocalEngineStatus {
  return ocrStatus;
}

export function subscribeLocalOcrStatus(
  fn: (st: LocalEngineStatus) => void
): () => void {
  statusListeners.add(fn);
  fn(ocrStatus);
  return () => {
    statusListeners.delete(fn);
  };
}

let cachedDetector: InstanceType<NonNullable<typeof window.BarcodeDetector>> | null =
  null;
let detectorChecked = false;

function getNativeBarcodeDetector() {
  if (detectorChecked) return cachedDetector;
  detectorChecked = true;
  if (typeof window !== "undefined" && "BarcodeDetector" in window && window.BarcodeDetector) {
    try {
      cachedDetector = new window.BarcodeDetector({
        formats: [
          "code_128",
          "code_39",
          "code_93",
          "qr_code",
          "data_matrix",
          "itf",
          "ean_13",
        ],
      });
    } catch {
      cachedDetector = null;
    }
  }
  return cachedDetector;
}

let zxingReader: MultiFormatReader | null = null;
function getZxingReader(): MultiFormatReader {
  if (!zxingReader) {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.CODE_93,
      BarcodeFormat.ITF,
      BarcodeFormat.EAN_13,
      BarcodeFormat.QR_CODE,
      BarcodeFormat.DATA_MATRIX,
      BarcodeFormat.PDF_417,
    ]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    zxingReader = new MultiFormatReader();
    zxingReader.setHints(hints);
  }
  return zxingReader;
}

export function warmupLocalScanner(): Promise<Tesseract.Worker | null> {
  if (ocrWorkerPromise) return ocrWorkerPromise;
  notifyStatus("loading");

  ocrWorkerPromise = (async () => {
    // 1. Prefer same-origin ./ocr/* assets (fast, offline-capable, works on GitHub Pages /Scan3/)
    if (
      typeof window !== "undefined" &&
      (window.location.protocol === "http:" || window.location.protocol === "https:") &&
      window.location.origin !== "null"
    ) {
      try {
        const ocrDir = new URL("./ocr", window.location.href).href.replace(/\/$/, "");
        const worker = await Tesseract.createWorker("eng", 1, {
          workerPath: `${ocrDir}/worker.min.js`,
          corePath: ocrDir,
          langPath: ocrDir,
          gzip: false,
        });
        await worker.setParameters({
          tessedit_pageseg_mode: "11" as unknown as Tesseract.PSM,
          preserve_interword_spaces: "1",
        });
        notifyStatus("ready");
        return worker;
      } catch (err) {
        console.warn("Local ./ocr worker fallback to CDN:", err);
      }
    }

    // 2. Fallback to default Tesseract CDN (e.g. standalone HTML file://)
    try {
      const worker = await Tesseract.createWorker("eng", 1);
      await worker.setParameters({
        tessedit_pageseg_mode: "11" as unknown as Tesseract.PSM,
        preserve_interword_spaces: "1",
      });
      notifyStatus("ready");
      return worker;
    } catch (err) {
      console.error("Failed to initialize Tesseract worker:", err);
      notifyStatus("error");
      ocrWorkerPromise = null;
      return null;
    }
  })();

  return ocrWorkerPromise;
}

function computeSceneSignatureAndSharpness(canvas: HTMLCanvasElement): {
  signature: number[];
  sharpness: number;
} {
  const small = document.createElement("canvas");
  small.width = 48;
  small.height = 48;
  const ctx = small.getContext("2d");
  if (!ctx) return { signature: new Array(64).fill(128), sharpness: 120 };
  ctx.drawImage(canvas, 0, 0, 48, 48);
  const data = ctx.getImageData(0, 0, 48, 48).data;

  const gray = new Float32Array(48 * 48);
  for (let i = 0; i < 48 * 48; i++) {
    gray[i] =
      0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  const sig: number[] = [];
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      let sum = 0;
      for (let y = by * 6; y < (by + 1) * 6; y++) {
        for (let x = bx * 6; x < (bx + 1) * 6; x++) {
          sum += gray[y * 48 + x];
        }
      }
      sig.push(Math.round((sum / 36) * 10) / 10);
    }
  }

  let lapSum = 0;
  let lapSq = 0;
  let n = 0;
  for (let y = 1; y < 47; y++) {
    for (let x = 1; x < 47; x++) {
      const idx = y * 48 + x;
      const lap =
        gray[idx - 48] +
        gray[idx + 48] +
        gray[idx - 1] +
        gray[idx + 1] -
        4 * gray[idx];
      lapSum += lap;
      lapSq += lap * lap;
      n++;
    }
  }
  const mean = lapSum / n;
  const variance = Math.max(0, lapSq / n - mean * mean);
  return { signature: sig, sharpness: Math.round(variance * 10) / 10 };
}

function cropThumbnail(
  canvas: HTMLCanvasElement,
  bbox: [number, number, number, number]
): string {
  const w = canvas.width;
  const h = canvas.height;
  const padX = Math.max(0.06, (bbox[2] - bbox[0]) * 0.28);
  const padY = Math.max(0.09, (bbox[3] - bbox[1]) * 0.55);
  const x1 = Math.max(0, Math.floor((bbox[0] - padX) * w));
  const y1 = Math.max(0, Math.floor((bbox[1] - padY) * h));
  const x2 = Math.min(w, Math.ceil((bbox[2] + padX) * w));
  const y2 = Math.min(h, Math.ceil((bbox[3] + padY) * h));
  const cw = Math.max(32, x2 - x1);
  const ch = Math.max(24, y2 - y1);

  const out = document.createElement("canvas");
  const scale = cw > 260 ? 260 / cw : 1;
  out.width = Math.max(1, Math.round(cw * scale));
  out.height = Math.max(1, Math.round(ch * scale));
  const octx = out.getContext("2d");
  if (!octx) return "";
  octx.drawImage(canvas, x1, y1, cw, ch, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.76);
}

interface PreparedCrop {
  ocrCanvas: HTMLCanvasElement;
  borderPx: number;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  scale: number;
}

/**
 * Extracts a crisp region of interest, upscales small mobile crops, applies
 * 3%-96% histogram contrast stretching + mild unsharp mask + 14px white border
 * so Tesseract LSTM reads phone-filmed labels like `del0615244` cleanly.
 */
function buildEnhancedOcrCrop(
  src: HTMLCanvasElement,
  normBox: [number, number, number, number]
): PreparedCrop {
  const sw = src.width;
  const sh = src.height;
  const cropX = Math.max(0, Math.floor(normBox[0] * sw));
  const cropY = Math.max(0, Math.floor(normBox[1] * sh));
  const cropW = Math.max(48, Math.min(sw - cropX, Math.ceil((normBox[2] - normBox[0]) * sw)));
  const cropH = Math.max(36, Math.min(sh - cropY, Math.ceil((normBox[3] - normBox[1]) * sh)));

  // Target width around 760px for crisp character strokes without WASM lag
  let scale = 1.0;
  if (cropW < 520) {
    scale = Math.min(2.0, 680 / cropW);
  } else if (cropW > 900) {
    scale = 900 / cropW;
  }

  const innerW = Math.max(48, Math.round(cropW * scale));
  const innerH = Math.max(36, Math.round(cropH * scale));
  const borderPx = 14;

  const out = document.createElement("canvas");
  out.width = innerW + borderPx * 2;
  out.height = innerH + borderPx * 2;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return { ocrCanvas: src, borderPx: 0, cropX: 0, cropY: 0, cropW: sw, cropH: sh, scale: 1 };
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, cropX, cropY, cropW, cropH, borderPx, borderPx, innerW, innerH);

  // Contrast stretch + grayscale normalization inside inner region
  const imgData = ctx.getImageData(borderPx, borderPx, innerW, innerH);
  const px = imgData.data;
  const n = innerW * innerH;
  const gray = new Uint8Array(n);
  const hist = new Uint32Array(256);

  for (let i = 0; i < n; i++) {
    const g = Math.round(
      0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]
    );
    gray[i] = g;
    hist[g]++;
  }

  const lowTarget = Math.floor(n * 0.025);
  const highTarget = Math.floor(n * 0.94);
  let acc = 0;
  let pLow = 0;
  let pHigh = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc <= lowTarget) pLow = v;
    if (acc <= highTarget) pHigh = v;
  }

  const span = Math.max(28, pHigh - pLow);
  const stretched = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let norm = ((gray[i] - pLow) * 255) / span;
    if (norm < 0) norm = 0;
    else if (norm > 255) norm = 255;
    stretched[i] = norm;
  }

  // Mild 3x3 sharpening to crisp up phone motion / slightly soft autofocus
  for (let y = 0; y < innerH; y++) {
    for (let x = 0; x < innerW; x++) {
      const idx = y * innerW + x;
      let val = stretched[idx];
      if (y > 0 && y < innerH - 1 && x > 0 && x < innerW - 1) {
        const blur =
          (stretched[idx - innerW] +
            stretched[idx + innerW] +
            stretched[idx - 1] +
            stretched[idx + 1]) *
          0.25;
        val = Math.max(0, Math.min(255, Math.round(val + (val - blur) * 0.65)));
      }
      const p = idx * 4;
      px[p] = val;
      px[p + 1] = val;
      px[p + 2] = val;
      px[p + 3] = 255;
    }
  }

  ctx.putImageData(imgData, borderPx, borderPx);
  return { ocrCanvas: out, borderPx, cropX, cropY, cropW, cropH, scale };
}

function decodeZxingFromCanvas(
  canvas: HTMLCanvasElement
): Array<{ rawValue: string; bbox: [number, number, number, number] }> {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || canvas.width < 16 || canvas.height < 16) return [];

  try {
    const reader = getZxingReader();
    const w = canvas.width;
    const h = canvas.height;
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const luminances = new Uint8ClampedArray(w * h);
    for (let i = 0; i < w * h; i++) {
      luminances[i] =
        (rgba[i * 4] * 306 + rgba[i * 4 + 1] * 601 + rgba[i * 4 + 2] * 117) >> 10;
    }
    const source = new RGBLuminanceSource(luminances, w, h);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    const res = reader.decode(bitmap);
    const txt = res?.getText()?.trim();
    if (!txt) return [];

    const pts = res.getResultPoints() || [];
    let x1 = 0.15;
    let y1 = 0.25;
    let x2 = 0.85;
    let y2 = 0.75;
    if (pts.length >= 2) {
      const xs = pts.map((p) => p.getX() / w);
      const ys = pts.map((p) => p.getY() / h);
      x1 = Math.max(0, Math.min(...xs) - 0.03);
      x2 = Math.min(1, Math.max(...xs) + 0.03);
      y1 = Math.max(0, Math.min(...ys) - 0.06);
      y2 = Math.min(1, Math.max(...ys) + 0.06);
    }
    return [{ rawValue: txt, bbox: [x1, y1, x2, y2] }];
  } catch {
    // NotFoundException when frame has no barcode
    return [];
  }
}

let frameToggle = 0;

export async function analyzeFrameLocally(
  canvas: HTMLCanvasElement,
  customCustomers: string[] = [],
  focusBox?: [number, number, number, number]
): Promise<AnalyzeFrameResponse> {
  const { signature, sharpness } = computeSceneSignatureAndSharpness(canvas);
  const w = Math.max(1, canvas.width);
  const h = Math.max(1, canvas.height);

  const knownCustomers = Array.from(
    new Set([...DEFAULT_CUSTOMERS_LIST, ...customCustomers.filter(Boolean)])
  );

  const rawBarcodeHits = new Map<
    string,
    { bbox: [number, number, number, number]; source: string }
  >();

  // 1. Native BarcodeDetector (Android Chrome / Desktop Chrome / Edge)
  const detector = getNativeBarcodeDetector();
  if (detector) {
    try {
      const hits = await detector.detect(canvas);
      for (const hit of hits) {
        if (!hit.rawValue) continue;
        const bb = hit.boundingBox;
        rawBarcodeHits.set(hit.rawValue.trim(), {
          bbox: [
            Math.max(0, bb.x / w),
            Math.max(0, bb.y / h),
            Math.min(1, (bb.x + bb.width) / w),
            Math.min(1, (bb.y + bb.height) / h),
          ],
          source: "barcode",
        });
      }
    } catch {
      // ignore
    }
  }

  // 2. ZXing MultiFormatReader (Works on iOS Safari + Android + QR + Code128 + Code39)
  for (const zhit of decodeZxingFromCanvas(canvas)) {
    if (!rawBarcodeHits.has(zhit.rawValue)) {
      rawBarcodeHits.set(zhit.rawValue, { bbox: zhit.bbox, source: "barcode" });
    }
  }

  // 3. Fast Code128 scanline sweeps (extra sensitivity for synthetic/clean Code128)
  if (rawBarcodeHits.size === 0) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      const imgData = ctx.getImageData(0, 0, w, h);
      for (const sh of decodeCode128FromImageData(imgData)) {
        if (!rawBarcodeHits.has(sh.text)) {
          rawBarcodeHits.set(sh.text, { bbox: sh.bbox, source: "barcode" });
        }
      }
    }
  }

  // 4. Tesseract.js LSTM OCR (essential for printed labels like `del0615244` + customer names!)
  const ocrLines: OcrLineItem[] = [];
  const rawPreviewTokens: string[] = [];
  const worker = await warmupLocalScanner();

  if (worker) {
    frameToggle = (frameToggle + 1) % 3;
    // Choose focus crop first (especially sharp on mobile cameras); every 3rd frame also check full frame if needed
    const primaryNormBox: [number, number, number, number] =
      focusBox ||
      (h > w * 1.15 ? [0.04, 0.18, 0.96, 0.82] : [0.02, 0.05, 0.98, 0.95]);

    const runOcrPass = async (normBox: [number, number, number, number]) => {
      const prep = buildEnhancedOcrCrop(canvas, normBox);
      // Also try ZXing on the contrast-enhanced crop if no barcode found yet!
      if (rawBarcodeHits.size === 0) {
        for (const zc of decodeZxingFromCanvas(prep.ocrCanvas)) {
          const bx1 =
            (prep.cropX +
              ((zc.bbox[0] * prep.ocrCanvas.width - prep.borderPx) / prep.scale)) /
            w;
          const by1 =
            (prep.cropY +
              ((zc.bbox[1] * prep.ocrCanvas.height - prep.borderPx) / prep.scale)) /
            h;
          const bx2 =
            (prep.cropX +
              ((zc.bbox[2] * prep.ocrCanvas.width - prep.borderPx) / prep.scale)) /
            w;
          const by2 =
            (prep.cropY +
              ((zc.bbox[3] * prep.ocrCanvas.height - prep.borderPx) / prep.scale)) /
            h;
          rawBarcodeHits.set(zc.rawValue, {
            bbox: [
              Math.max(0, Math.min(1, bx1)),
              Math.max(0, Math.min(1, by1)),
              Math.max(0, Math.min(1, bx2)),
              Math.max(0, Math.min(1, by2)),
            ],
            source: "barcode",
          });
        }
      }

      const ret = await worker.recognize(
        prep.ocrCanvas,
        {},
        { blocks: true, text: true }
      );

      const mapBbox = (b: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
      }): [number, number, number, number] => {
        const x1 = (prep.cropX + (b.x0 - prep.borderPx) / prep.scale) / w;
        const y1 = (prep.cropY + (b.y0 - prep.borderPx) / prep.scale) / h;
        const x2 = (prep.cropX + (b.x1 - prep.borderPx) / prep.scale) / w;
        const y2 = (prep.cropY + (b.y1 - prep.borderPx) / prep.scale) / h;
        return [
          Math.max(0, Math.min(1, Math.round(x1 * 1000) / 1000)),
          Math.max(0, Math.min(1, Math.round(y1 * 1000) / 1000)),
          Math.max(0, Math.min(1, Math.round(x2 * 1000) / 1000)),
          Math.max(0, Math.min(1, Math.round(y2 * 1000) / 1000)),
        ];
      };

      const passLines: OcrLineItem[] = [];
      for (const block of ret.data.blocks || []) {
        for (const para of block.paragraphs || []) {
          for (const line of para.lines || []) {
            const ltxt = (line.text || "").trim();
            if (!ltxt) continue;
            const conf01 = Math.max(0, Math.min(1, (line.confidence ?? 70) / 100));
            const mapped = mapBbox(line.bbox);
            passLines.push({ text: ltxt, confidence: conf01, bbox: mapped });
            if (conf01 >= 0.35 && ltxt.length >= 2) {
              rawPreviewTokens.push(ltxt);
            }

            // Also inspect individual words in case noise surrounded `del0615244` on the same line
            for (const word of line.words || []) {
              const wtxt = (word.text || "").trim();
              if (wtxt && wtxt !== ltxt && wtxt.length >= 4) {
                const wconf = Math.max(0, Math.min(1, (word.confidence ?? 68) / 100));
                passLines.push({
                  text: wtxt,
                  confidence: wconf,
                  bbox: mapBbox(word.bbox),
                });
              }
            }
          }
        }
      }

      // Fallback if blocks were empty but full text had lines
      if (passLines.length === 0 && ret.data.text) {
        for (const rawLine of ret.data.text.split(/\r?\n/)) {
          const t = rawLine.trim();
          if (t.length >= 3) {
            passLines.push({
              text: t,
              confidence: Math.max(0.6, (ret.data.confidence ?? 70) / 100),
              bbox: normBox,
            });
            rawPreviewTokens.push(t);
          }
        }
      }

      return passLines;
    };

    try {
      const firstLines = await runOcrPass(primaryNormBox);
      ocrLines.push(...firstLines);

      const foundInFirst = firstLines.some(
        (l) => parseTrackingTokensClient(l.text).length > 0
      );
      const isCroppedBox =
        primaryNormBox[0] > 0.05 ||
        primaryNormBox[1] > 0.08 ||
        primaryNormBox[2] < 0.95 ||
        primaryNormBox[3] < 0.92;

      // Every 3rd frame, if focus box had no tracking code, also sweep full frame (catches off-center labels & multi-box videos)
      if (!foundInFirst && rawBarcodeHits.size === 0 && isCroppedBox && frameToggle === 0) {
        const wideLines = await runOcrPass([0.01, 0.02, 0.99, 0.98]);
        ocrLines.push(...wideLines);
      }
    } catch (err) {
      console.warn("OCR frame pass warning:", err);
    }
  }

  // Horizontal stitching for split words on the same line (e.g. "del" + "0615244")
  const stitchedLines: OcrLineItem[] = [...ocrLines];
  for (let i = 0; i < ocrLines.length; i++) {
    const a = ocrLines[i];
    if (!/^(?:DEL|DLV|REM|RMV|RET|DELIVERY|REMOVAL)[:\-#]?$/i.test(a.text.trim())) {
      continue;
    }
    const ay = (a.bbox[1] + a.bbox[3]) / 2;
    const ah = Math.max(0.02, a.bbox[3] - a.bbox[1]);
    for (let j = 0; j < ocrLines.length; j++) {
      if (i === j) continue;
      const b = ocrLines[j];
      const by = (b.bbox[1] + b.bbox[3]) / 2;
      if (Math.abs(ay - by) < ah * 0.9 && b.bbox[0] >= a.bbox[0] - 0.02 && b.bbox[0] - a.bbox[2] < 0.16) {
        stitchedLines.push({
          text: `${a.text} ${b.text}`,
          confidence: Math.min(a.confidence, b.confidence),
          bbox: [
            Math.min(a.bbox[0], b.bbox[0]),
            Math.min(a.bbox[1], b.bbox[1]),
            Math.max(a.bbox[2], b.bbox[2]),
            Math.max(a.bbox[3], b.bbox[3]),
          ],
        });
      }
    }
  }

  // 5. Merge Barcodes + OCR tracking codes into structured FrameDetection items
  const candidates = new Map<
    string,
    {
      parsed: ParsedTrackingCode;
      confidence: number;
      source: string;
      bbox: [number, number, number, number];
      edgeClipped: boolean;
      customerHint: string;
    }
  >();

  for (const [rawVal, meta] of rawBarcodeHits.entries()) {
    const parsedCodes = parseTrackingTokensClient(rawVal);
    // Also check if QR/Barcode contains customer + code e.g. "Microsoft|DEL0615244"
    let embeddedCust = "";
    for (const part of rawVal.split(/[|;,\n\t/]+/)) {
      const m = matchKnownCustomerClient(part, knownCustomers);
      if (m) {
        embeddedCust = m;
        break;
      }
    }

    for (const pc of parsedCodes) {
      candidates.set(pc.canonicalId, {
        parsed: pc,
        confidence: 0.99,
        source: meta.source,
        bbox: meta.bbox,
        edgeClipped: false,
        customerHint: embeddedCust,
      });
    }
  }

  for (const line of stitchedLines) {
    if (line.confidence < 0.34) continue;
    const parsedCodes = parseTrackingTokensClient(line.text);
    if (parsedCodes.length === 0) continue;

    const edgeClipped = line.bbox[0] <= 0.012 || line.bbox[2] >= 0.988;

    for (const pc of parsedCodes) {
      const existing = candidates.get(pc.canonicalId);
      if (existing) {
        if (existing.source === "barcode") {
          existing.source = "barcode+ocr";
          existing.confidence = 0.995;
          existing.bbox = [
            Math.min(existing.bbox[0], line.bbox[0]),
            Math.min(existing.bbox[1], line.bbox[1]),
            Math.max(existing.bbox[2], line.bbox[2]),
            Math.max(existing.bbox[3], line.bbox[3]),
          ];
        } else if (line.confidence > existing.confidence) {
          existing.confidence = line.confidence;
          existing.bbox = line.bbox;
          existing.edgeClipped = existing.edgeClipped && edgeClipped;
        }
      } else {
        // Boost confidence slightly when clean 6-14 digit DEL/REM pattern matches in Tesseract
        const boostedConf = Math.min(
          0.98,
          Math.max(line.confidence, pc.digits.length >= 6 ? 0.82 : line.confidence)
        );
        candidates.set(pc.canonicalId, {
          parsed: pc,
          confidence: boostedConf,
          source: "ocr",
          bbox: line.bbox,
          edgeClipped,
          customerHint: "",
        });
      }
    }
  }

  const detections: FrameDetection[] = [];
  for (const item of candidates.values()) {
    const custInfo = item.customerHint
      ? {
          customer: item.customerHint,
          confidence: 0.98,
          source: "barcode_payload",
        }
      : extractCustomerFromOcrLines(
          item.bbox,
          ocrLines,
          knownCustomers,
          item.parsed.canonicalId
        );

    detections.push({
      canonical_id: item.parsed.canonicalId,
      display_title: item.parsed.displayTitle,
      display_upper: item.parsed.displayUpper,
      category: item.parsed.category,
      customer: custInfo.customer,
      customer_confidence: Math.round(custInfo.confidence * 1000) / 1000,
      customer_source: custInfo.source,
      confidence: Math.round(item.confidence * 1000) / 1000,
      source: item.source,
      edge_clipped: item.edgeClipped,
      bbox: item.bbox,
      thumbnail: cropThumbnail(canvas, item.bbox),
    });
  }

  detections.sort((a, b) => b.confidence - a.confidence);

  const ocrRegions: OcrOverlayRegion[] = ocrLines.slice(0, 18).map((l) => ({
    text: l.text,
    confidence: Math.round(l.confidence * 100) / 100,
    bbox: l.bbox,
  }));

  const uniquePreview = Array.from(new Set(rawPreviewTokens))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 2)
    .slice(0, 4)
    .join(" · ");

  const barcodePreview = Array.from(rawBarcodeHits.keys()).slice(0, 2).join(" · ");
  const raw_text_preview = [barcodePreview, uniquePreview].filter(Boolean).join(" | ");

  return {
    sharpness,
    scene_signature: signature,
    detections,
    ocr_regions: ocrRegions,
    raw_text_preview,
    engine_label: worker ? "Mobil OCR + Streckkod" : "Streckkod",
  };
}
