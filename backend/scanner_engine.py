from __future__ import annotations

import base64
import difflib
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np
import zxingcpp
from rapidocr_onnxruntime import RapidOCR

# Default known enterprise/logistics customers (user can extend via API/UI)
DEFAULT_KNOWN_CUSTOMERS: List[str] = [
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
]

# Shipping carriers & logistics noise words that must NEVER be mistaken for Customer ("Kund")
CARRIER_AND_NOISE_WORDS = {
    "DHL",
    "DHL EXPRESS",
    "DHL PARCEL",
    "DHL FREIGHT",
    "UPS",
    "FEDEX",
    "POSTNORD",
    "DB SCHENKER",
    "SCHENKER",
    "BRING",
    "TNT",
    "DPD",
    "GLS",
    "BUDBEE",
    "AIRMEE",
    "INSTABOX",
    "DELIVERY",
    "DELIVERIES",
    "REMOVAL",
    "REMOVALS",
    "LEVERANS",
    "RETUR",
    "UTTAG",
    "PACKAGE",
    "PARCEL",
    "KOLLI",
    "BOX",
    "CARTON",
    "PALLET",
    "PALL",
    "WEIGHT",
    "VIKT",
    "GROSS WEIGHT",
    "NET WEIGHT",
    "DATE",
    "DATUM",
    "FRAGILE",
    "THIS SIDE UP",
    "HANDLE WITH CARE",
    "TRACKING",
    "TRACKING NO",
    "TRACKING NUMBER",
    "ORDER",
    "ORDER NO",
    "REF",
    "REFERENCE",
    "SHIP TO",
    "SHIP FROM",
    "FROM",
    "TO",
    "SENDER",
    "RECEIVER",
    "MOTTAGARE",
    "AVSANDARE",
    "AVSÄNDARE",
    "QTY",
    "QUANTITY",
    "ANTAL",
    "BARCODE",
    "MADE IN CHINA",
    "MADE IN SWEDEN",
    "MADE IN EU",
    "PRIORITY",
    "EXPRESS",
    "STANDARD",
    "INVENTERING",
    "WAREHOUSE",
    "DATACENTER",
}

DIGIT_LOOKALIKES = str.maketrans(
    {
        "O": "0",
        "o": "0",
        "Q": "0",
        "D": "0",
        "I": "1",
        "l": "1",
        "|": "1",
        "Z": "2",
        "z": "2",
        "S": "5",
        "s": "5",
        "G": "6",
        "B": "8",
    }
)

# Regex patterns for Delivery and Removal prefixes
DELIVERY_FULL_RE = re.compile(
    r"\b(?:DELIVERY|LEVERANS)[\s\-_:#.]*([0-9OoQqIiLl|ZzSsGB]{4,16})\b",
    re.IGNORECASE,
)
REMOVAL_FULL_RE = re.compile(
    r"\b(?:REMOVAL|RETUR|UTTAG)[\s\-_:#.]*([0-9OoQqIiLl|ZzSsGB]{4,16})\b",
    re.IGNORECASE,
)

# Prefix + digits (handles OCR reading 'Del' as 'DeI', 'de1', 'clel', or border-glued '1del0615244')
DELIVERY_PREFIX_RE = re.compile(
    r"([Dd][Ee3][LlIi1|!]|[Cc][Ll][Ee][LlIi1|!]|[Dd][Ll][Vv])[\s\-_:#.]*([0-9OoQqDdIiLl|!ZzSsGbB]{4,16})(?![A-Za-z0-9])"
)
REMOVAL_PREFIX_RE = re.compile(
    r"([Rr][Ee3][Mm]|[Rr][Mm][Vv]|[Rr][Ee][Tt])[\s\-_:#.]*([0-9OoQqDdIiLl|!ZzSsGbB]{4,16})(?![A-Za-z0-9])"
)

PURE_DIGITS_RE = re.compile(r"^\d{6,16}$")

CUSTOMER_LABEL_PREFIX_RE = re.compile(
    r"^(?:KUND|CUSTOMER|CLIENT|COMPANY|FÖRETAG|FORETAG|ACCOUNT)[\s:\-]+(.+)$",
    re.IGNORECASE,
)


@dataclass
class TextRegion:
    text: str
    confidence: float
    bbox: Tuple[float, float, float, float]  # x_min, y_min, x_max, y_max (normalized 0..1)
    polygon: List[List[float]] = field(default_factory=list)


@dataclass
class ParsedCode:
    canonical_id: str      # e.g. "DEL001234567"
    display_title: str     # e.g. "Del001234567"
    display_upper: str     # e.g. "DEL001234567"
    category: str          # "Delivery" | "Removal"
    prefix_norm: str       # "DEL" | "REM" | "RMV" | "RET" | "DLV"
    digits: str            # "001234567"


def _clean_numeric_tail(
    raw_tail: str, min_len: int = 4, min_digit_ratio: float = 0.70
) -> Optional[str]:
    compact = re.sub(r"[\s\-_.:#]", "", raw_tail)
    if len(compact) < min_len or len(compact) > 16:
        return None
    real_digits = sum(1 for ch in compact if ch.isdigit())
    if real_digits / len(compact) < min_digit_ratio:
        return None
    repaired = compact.translate(DIGIT_LOOKALIKES)
    if not repaired.isdigit():
        return None
    return repaired


def parse_tracking_tokens(text: str) -> List[ParsedCode]:
    """Extract all valid Delivery / Removal tracking numbers from a text string."""
    if not text or len(text.strip()) < 5:
        return []

    cleaned = text.strip()
    found: Dict[str, ParsedCode] = {}

    # 1. Explicit DELIVERY / REMOVAL + digits
    for m in DELIVERY_FULL_RE.finditer(cleaned):
        digits = _clean_numeric_tail(m.group(1))
        if digits:
            cid = f"DEL{digits}"
            found[cid] = ParsedCode(
                canonical_id=cid,
                display_title=f"Del{digits}",
                display_upper=cid,
                category="Delivery",
                prefix_norm="DEL",
                digits=digits,
            )

    for m in REMOVAL_FULL_RE.finditer(cleaned):
        digits = _clean_numeric_tail(m.group(1))
        if digits:
            cid = f"REM{digits}"
            found[cid] = ParsedCode(
                canonical_id=cid,
                display_title=f"Rem{digits}",
                display_upper=cid,
                category="Removal",
                prefix_norm="REM",
                digits=digits,
            )

    # 2. Prefix DEL / DLV / REM / RMV / RET + digits
    for m in DELIVERY_PREFIX_RE.finditer(cleaned):
        start_idx = m.start()
        if start_idx >= 2 and cleaned[start_idx - 2 : start_idx].lower() == "mo":
            continue
        prev_ch = cleaned[start_idx - 1] if start_idx > 0 else ""
        min_len = 6 if (prev_ch.isalpha() and prev_ch not in "Ili") else 4
        raw_pref, raw_tail = m.group(1), m.group(2)
        digits = _clean_numeric_tail(raw_tail, min_len=min_len)
        if not digits:
            continue
        if raw_pref.endswith("1") and len(digits) < 5:
            continue
        pref_up = "DLV" if raw_pref.upper().startswith("DL") else "DEL"
        pref_title = pref_up.capitalize()
        cid = f"{pref_up}{digits}"
        found[cid] = ParsedCode(
            canonical_id=cid,
            display_title=f"{pref_title}{digits}",
            display_upper=cid,
            category="Delivery",
            prefix_norm=pref_up,
            digits=digits,
        )

    for m in REMOVAL_PREFIX_RE.finditer(cleaned):
        raw_pref, raw_tail = m.group(1), m.group(2)
        digits = _clean_numeric_tail(raw_tail)
        if not digits:
            continue
        ru = raw_pref.upper()
        if ru.startswith("RM"):
            pref_up = "RMV"
        elif ru.startswith("RET"):
            pref_up = "RET"
        else:
            pref_up = "REM"
        pref_title = pref_up.capitalize()
        cid = f"{pref_up}{digits}"
        found[cid] = ParsedCode(
            canonical_id=cid,
            display_title=f"{pref_title}{digits}",
            display_upper=cid,
            category="Removal",
            prefix_norm=pref_up,
            digits=digits,
        )

    return list(found.values())


def _normalize_for_match(s: str) -> str:
    return re.sub(r"[^A-Z0-9&ÅÄÖ ]+", " ", s.upper()).strip()


def match_known_customer(candidate: str, known_customers: Sequence[str]) -> Optional[str]:
    """Match exact, substring, or high-similarity fuzzy typo against known customers."""
    norm_cand = _normalize_for_match(candidate)
    if not norm_cand or len(norm_cand) < 2:
        return None
    if norm_cand in CARRIER_AND_NOISE_WORDS:
        return None

    # Strip common corporate suffixes for matching
    stripped_cand = re.sub(
        r"\b(?:AB|CORP|CORPORATION|INC|LTD|GMBH|SVERIGE|SWEDEN|NORDIC|GROUP|CLOUD)\b",
        "",
        norm_cand,
    ).strip()
    check_variants = [v for v in [norm_cand, stripped_cand] if v]

    # 1. Exact match
    for cust in known_customers:
        nc = _normalize_for_match(cust)
        if nc in check_variants:
            return cust

    # 2. Whole-word containment (e.g. "MICROSOFT SVERIGE AB" -> "Microsoft")
    for cust in sorted(known_customers, key=len, reverse=True):
        nc = _normalize_for_match(cust)
        if len(nc) >= 3 and re.search(rf"(?<![A-Z0-9]){re.escape(nc)}(?![A-Z0-9])", norm_cand):
            return cust

    # 3. Fuzzy typo match (e.g. "Microsft" -> "Microsoft", "M1crosoft" -> "Microsoft")
    ocr_alpha_fixed = (
        stripped_cand.replace("1", "I").replace("0", "O").replace("5", "S")
        if stripped_cand
        else norm_cand
    )
    best_cust: Optional[str] = None
    best_ratio = 0.0
    for cust in known_customers:
        nc = _normalize_for_match(cust)
        if len(nc) < 4:
            continue
        for variant in (stripped_cand or norm_cand, ocr_alpha_fixed):
            if abs(len(variant) - len(nc)) > 3:
                continue
            ratio = difflib.SequenceMatcher(None, variant, nc).ratio()
            if ratio >= 0.84 and ratio > best_ratio:
                best_ratio = ratio
                best_cust = cust

    return best_cust


def _is_plausible_unknown_customer_line(text: str, confidence: float) -> Optional[str]:
    """Check if an unknown OCR line right above/near the tracking number is a valid customer name."""
    if confidence < 0.76:
        return None
    raw = text.strip(" -_:.,;#*|/\\[]()")
    if len(raw) < 2 or len(raw) > 38:
        return None

    # Reject if it contains a tracking code itself
    if parse_tracking_tokens(raw):
        return None

    upper = _normalize_for_match(raw)
    if not upper or upper in CARRIER_AND_NOISE_WORDS:
        return None

    # Reject if any carrier/noise phrase dominates the line
    tokens = upper.split()
    if all(tok in CARRIER_AND_NOISE_WORDS for tok in tokens):
        return None
    if any(tok in {"DHL", "UPS", "FEDEX", "POSTNORD", "SCHENKER", "FRAGILE", "WEIGHT", "VIKT"} for tok in tokens):
        return None

    # Must contain mostly letters (not dates, weights, dimensions, box counts like "1/2" or "12.5 KG")
    letters = sum(1 for c in raw if c.isalpha())
    digits = sum(1 for c in raw if c.isdigit())
    if letters < 2 or digits > max(2, letters // 2):
        return None
    if re.search(r"\b\d+\s*(?:KG|G|CM|MM|LBS|ST|PCS|OF|AV)\b", upper):
        return None
    if re.match(r"^\d+[/\-]\d+$", raw.strip()):
        return None

    # Clean formatting: preserve casing if mixed/upper, trim stray punctuation
    cleaned = re.sub(r"\s+", " ", raw).strip()
    return cleaned


def extract_customer_for_code(
    code_bbox: Tuple[float, float, float, float],
    regions: Sequence[TextRegion],
    known_customers: Sequence[str],
    code_canonical: str,
) -> Tuple[str, float, str]:
    """
    Find the customer name spatially associated with a detected tracking code on the same label.
    Returns (customer_name, confidence, match_source).
    """
    cx = (code_bbox[0] + code_bbox[2]) / 2.0
    cy = (code_bbox[1] + code_bbox[3]) / 2.0
    cw = max(0.05, code_bbox[2] - code_bbox[0])

    best_known: Optional[Tuple[float, str, float]] = None  # (score, name, conf)
    best_explicit: Optional[Tuple[float, str, float]] = None
    best_spatial: Optional[Tuple[float, str, float]] = None

    for reg in regions:
        txt = reg.text.strip()
        if not txt:
            continue
        # Skip the tracking code line itself unless it ALSO contains customer text
        codes_in_line = [c.canonical_id for c in parse_tracking_tokens(txt)]
        remainder = txt
        if code_canonical in codes_in_line:
            remainder = DELIVERY_PREFIX_RE.sub("", remainder)
            remainder = REMOVAL_PREFIX_RE.sub("", remainder)
            remainder = DELIVERY_FULL_RE.sub("", remainder)
            remainder = REMOVAL_FULL_RE.sub("", remainder)
            remainder = remainder.strip(" -_:.,;|/")
            if len(remainder) < 2:
                continue

        rx = (reg.bbox[0] + reg.bbox[2]) / 2.0
        ry = (reg.bbox[1] + reg.bbox[3]) / 2.0
        dy = cy - ry  # positive means candidate is ABOVE the tracking code (most common!)
        dx = abs(cx - rx)

        # Must be within plausible label distance of this tracking code
        if abs(dy) > 0.48 or dx > max(0.38, cw * 1.6):
            continue

        # Spatial proximity score: strongly prefer lines directly above on the same label
        vertical_bonus = 1.25 if (0.0 <= dy <= 0.32) else (0.85 if (-0.22 <= dy < 0.0) else 0.55)
        dist_penalty = (abs(dy) * 1.4) + (dx * 1.2)
        prox_score = max(0.1, vertical_bonus - dist_penalty) * max(0.5, reg.confidence)

        # 1. Check explicit "Kund: Microsoft" / "Customer: ..."
        m_exp = CUSTOMER_LABEL_PREFIX_RE.match(remainder)
        if m_exp:
            val = m_exp.group(1).strip(" -_:.,;")
            known_hit = match_known_customer(val, known_customers)
            final_val = known_hit or _is_plausible_unknown_customer_line(val, max(0.85, reg.confidence))
            if final_val:
                sc = prox_score + 2.0
                if best_explicit is None or sc > best_explicit[0]:
                    best_explicit = (sc, final_val, reg.confidence)
                continue

        # 2. Check Known Customer dictionary (exact or fuzzy)
        known_hit = match_known_customer(remainder, known_customers)
        if known_hit:
            sc = prox_score + 1.5
            if best_known is None or sc > best_known[0]:
                best_known = (sc, known_hit, reg.confidence)
            continue

        # 3. Check plausible unknown customer name right on the same label
        # Tighter spatial gate for unknown free-text lines so background clutter isn't picked up
        if -0.15 <= dy <= 0.30 and dx <= max(0.26, cw * 1.15):
            unk = _is_plausible_unknown_customer_line(remainder, reg.confidence)
            if unk:
                if best_spatial is None or prox_score > best_spatial[0]:
                    best_spatial = (prox_score, unk, reg.confidence)

    if best_explicit:
        return best_explicit[1], round(best_explicit[2], 3), "explicit_label"
    if best_known:
        return best_known[1], round(best_known[2], 3), "known_customer"
    if best_spatial:
        return best_spatial[1], round(best_spatial[2], 3), "label_header"

    return "", 0.0, "none"


class LabelScannerEngine:
    """High-accuracy hybrid Barcode (ZXing-CPP) + Neural Scene OCR (PP-OCRv4) label analyzer."""

    def __init__(self) -> None:
        self.ocr = RapidOCR()

    @staticmethod
    def compute_sharpness_and_signature(gray: np.ndarray) -> Tuple[float, List[int]]:
        small = cv2.resize(gray, (320, 240), interpolation=cv2.INTER_AREA)
        sharpness = float(cv2.Laplacian(small, cv2.CV_64F).var())
        tiny = cv2.resize(gray, (16, 16), interpolation=cv2.INTER_AREA)
        return round(sharpness, 1), tiny.flatten().astype(int).tolist()

    @staticmethod
    def _crop_thumbnail_b64(
        bgr: np.ndarray, bbox_norm: Tuple[float, float, float, float]
    ) -> str:
        h, w = bgr.shape[:2]
        x1, y1, x2, y2 = bbox_norm
        # Expand crop nicely around the whole label area (especially upward to include Customer name!)
        bw = max(0.12, x2 - x1)
        bh = max(0.08, y2 - y1)
        px1 = max(0, int((x1 - bw * 0.35) * w))
        py1 = max(0, int((y1 - max(0.16, bh * 2.2)) * h))
        px2 = min(w, int((x2 + bw * 0.35) * w))
        py2 = min(h, int((y2 + max(0.10, bh * 1.1)) * h))

        crop = bgr[py1:py2, px1:px2]
        if crop.size == 0:
            crop = bgr
        ch, cw = crop.shape[:2]
        max_w = 280
        if cw > max_w:
            scale = max_w / cw
            crop = cv2.resize(crop, (max_w, max(40, int(ch * scale))), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), 76])
        if not ok:
            return ""
        return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode("ascii")

    @staticmethod
    def _stitch_horizontal_regions(regions: List[TextRegion]) -> List[TextRegion]:
        """Merge horizontally adjacent boxes on the same line (e.g. 'Del' + '001234567')."""
        if len(regions) < 2:
            return regions
        ordered = sorted(regions, key=lambda r: ((r.bbox[1] + r.bbox[3]) / 2.0, r.bbox[0]))
        stitched: List[TextRegion] = list(regions)
        n = len(ordered)
        for i in range(n):
            a = ordered[i]
            ah = max(0.01, a.bbox[3] - a.bbox[1])
            acy = (a.bbox[1] + a.bbox[3]) / 2.0
            for j in range(i + 1, n):
                b = ordered[j]
                bh = max(0.01, b.bbox[3] - b.bbox[1])
                bcy = (b.bbox[1] + b.bbox[3]) / 2.0
                avg_h = (ah + bh) / 2.0
                if abs(acy - bcy) > avg_h * 0.65:
                    continue
                left, right = (a, b) if a.bbox[0] <= b.bbox[0] else (b, a)
                gap = right.bbox[0] - left.bbox[2]
                if -avg_h * 0.4 <= gap <= avg_h * 2.2:
                    merged_text = f"{left.text.strip()} {right.text.strip()}"
                    merged_bbox = (
                        min(left.bbox[0], right.bbox[0]),
                        min(left.bbox[1], right.bbox[1]),
                        max(left.bbox[2], right.bbox[2]),
                        max(left.bbox[3], right.bbox[3]),
                    )
                    stitched.append(
                        TextRegion(
                            text=merged_text,
                            confidence=min(left.confidence, right.confidence),
                            bbox=merged_bbox,
                        )
                    )
        return stitched

    def analyze_image(
        self,
        bgr: np.ndarray,
        known_customers: Optional[Sequence[str]] = None,
        default_customer: str = "",
    ) -> Dict:
        customers = list(known_customers) if known_customers else DEFAULT_KNOWN_CUSTOMERS
        orig_h, orig_w = bgr.shape[:2]
        gray_full = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

        sharpness, scene_sig = self.compute_sharpness_and_signature(gray_full)

        # 1. Fast C++ 1D/2D Barcode detection on full-resolution grayscale
        barcode_hits: Dict[str, Dict] = {}
        pure_digit_barcodes: List[Tuple[str, Tuple[float, float, float, float], str]] = []
        try:
            bcs = zxingcpp.read_barcodes(gray_full)
            for bc in bcs:
                raw_val = (bc.text or "").strip()
                if not raw_val:
                    continue
                pos = bc.position
                pts_x = [pos.top_left.x, pos.top_right.x, pos.bottom_right.x, pos.bottom_left.x]
                pts_y = [pos.top_left.y, pos.top_right.y, pos.bottom_right.y, pos.bottom_left.y]
                bbox_norm = (
                    max(0.0, min(pts_x) / orig_w),
                    max(0.0, min(pts_y) / orig_h),
                    min(1.0, max(pts_x) / orig_w),
                    min(1.0, max(pts_y) / orig_h),
                )
                fmt_name = str(bc.format).split(".")[-1]
                parsed_list = parse_tracking_tokens(raw_val)
                if parsed_list:
                    for p in parsed_list:
                        barcode_hits[p.canonical_id] = {
                            "parsed": p,
                            "bbox": bbox_norm,
                            "format": fmt_name,
                            "raw": raw_val,
                        }
                elif PURE_DIGITS_RE.match(raw_val):
                    pure_digit_barcodes.append((raw_val, bbox_norm, fmt_name))
        except Exception:
            pass

        # 2. Neural OCR (PP-OCRv4) on resized image (max side 840px for fast ~260ms inference)
        ocr_img = bgr
        max_side = max(orig_h, orig_w)
        if max_side > 840:
            scale = 840.0 / max_side
            ocr_img = cv2.resize(
                bgr,
                (max(32, int(orig_w * scale)), max(32, int(orig_h * scale))),
                interpolation=cv2.INTER_AREA,
            )

        # Mild CLAHE contrast enhancement if warehouse lighting is dim or low-contrast
        if float(gray_full.std()) < 42.0:
            lab = cv2.cvtColor(ocr_img, cv2.COLOR_BGR2LAB)
            l_ch, a_ch, b_ch = cv2.split(lab)
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            ocr_img = cv2.cvtColor(cv2.merge((clahe.apply(l_ch), a_ch, b_ch)), cv2.COLOR_LAB2BGR)

        oh, ow = ocr_img.shape[:2]
        raw_ocr, _ = self.ocr(ocr_img, use_cls=False)

        regions: List[TextRegion] = []
        if raw_ocr:
            for item in raw_ocr:
                poly, txt, conf_raw = item[0], str(item[1]), float(item[2])
                xs = [pt[0] / ow for pt in poly]
                ys = [pt[1] / oh for pt in poly]
                bbox_n = (
                    max(0.0, min(xs)),
                    max(0.0, min(ys)),
                    min(1.0, max(xs)),
                    min(1.0, max(ys)),
                )
                norm_poly = [[round(pt[0] / ow, 4), round(pt[1] / oh, 4)] for pt in poly]
                regions.append(
                    TextRegion(text=txt, confidence=conf_raw, bbox=bbox_n, polygon=norm_poly)
                )

        candidate_regions = self._stitch_horizontal_regions(regions)

        # 3. Extract tracking codes from OCR regions
        ocr_hits: Dict[str, Dict] = {}
        label_has_delivery_word = False
        label_has_removal_word = False
        pure_digit_ocr: List[Tuple[str, Tuple[float, float, float, float], float]] = []

        for reg in candidate_regions:
            up_txt = reg.text.strip().upper()
            if re.search(r"\b(?:DELIVERY|LEVERANS)\b", up_txt):
                label_has_delivery_word = True
            if re.search(r"\b(?:REMOVAL|RETUR|UTTAG)\b", up_txt):
                label_has_removal_word = True

            parsed_codes = parse_tracking_tokens(reg.text)
            if parsed_codes:
                edge_clipped = reg.bbox[0] <= 0.018 or reg.bbox[2] >= 0.982
                for p in parsed_codes:
                    prev = ocr_hits.get(p.canonical_id)
                    if prev is None or reg.confidence > prev["confidence"]:
                        ocr_hits[p.canonical_id] = {
                            "parsed": p,
                            "bbox": reg.bbox,
                            "confidence": reg.confidence,
                            "edge_clipped": edge_clipped,
                            "raw": reg.text,
                        }
            elif PURE_DIGITS_RE.match(up_txt) and reg.confidence >= 0.84:
                pure_digit_ocr.append((up_txt, reg.bbox, reg.confidence))

        # 4. Fallback: if label explicitly says 'Delivery' or 'Removal' + pure digits barcode/line
        if not barcode_hits and not ocr_hits and (label_has_delivery_word ^ label_has_removal_word):
            cat = "Delivery" if label_has_delivery_word else "Removal"
            pref_up = "DEL" if cat == "Delivery" else "REM"
            pref_title = "Del" if cat == "Delivery" else "Rem"
            for digits, bbox_n, fmt_name in pure_digit_barcodes:
                cid = f"{pref_up}{digits}"
                barcode_hits[cid] = {
                    "parsed": ParsedCode(cid, f"{pref_title}{digits}", cid, cat, pref_up, digits),
                    "bbox": bbox_n,
                    "format": fmt_name,
                    "raw": digits,
                }
            if not barcode_hits:
                for digits, bbox_n, conf in pure_digit_ocr:
                    cid = f"{pref_up}{digits}"
                    ocr_hits[cid] = {
                        "parsed": ParsedCode(cid, f"{pref_title}{digits}", cid, cat, pref_up, digits),
                        "bbox": bbox_n,
                        "confidence": conf,
                        "edge_clipped": bbox_n[0] <= 0.018 or bbox_n[2] >= 0.982,
                        "raw": digits,
                    }

        # 5. Merge Barcode + OCR detections per unique canonical code in this frame
        #    (Prevents double-counting when BOTH barcode and human-readable text appear on the SAME label!)
        all_ids = list(dict.fromkeys(list(barcode_hits.keys()) + list(ocr_hits.keys())))

        # Drop strict substring partial OCR hits if a longer code with the same prefix is in the same frame
        filtered_ids: List[str] = []
        for cid in all_ids:
            if cid not in barcode_hits and any(
                other != cid and cid in other for other in all_ids
            ):
                continue
            filtered_ids.append(cid)

        detections: List[Dict] = []
        for cid in filtered_ids:
            bc_info = barcode_hits.get(cid)
            ocr_info = ocr_hits.get(cid)

            if bc_info and ocr_info:
                parsed = bc_info["parsed"]
                merged_bbox = (
                    min(bc_info["bbox"][0], ocr_info["bbox"][0]),
                    min(bc_info["bbox"][1], ocr_info["bbox"][1]),
                    max(bc_info["bbox"][2], ocr_info["bbox"][2]),
                    max(bc_info["bbox"][3], ocr_info["bbox"][3]),
                )
                source = "barcode+ocr"
                confidence = 0.995
                edge_clipped = False
            elif bc_info:
                parsed = bc_info["parsed"]
                merged_bbox = bc_info["bbox"]
                source = f"barcode ({bc_info['format']})"
                confidence = 0.99
                edge_clipped = False
            else:
                assert ocr_info is not None
                parsed = ocr_info["parsed"]
                merged_bbox = ocr_info["bbox"]
                source = "ocr"
                confidence = round(float(ocr_info["confidence"]), 3)
                edge_clipped = bool(ocr_info["edge_clipped"])

            cust_name, cust_conf, cust_source = extract_customer_for_code(
                merged_bbox, regions, customers, cid
            )
            if not cust_name and default_customer.strip():
                cust_name = default_customer.strip()
                cust_source = "default_selected"
                cust_conf = 1.0

            thumb = self._crop_thumbnail_b64(bgr, merged_bbox) if not edge_clipped else ""

            detections.append(
                {
                    "canonical_id": parsed.canonical_id,
                    "display_title": parsed.display_title,
                    "display_upper": parsed.display_upper,
                    "category": parsed.category,
                    "customer": cust_name,
                    "customer_confidence": cust_conf,
                    "customer_source": cust_source,
                    "confidence": confidence,
                    "source": source,
                    "edge_clipped": edge_clipped,
                    "bbox": [round(v, 4) for v in merged_bbox],
                    "thumbnail": thumb,
                }
            )

        # Also return all OCR text boxes lightly so UI can draw subtle visual feedback
        ocr_overlays = [
            {
                "text": r.text,
                "confidence": round(r.confidence, 2),
                "bbox": [round(v, 4) for v in r.bbox],
            }
            for r in regions
            if r.confidence >= 0.60
        ]

        return {
            "sharpness": sharpness,
            "scene_signature": scene_sig,
            "detections": detections,
            "ocr_regions": ocr_overlays,
        }
