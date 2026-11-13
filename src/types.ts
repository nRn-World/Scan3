export type PackageCategory = "Delivery" | "Removal";

export interface FrameDetection {
  canonical_id: string;
  display_title: string;
  display_upper: string;
  category: PackageCategory;
  customer: string;
  customer_confidence: number;
  customer_source: string;
  confidence: number;
  source: string;
  edge_clipped: boolean;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] normalized 0..1
  thumbnail: string;
}

export interface OcrOverlayRegion {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
}

export interface AnalyzeFrameResponse {
  sharpness: number;
  scene_signature: number[];
  detections: FrameDetection[];
  ocr_regions: OcrOverlayRegion[];
  raw_text_preview?: string;
  engine_label?: string;
}

export interface ScanSnapshot {
  id: string;
  timestampSec: number;
  formattedTime: string;
  source: string;
  confidence: number;
  thumbnail: string;
  customerDetected: string;
}

export interface InventoryRow {
  id: string;            // canonical_id (or custom manual id)
  customer: string;      // e.g. "Microsoft"
  category: PackageCategory; // "Delivery" | "Removal"
  numberTitle: string;   // e.g. "Del001234567"
  numberUpper: string;   // e.g. "DEL001234567"
  count: number;         // e.g. 2
  firstSeen: string;     // e.g. "00:02"
  verifiedBy: string;    // e.g. "Streckkod + OCR"
  snapshots: ScanSnapshot[];
  lastUpdatedTs: number;
}

export type SensitivityMode = "fast" | "standard" | "strict";

export type HudStatusKind =
  | "idle"
  | "verifying"
  | "locked_new"
  | "locked_hold"
  | "duplicate_added"
  | "edge_warning";

export interface HudBannerState {
  kind: HudStatusKind;
  title: string;
  subtitle: string;
  canonicalId?: string;
}
