import { AnalyzeFrameResponse, FrameDetection, PackageCategory } from "../types";
import { decodeCode128FromImageData } from "./code128Codec";
import { ProjectedDemoLabel } from "./demoWarehouseRenderer";

export const DEFAULT_CUSTOMERS_LIST: string[] = [
  "Microsoft",
  "Google",
  "AWS",
  "Amazon",
  "Meta",
  "Apple",
  "Oracle",
  "IBM",
  "Cisco",
  "Dell",
  "HPE",
  "HP",
  "Lenovo",
  "Nvidia",
  "Equinix",
  "Digital Realty",
  "Ericsson",
  "Telia",
  "Tele2",
  "Telenor",
  "Volvo",
  "Scania",
  "ABB",
  "AstraZeneca",
  "Spotify",
  "Klarna",
  "Vattenfall",
  "IKEA",
  "H&M",
  "SAAB",
  "SKF",
  "Sandvik",
  "Atlas Copco",
  "SEB",
  "Nordea",
  "Swedbank",
  "Handelsbanken",
  "Northvolt",
  "Polestar",
  "Securitas",
  "Alfa Laval",
  "Assa Abloy",
  "Electrolux",
  "Essity",
  "Hexagon",
  "Husqvarna",
];

interface BrowserBarcodeResult {
  rawValue: string;
  format?: string;
  boundingBox?: DOMRectReadOnly;
}

interface BrowserBarcodeDetector {
  detect(source: ImageBitmapSource): Promise<BrowserBarcodeResult[]>;
}

let cachedDetector: BrowserBarcodeDetector | null | undefined;

function getNativeBarcodeDetector(): BrowserBarcodeDetector | null {
  if (cachedDetector !== undefined) return cachedDetector;
  try {
    const Win = window as unknown as {
      BarcodeDetector?: new (opts?: { formats?: string[] }) => BrowserBarcodeDetector;
    };
    if (Win.BarcodeDetector) {
      cachedDetector = new Win.BarcodeDetector({
        formats: [
          "code_128",
          "code_39",
          "code_93",
          "ean_13",
          "itf",
          "qr_code",
          "data_matrix",
          "pdf417",
        ],
      });
      return cachedDetector;
    }
  } catch {
    // ignore
  }
  cachedDetector = null;
  return null;
}

const LOOKALIKE_MAP: Record<string, string> = {
  O: "0",
  o: "0",
  Q: "0",
  I: "1",
  l: "1",
  "|": "1",
  Z: "2",
  z: "2",
  S: "5",
  s: "5",
  G: "6",
  B: "8",
};

export function parseTrackingStringClient(raw: string): {
  canonicalId: string;
  displayTitle: string;
  displayUpper: string;
  category: PackageCategory;
} | null {
  const s = raw.trim();
  const delMatch = s.match(
    /(?<![A-Za-z0-9])(DELIVERY|LEVERANS|DEL|DeI|De1(?=[0Oo]{2}|\d{5,})|DLV)[\s\-_:#.]*([0-9OoQqIiLl|ZzSsGB]{4,16})(?![A-Za-z0-9])/i
  );
  if (delMatch) {
    const pref = delMatch[1].toUpperCase().startsWith("DL") ? "DLV" : "DEL";
    const tail = repairDigits(delMatch[2]);
    if (tail) {
      const upper = `${pref}${tail}`;
      const title = `${pref[0]}${pref.slice(1).toLowerCase()}${tail}`;
      return {
        canonicalId: upper,
        displayTitle: title,
        displayUpper: upper,
        category: "Delivery",
      };
    }
  }

  const remMatch = s.match(
    /(?<![A-Za-z0-9])(REMOVAL|RETUR|UTTAG|REM|RMV|RET)[\s\-_:#.]*([0-9OoQqIiLl|ZzSsGB]{4,16})(?![A-Za-z0-9])/i
  );
  if (remMatch) {
    const rp = remMatch[1].toUpperCase();
    const pref = rp.startsWith("RM") ? "RMV" : rp.startsWith("RET") ? "RET" : "REM";
    const tail = repairDigits(remMatch[2]);
    if (tail) {
      const upper = `${pref}${tail}`;
      const title = `${pref[0]}${pref.slice(1).toLowerCase()}${tail}`;
      return {
        canonicalId: upper,
        displayTitle: title,
        displayUpper: upper,
        category: "Removal",
      };
    }
  }

  return null;
}

function repairDigits(rawTail: string): string | null {
  const compact = rawTail.replace(/[\s\-_]/g, "");
  if (compact.length < 4 || compact.length > 16) return null;
  let realDigits = 0;
  let out = "";
  for (const ch of compact) {
    if (ch >= "0" && ch <= "9") {
      realDigits++;
      out += ch;
    } else if (LOOKALIKE_MAP[ch]) {
      out += LOOKALIKE_MAP[ch];
    } else {
      return null;
    }
  }
  if (realDigits / compact.length < 0.75) return null;
  return out;
}

function computeCanvasSceneAndSharpness(canvas: HTMLCanvasElement): {
  sceneSignature: number[];
  sharpness: number;
} {
  const tiny = document.createElement("canvas");
  tiny.width = 64;
  tiny.height = 48;
  const tctx = tiny.getContext("2d");
  if (!tctx) return { sceneSignature: new Array(256).fill(128), sharpness: 100 };

  tctx.drawImage(canvas, 0, 0, 64, 48);
  const img = tctx.getImageData(0, 0, 64, 48).data;
  const gray = new Float32Array(64 * 48);
  for (let i = 0, j = 0; i < img.length; i += 4, j++) {
    gray[j] = img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114;
  }

  // Approximate Laplacian variance on 64x48
  let sumLap = 0;
  let sumLapSq = 0;
  let cnt = 0;
  for (let y = 1; y < 47; y++) {
    for (let x = 1; x < 63; x++) {
      const idx = y * 64 + x;
      const lap =
        4 * gray[idx] -
        gray[idx - 1] -
        gray[idx + 1] -
        gray[idx - 64] -
        gray[idx + 64];
      sumLap += lap;
      sumLapSq += lap * lap;
      cnt++;
    }
  }
  const mean = sumLap / Math.max(1, cnt);
  const variance = Math.max(0, sumLapSq / Math.max(1, cnt) - mean * mean);

  // Downsample 64x48 -> 16x16 (4x3 blocks)
  const sig: number[] = [];
  for (let sy = 0; sy < 16; sy++) {
    for (let sx = 0; sx < 16; sx++) {
      let blockSum = 0;
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          blockSum += gray[(sy * 3 + dy) * 64 + (sx * 4 + dx)];
        }
      }
      sig.push(Math.round(blockSum / 12));
    }
  }

  return { sceneSignature: sig, sharpness: Math.round(variance * 10) / 10 };
}

function cropCanvasThumb(
  canvas: HTMLCanvasElement,
  bbox: [number, number, number, number]
): string {
  const w = canvas.width;
  const h = canvas.height;
  const [x1, y1, x2, y2] = bbox;
  const bw = Math.max(0.14, x2 - x1);
  const bh = Math.max(0.1, y2 - y1);

  const px1 = Math.max(0, Math.floor((x1 - bw * 0.25) * w));
  const py1 = Math.max(0, Math.floor((y1 - Math.max(0.14, bh * 1.4)) * h));
  const px2 = Math.min(w, Math.ceil((x2 + bw * 0.25) * w));
  const py2 = Math.min(h, Math.ceil((y2 + Math.max(0.08, bh * 0.6)) * h));

  const cw = Math.max(32, px2 - px1);
  const ch = Math.max(32, py2 - py1);
  const out = document.createElement("canvas");
  const scale = cw > 260 ? 260 / cw : 1;
  out.width = Math.round(cw * scale);
  out.height = Math.round(ch * scale);
  const octx = out.getContext("2d");
  if (!octx) return "";
  octx.drawImage(canvas, px1, py1, cw, ch, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.74);
}

export async function analyzeCanvasLocally(
  canvas: HTMLCanvasElement,
  knownCustomers: string[],
  defaultCustomer: string,
  demoProjectedLabels?: ProjectedDemoLabel[]
): Promise<AnalyzeFrameResponse> {
  const { sceneSignature, sharpness } = computeCanvasSceneAndSharpness(canvas);
  const ctx = canvas.getContext("2d");
  const detectionsMap: Map<string, FrameDetection> = new Map();

  // 1. Native Browser BarcodeDetector (if supported) + Pure-TS Code128 Scanline Decoder
  const detector = getNativeBarcodeDetector();
  if (detector) {
    try {
      const hits = await detector.detect(canvas);
      for (const h of hits) {
        const parsed = parseTrackingStringClient(h.rawValue || "");
        if (!parsed) continue;
        const rect = h.boundingBox;
        const bbox: [number, number, number, number] = rect
          ? [
              Math.max(0, rect.x / canvas.width),
              Math.max(0, rect.y / canvas.height),
              Math.min(1, (rect.x + rect.width) / canvas.width),
              Math.min(1, (rect.y + rect.height) / canvas.height),
            ]
          : [0.25, 0.35, 0.75, 0.65];

        const custMatch = knownCustomers.find((c) =>
          (h.rawValue || "").toLowerCase().includes(c.toLowerCase())
        );

        detectionsMap.set(parsed.canonicalId, {
          canonical_id: parsed.canonicalId,
          display_title: parsed.displayTitle,
          display_upper: parsed.displayUpper,
          category: parsed.category,
          customer: custMatch || defaultCustomer.trim() || "",
          customer_confidence: custMatch ? 0.95 : 0,
          customer_source: custMatch ? "barcode_text" : "none",
          confidence: 0.99,
          source: `barcode (${h.format || "1D/2D"})`,
          edge_clipped: false,
          bbox,
          thumbnail: cropCanvasThumb(canvas, bbox),
        });
      }
    } catch {
      // ignore
    }
  }

  if (ctx && detectionsMap.size === 0) {
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const c128Hits = decodeCode128FromImageData(imgData);
    for (const h of c128Hits) {
      const parsed = parseTrackingStringClient(h.text);
      if (!parsed) continue;
      detectionsMap.set(parsed.canonicalId, {
        canonical_id: parsed.canonicalId,
        display_title: parsed.displayTitle,
        display_upper: parsed.displayUpper,
        category: parsed.category,
        customer: defaultCustomer.trim() || "",
        customer_confidence: 0,
        customer_source: "none",
        confidence: 0.99,
        source: "barcode (Code128)",
        edge_clipped: false,
        bbox: h.bbox,
        thumbnail: cropCanvasThumb(canvas, h.bbox),
      });
    }
  }

  // 2. Merge optical label layout when running Demo Warehouse Video in standalone offline mode
  if (demoProjectedLabels && demoProjectedLabels.length > 0) {
    for (const proj of demoProjectedLabels) {
      const cid = proj.box.canonicalId;
      const existing = detectionsMap.get(cid);
      if (existing) {
        existing.customer = proj.box.customer;
        existing.customer_confidence = 0.96;
        existing.customer_source = "known_customer";
        existing.source = "barcode+ocr";
        existing.confidence = 0.995;
        existing.bbox = proj.labelBboxNorm;
        existing.thumbnail = proj.edgeClipped
          ? ""
          : cropCanvasThumb(canvas, proj.labelBboxNorm);
      } else {
        detectionsMap.set(cid, {
          canonical_id: cid,
          display_title: proj.box.numberText,
          display_upper: cid,
          category: proj.box.category,
          customer: proj.edgeClipped ? "" : proj.box.customer,
          customer_confidence: 0.94,
          customer_source: "known_customer",
          confidence: 0.92,
          source: proj.box.barcodeText && !proj.edgeClipped ? "barcode+ocr" : "ocr",
          edge_clipped: proj.edgeClipped,
          bbox: proj.labelBboxNorm,
          thumbnail: proj.edgeClipped
            ? ""
            : cropCanvasThumb(canvas, proj.labelBboxNorm),
        });
      }
    }
  }

  return {
    sharpness,
    scene_signature: sceneSignature,
    detections: Array.from(detectionsMap.values()),
    ocr_regions: [],
  };
}
