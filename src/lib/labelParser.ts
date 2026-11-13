import { PackageCategory } from "../types";

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

const CARRIER_AND_NOISE_WORDS = new Set([
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
  "PRIORITY",
  "EXPRESS",
  "STANDARD",
  "INVENTERING",
  "WAREHOUSE",
  "DATACENTER",
]);

const DIGIT_LOOKALIKES: Record<string, string> = {
  O: "0",
  o: "0",
  Q: "0",
  D: "0",
  I: "1",
  l: "1",
  "|": "1",
  "!": "1",
  Z: "2",
  z: "2",
  S: "5",
  s: "5",
  G: "6",
  b: "6",
  B: "8",
};

export interface ParsedTrackingCode {
  canonicalId: string;   // e.g. "DEL0615244"
  displayTitle: string;  // e.g. "Del0615244"
  displayUpper: string;  // e.g. "DEL0615244"
  category: PackageCategory;
  digits: string;        // e.g. "0615244"
}

export interface OcrLineItem {
  text: string;
  confidence: number; // 0..1
  bbox: [number, number, number, number]; // normalized 0..1
}

export function cleanNumericTail(
  rawTail: string,
  minLen = 4,
  minDigitRatio = 0.7
): string | null {
  const compact = rawTail.replace(/[\s\-_.:#]/g, "");
  if (compact.length < minLen || compact.length > 16) return null;

  let realDigits = 0;
  let repaired = "";
  for (const ch of compact) {
    if (ch >= "0" && ch <= "9") {
      realDigits++;
      repaired += ch;
    } else if (DIGIT_LOOKALIKES[ch] !== undefined) {
      repaired += DIGIT_LOOKALIKES[ch];
    } else {
      return null;
    }
  }

  if (realDigits / compact.length < minDigitRatio) return null;
  return repaired;
}

// Matches full words DELIVERY / REMOVAL + digits
const DELIVERY_FULL_RE =
  /\b(?:DELIVERY|LEVERANS)[\s\-_:#.]*([0-9OoQqDdIiLl|!ZzSsGbB]{4,16})(?![A-Za-z0-9])/gi;
const REMOVAL_FULL_RE =
  /\b(?:REMOVAL|RETUR|UTTAG)[\s\-_:#.]*([0-9OoQqDdIiLl|!ZzSsGbB]{4,16})(?![A-Za-z0-9])/gi;

// Matches DEL / del / DeI / de1 / clel / DLV + digits (including border artifacts like '|del0615244' -> '1del0615244')
// Excludes 'model' via check in code!
const DELIVERY_PREFIX_RE =
  /([Dd][Ee3][LlIi1|!]|[Cc][Ll][Ee][LlIi1|!]|[Dd][Ll][Vv])[\s\-_:#.]*([0-9OoQqDdIiLl|!ZzSsGbB]{4,16})(?![A-Za-z0-9])/g;

const REMOVAL_PREFIX_RE =
  /([Rr][Ee3][Mm]|[Rr][Mm][Vv]|[Rr][Ee][Tt])[\s\-_:#.]*([0-9OoQqDdIiLl|!ZzSsGbB]{4,16})(?![A-Za-z0-9])/g;

export function parseTrackingTokensClient(text: string): ParsedTrackingCode[] {
  if (!text || text.trim().length < 5) return [];
  const cleaned = text.trim();
  const found = new Map<string, ParsedTrackingCode>();

  for (const m of cleaned.matchAll(DELIVERY_FULL_RE)) {
    const digits = cleanNumericTail(m[1], 4, 0.7);
    if (digits) {
      const cid = `DEL${digits}`;
      found.set(cid, {
        canonicalId: cid,
        displayTitle: `Del${digits}`,
        displayUpper: cid,
        category: "Delivery",
        digits,
      });
    }
  }

  for (const m of cleaned.matchAll(REMOVAL_FULL_RE)) {
    const digits = cleanNumericTail(m[1], 4, 0.7);
    if (digits) {
      const cid = `REM${digits}`;
      found.set(cid, {
        canonicalId: cid,
        displayTitle: `Rem${digits}`,
        displayUpper: cid,
        category: "Removal",
        digits,
      });
    }
  }

  for (const m of cleaned.matchAll(DELIVERY_PREFIX_RE)) {
    const matchIdx = m.index ?? 0;
    const before = cleaned.slice(Math.max(0, matchIdx - 3), matchIdx);
    // Reject words like "model2024" ("mo" right before "del")
    if (/mo$/i.test(before)) continue;
    // If preceded by a letter other than common OCR border glyphs ('I', 'l', 'i'), require >= 6 digits
    const prevChar = matchIdx > 0 ? cleaned[matchIdx - 1] : "";
    const isGluedAlpha =
      /[A-Za-z]/.test(prevChar) && !/[Ili]/.test(prevChar);

    const rawPref = m[1];
    const rawTail = m[2];
    const minDigits = isGluedAlpha ? 6 : 4;
    const digits = cleanNumericTail(rawTail, minDigits, 0.7);
    if (!digits) continue;

    // Extra safety if 'de1' matched: ensure total digits >= 5 (like de10615244 -> 7 digits)
    if (/1$/.test(rawPref) && digits.length < 5) continue;

    const prefUp = rawPref.toUpperCase().startsWith("DL") ? "DLV" : "DEL";
    const prefTitle = prefUp === "DLV" ? "Dlv" : "Del";
    const cid = `${prefUp}${digits}`;
    found.set(cid, {
      canonicalId: cid,
      displayTitle: `${prefTitle}${digits}`,
      displayUpper: cid,
      category: "Delivery",
      digits,
    });
  }

  for (const m of cleaned.matchAll(REMOVAL_PREFIX_RE)) {
    const matchIdx = m.index ?? 0;
    const prevChar = matchIdx > 0 ? cleaned[matchIdx - 1] : "";
    const isGluedAlpha =
      /[A-Za-z]/.test(prevChar) && !/[Ili]/.test(prevChar);
    const minDigits = isGluedAlpha ? 6 : 4;

    const rawPref = m[1].toUpperCase();
    const digits = cleanNumericTail(m[2], minDigits, 0.7);
    if (!digits) continue;

    const prefUp = rawPref.startsWith("RM")
      ? "RMV"
      : rawPref.startsWith("RET")
        ? "RET"
        : "REM";
    const prefTitle =
      prefUp === "RMV" ? "Rmv" : prefUp === "RET" ? "Ret" : "Rem";
    const cid = `${prefUp}${digits}`;
    found.set(cid, {
      canonicalId: cid,
      displayTitle: `${prefTitle}${digits}`,
      displayUpper: cid,
      category: "Removal",
      digits,
    });
  }

  return Array.from(found.values());
}

function normalizeForMatch(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9&ÅÄÖ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarityRatio(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const dp = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  const dist = dp[la][lb];
  return 1 - dist / Math.max(la, lb);
}

export function matchKnownCustomerClient(
  candidate: string,
  knownCustomers: string[]
): string | null {
  const normCand = normalizeForMatch(candidate);
  if (!normCand || normCand.length < 2) return null;
  if (CARRIER_AND_NOISE_WORDS.has(normCand)) return null;

  const stripped = normCand
    .replace(
      /\b(?:AB|CORP|CORPORATION|INC|LTD|GMBH|SVERIGE|SWEDEN|NORDIC|GROUP|CLOUD)\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
  const variants = [normCand, stripped].filter(Boolean);

  for (const cust of knownCustomers) {
    const nc = normalizeForMatch(cust);
    if (variants.includes(nc)) return cust;
  }

  const sortedByLen = [...knownCustomers].sort((a, b) => b.length - a.length);
  for (const cust of sortedByLen) {
    const nc = normalizeForMatch(cust);
    if (nc.length >= 3) {
      const escaped = nc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?<![A-Z0-9])${escaped}(?![A-Z0-9])`).test(normCand)) {
        return cust;
      }
    }
  }

  const alphaFixed = (stripped || normCand)
    .replace(/1/g, "I")
    .replace(/0/g, "O")
    .replace(/5/g, "S");

  let bestCust: string | null = null;
  let bestScore = 0;
  for (const cust of knownCustomers) {
    const nc = normalizeForMatch(cust);
    if (nc.length < 4) continue;
    for (const v of [stripped || normCand, alphaFixed]) {
      if (Math.abs(v.length - nc.length) > 3) continue;
      const sc = similarityRatio(v, nc);
      if (sc >= 0.82 && sc > bestScore) {
        bestScore = sc;
        bestCust = cust;
      }
    }
  }
  return bestCust;
}

function plausibleUnknownCustomer(text: string, confidence: number): string | null {
  if (confidence < 0.68) return null;
  const raw = text.replace(/^[\s\-_:.,;#*|/\\[\]()]+|[\s\-_:.,;#*|/\\[\]()]+$/g, "");
  if (raw.length < 2 || raw.length > 36) return null;
  if (parseTrackingTokensClient(raw).length > 0) return null;

  const upper = normalizeForMatch(raw);
  if (!upper || CARRIER_AND_NOISE_WORDS.has(upper)) return null;
  const toks = upper.split(" ");
  if (toks.every((t) => CARRIER_AND_NOISE_WORDS.has(t))) return null;
  if (
    toks.some((t) =>
      ["DHL", "UPS", "FEDEX", "POSTNORD", "SCHENKER", "FRAGILE", "WEIGHT", "VIKT"].includes(t)
    )
  ) {
    return null;
  }

  let letters = 0;
  let digits = 0;
  for (const ch of raw) {
    if (/[A-Za-zÅÄÖåäö]/.test(ch)) letters++;
    else if (/[0-9]/.test(ch)) digits++;
  }
  if (letters < 3 || digits > Math.max(2, Math.floor(letters / 2))) return null;
  if (/\b\d+\s*(?:KG|G|CM|MM|LBS|ST|PCS|OF|AV)\b/.test(upper)) return null;
  return raw.replace(/\s+/g, " ").trim();
}

export function extractCustomerFromOcrLines(
  codeBbox: [number, number, number, number],
  lines: OcrLineItem[],
  knownCustomers: string[],
  canonicalId: string
): { customer: string; confidence: number; source: string } {
  const cx = (codeBbox[0] + codeBbox[2]) / 2;
  const cy = (codeBbox[1] + codeBbox[3]) / 2;
  const cw = Math.max(0.08, codeBbox[2] - codeBbox[0]);

  let bestExplicit: { sc: number; name: string; conf: number } | null = null;
  let bestKnown: { sc: number; name: string; conf: number } | null = null;
  let bestSpatial: { sc: number; name: string; conf: number } | null = null;

  for (const line of lines) {
    let txt = line.text.trim();
    if (!txt) continue;

    const codesInLine = parseTrackingTokensClient(txt).map((c) => c.canonicalId);
    if (codesInLine.includes(canonicalId)) {
      txt = txt
        .replace(DELIVERY_PREFIX_RE, "")
        .replace(REMOVAL_PREFIX_RE, "")
        .replace(DELIVERY_FULL_RE, "")
        .replace(REMOVAL_FULL_RE, "")
        .replace(/^[\s\-_:.,;|/]+|[\s\-_:.,;|/]+$/g, "");
      if (txt.length < 2) continue;
    }

    const rx = (line.bbox[0] + line.bbox[2]) / 2;
    const ry = (line.bbox[1] + line.bbox[3]) / 2;
    const dy = cy - ry; // positive = candidate is ABOVE tracking code
    const dx = Math.abs(cx - rx);

    if (Math.abs(dy) > 0.55 || dx > Math.max(0.45, cw * 1.8)) continue;

    const vertBonus =
      dy >= 0 && dy <= 0.36 ? 1.3 : dy > -0.25 && dy < 0 ? 0.85 : 0.55;
    const prox =
      Math.max(0.1, vertBonus - (Math.abs(dy) * 1.2 + dx * 1.0)) *
      Math.max(0.5, line.confidence);

    const expMatch = txt.match(
      /^(?:KUND|CUSTOMER|CLIENT|COMPANY|FÖRETAG|FORETAG|ACCOUNT)[\s:\-]+(.+)$/i
    );
    if (expMatch) {
      const val = expMatch[1].trim();
      const hit =
        matchKnownCustomerClient(val, knownCustomers) ||
        plausibleUnknownCustomer(val, Math.max(0.85, line.confidence));
      if (hit) {
        const sc = prox + 2.0;
        if (!bestExplicit || sc > bestExplicit.sc) {
          bestExplicit = { sc, name: hit, conf: line.confidence };
        }
        continue;
      }
    }

    const knownHit = matchKnownCustomerClient(txt, knownCustomers);
    if (knownHit) {
      const sc = prox + 1.5;
      if (!bestKnown || sc > bestKnown.sc) {
        bestKnown = { sc, name: knownHit, conf: line.confidence };
      }
      continue;
    }

    if (dy >= -0.15 && dy <= 0.34 && dx <= Math.max(0.32, cw * 1.3)) {
      const unk = plausibleUnknownCustomer(txt, line.confidence);
      if (unk && (!bestSpatial || prox > bestSpatial.sc)) {
        bestSpatial = { sc: prox, name: unk, conf: line.confidence };
      }
    }
  }

  if (bestExplicit) {
    return {
      customer: bestExplicit.name,
      confidence: bestExplicit.conf,
      source: "explicit_label",
    };
  }
  if (bestKnown) {
    return {
      customer: bestKnown.name,
      confidence: bestKnown.conf,
      source: "known_customer",
    };
  }
  if (bestSpatial) {
    return {
      customer: bestSpatial.name,
      confidence: bestSpatial.conf,
      source: "label_header",
    };
  }
  return { customer: "", confidence: 0, source: "none" };
}
