import {
  AnalyzeFrameResponse,
  FrameDetection,
  HudBannerState,
  InventoryRow,
  SensitivityMode,
  ScanSnapshot,
} from "../types";

interface PendingOcrCandidate {
  canonicalId: string;
  sightings: number;
  firstTs: number;
  lastTs: number;
  bestDetection: FrameDetection;
}

interface CodeTrackState {
  status: "LOCKED" | "REARMED";
  lastSeenSec: number;
  lastCenter: [number, number];
  lockedSceneSig: number[];
  maxSceneDeltaWhileAbsent: number;
  otherCodeConfirmedSinceLock: boolean;
}

interface UndoEntry {
  rowId: string;
  snapshotId: string;
  wasNewRow: boolean;
  label: string;
}

export interface FrameProcessOutcome {
  rows: InventoryRow[];
  hud: HudBannerState;
  event: "none" | "new_scan" | "duplicate_scan";
  activeLockedId: string | null;
  canUndo: boolean;
}

export function formatSeconds(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

export function humanizeSource(src: string): string {
  if (src === "barcode+ocr") return "Streckkod + Text";
  if (src.startsWith("barcode:")) {
    const fmt = src.slice("barcode:".length).trim();
    return fmt ? `Streckkod (${fmt})` : "Streckkod";
  }
  if (src.startsWith("barcode")) return "Streckkod";
  if (src === "manual") return "Manuell";
  return "OCR Text";
}

function computeSceneDelta(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 25;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / a.length;
}

function bboxCenter(bbox: [number, number, number, number]): [number, number] {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

function extractDigitCount(canonicalId: string): number {
  const m = canonicalId.match(/\d+/);
  return m ? m[0].length : 0;
}

function hammingDistanceSameLength(a: string, b: string): number {
  if (a.length !== b.length) return 99;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff;
}

function getThresholds(mode: SensitivityMode): {
  fastPanAbsenceSec: number;
  normalAbsenceSec: number;
  minSceneDelta: number;
  jumpDist: number;
} {
  switch (mode) {
    case "fast":
      return {
        fastPanAbsenceSec: 0.3,
        normalAbsenceSec: 0.55,
        minSceneDelta: 5.0,
        jumpDist: 0.3,
      };
    case "strict":
      return {
        fastPanAbsenceSec: 0.9,
        normalAbsenceSec: 1.55,
        minSceneDelta: 9.2,
        jumpDist: 0.42,
      };
    case "standard":
    default:
      return {
        fastPanAbsenceSec: 0.45,
        normalAbsenceSec: 0.8,
        minSceneDelta: 6.2,
        jumpDist: 0.34,
      };
  }
}

export class InventorySessionTracker {
  private rowsMap: Map<string, InventoryRow> = new Map();
  private pendingOcr: Map<string, PendingOcrCandidate> = new Map();
  private trackStates: Map<string, CodeTrackState> = new Map();
  private customerMemory: Map<string, string> = new Map();
  private undoStack: UndoEntry[] = [];
  private activeLockedId: string | null = null;
  private lastBannerHoldUntilSec = -1;
  private lastHeldBanner: HudBannerState | null = null;
  private prevFrameSig: number[] = [];

  public reset(): void {
    this.rowsMap.clear();
    this.pendingOcr.clear();
    this.trackStates.clear();
    this.customerMemory.clear();
    this.undoStack = [];
    this.activeLockedId = null;
    this.lastBannerHoldUntilSec = -1;
    this.lastHeldBanner = null;
    this.prevFrameSig = [];
  }

  public getRows(): InventoryRow[] {
    return Array.from(this.rowsMap.values()).sort(
      (a, b) => b.lastUpdatedTs - a.lastUpdatedTs
    );
  }

  public setRowsFromExternal(rows: InventoryRow[]): void {
    this.rowsMap.clear();
    for (const r of rows) {
      this.rowsMap.set(r.id, r);
      if (r.customer && r.customer !== "Okänd kund") {
        this.customerMemory.set(r.id, r.customer);
      }
    }
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public getActiveLockedId(): string | null {
    return this.activeLockedId;
  }

  public undoLast(): { undoneLabel: string | null; rows: InventoryRow[] } {
    const last = this.undoStack.pop();
    if (!last) {
      return { undoneLabel: null, rows: this.getRows() };
    }
    const row = this.rowsMap.get(last.rowId);
    if (row) {
      if (last.wasNewRow || row.count <= 1) {
        this.rowsMap.delete(last.rowId);
        this.trackStates.delete(last.rowId);
        if (this.activeLockedId === last.rowId) {
          this.activeLockedId = null;
        }
      } else {
        row.count = Math.max(1, row.count - 1);
        row.snapshots = row.snapshots.filter((s) => s.id !== last.snapshotId);
        row.lastUpdatedTs = Date.now();
        const st = this.trackStates.get(last.rowId);
        if (st) {
          st.status = "REARMED";
        }
      }
    }
    return { undoneLabel: last.label, rows: this.getRows() };
  }

  public manualIncrementLocked(timestampSec: number): {
    addedRow: InventoryRow | null;
    rows: InventoryRow[];
  } {
    const targetId =
      this.activeLockedId ||
      (this.rowsMap.size > 0 ? this.getRows()[0].id : null);
    if (!targetId) return { addedRow: null, rows: this.getRows() };

    const row = this.rowsMap.get(targetId);
    if (!row) return { addedRow: null, rows: this.getRows() };

    const snapId = `${targetId}-manual-${Date.now()}`;
    const lastThumb =
      row.snapshots.length > 0
        ? row.snapshots[row.snapshots.length - 1].thumbnail
        : "";
    const snap: ScanSnapshot = {
      id: snapId,
      timestampSec,
      formattedTime: formatSeconds(timestampSec),
      source: "Manuell +1",
      confidence: 1,
      thumbnail: lastThumb,
      customerDetected: row.customer,
    };
    row.count += 1;
    row.snapshots = [...row.snapshots, snap];
    row.lastUpdatedTs = Date.now();

    this.undoStack.push({
      rowId: row.id,
      snapshotId: snapId,
      wasNewRow: false,
      label: `${row.customer} • ${row.numberTitle}`,
    });

    return { addedRow: { ...row }, rows: this.getRows() };
  }

  public processFrame(
    frame: AnalyzeFrameResponse,
    timestampSec: number,
    sensitivity: SensitivityMode,
    defaultCustomer = ""
  ): FrameProcessOutcome {
    const {
      fastPanAbsenceSec,
      normalAbsenceSec,
      minSceneDelta,
      jumpDist,
    } = getThresholds(sensitivity);
    const sceneSig = frame.scene_signature || [];
    const stepDelta =
      this.prevFrameSig.length > 0
        ? computeSceneDelta(sceneSig, this.prevFrameSig)
        : 0;
    this.prevFrameSig = sceneSig;

    for (const [cid, cand] of this.pendingOcr.entries()) {
      if (timestampSec - cand.lastTs > 3.5) {
        this.pendingOcr.delete(cid);
      }
    }

    const visibleCleanIds = new Set(
      frame.detections
        .filter((d) => !d.edge_clipped || d.source.startsWith("barcode"))
        .map((d) => d.canonical_id)
    );

    // 1. Update absence & scene-change rearming for locked codes
    for (const [cid, st] of this.trackStates.entries()) {
      if (!visibleCleanIds.has(cid)) {
        const deltaFromLock = computeSceneDelta(sceneSig, st.lockedSceneSig);
        st.maxSceneDeltaWhileAbsent = Math.max(
          st.maxSceneDeltaWhileAbsent,
          deltaFromLock,
          stepDelta
        );
        const absentFor = timestampSec - st.lastSeenSec;

        const rearmByInterveningCode =
          st.otherCodeConfirmedSinceLock && absentFor >= 0.25;
        const rearmByFastPan =
          absentFor >= fastPanAbsenceSec &&
          st.maxSceneDeltaWhileAbsent >= 16.5;
        const rearmByNormalPan =
          absentFor >= normalAbsenceSec &&
          st.maxSceneDeltaWhileAbsent >= minSceneDelta;
        const rearmByLongAbsence =
          absentFor >= normalAbsenceSec * 2.0 &&
          st.maxSceneDeltaWhileAbsent >= 3.5;

        if (
          st.status === "LOCKED" &&
          (rearmByInterveningCode ||
            rearmByFastPan ||
            rearmByNormalPan ||
            rearmByLongAbsence)
        ) {
          st.status = "REARMED";
          if (this.activeLockedId === cid) {
            this.activeLockedId = null;
          }
        }
      } else {
        const matchingDet = frame.detections.find(
          (d) => d.canonical_id === cid && !d.edge_clipped
        );
        if (matchingDet && st.status === "LOCKED") {
          const [cx, cy] = bboxCenter(matchingDet.bbox);
          const dist = Math.hypot(
            cx - st.lastCenter[0],
            cy - st.lastCenter[1]
          );
          if (dist >= jumpDist && stepDelta >= 20.0) {
            st.status = "REARMED";
          }
        }
      }
    }

    // 2. Evaluate detections in current frame
    const confirmedDetections: FrameDetection[] = [];
    let verifyingCandidate: FrameDetection | null = null;
    let clippedWarning: FrameDetection | null = null;

    // Filter out substrings if a longer superstring is already detected in the SAME frame
    const frameIds = frame.detections.map((d) => d.canonical_id);

    for (const det of frame.detections) {
      if (det.customer && det.customer.trim()) {
        this.customerMemory.set(det.canonical_id, det.customer.trim());
      }

      if (
        frameIds.some(
          (other) => other !== det.canonical_id && other.includes(det.canonical_id)
        )
      ) {
        continue;
      }

      if (det.edge_clipped && !det.source.startsWith("barcode")) {
        clippedWarning = det;
        continue;
      }

      if (det.source.startsWith("barcode")) {
        confirmedDetections.push(det);
        this.pendingOcr.delete(det.canonical_id);
        continue;
      }

      if (det.confidence < 0.48) {
        continue;
      }

      const existingTrack = this.trackStates.get(det.canonical_id);
      if (existingTrack && existingTrack.status === "LOCKED") {
        confirmedDetections.push(det);
        continue;
      }

      // Check if camera is still motionless on an ALREADY LOCKED box:
      // - Ignore shorter substring exit-blur (e.g., locked DEL0615244, exit frame reads DEL061524)
      // - Ignore low-confidence 1-digit motion blur on the exact same spot
      if (this.activeLockedId && this.activeLockedId !== det.canonical_id) {
        const activeTrack = this.trackStates.get(this.activeLockedId);
        if (activeTrack && activeTrack.status === "LOCKED") {
          const deltaFromActive = computeSceneDelta(
            sceneSig,
            activeTrack.lockedSceneSig
          );
          const [cx, cy] = bboxCenter(det.bbox);
          const distFromActive = Math.hypot(
            cx - activeTrack.lastCenter[0],
            cy - activeTrack.lastCenter[1]
          );

          if (deltaFromActive < 9.0 && distFromActive < 0.22) {
            // Substring of already locked code on same motionless label -> ignore
            if (this.activeLockedId.includes(det.canonical_id)) {
              continue;
            }
            // Low-confidence 1-char OCR jitter on motionless label -> require higher confidence / 2nd frame
            if (
              hammingDistanceSameLength(this.activeLockedId, det.canonical_id) === 1 &&
              det.confidence < 0.88
            ) {
              const pend = this.pendingOcr.get(det.canonical_id);
              if (!pend || pend.sightings < 2) {
                this.pendingOcr.set(det.canonical_id, {
                  canonicalId: det.canonical_id,
                  sightings: (pend?.sightings ?? 0) + 1,
                  firstTs: pend?.firstTs ?? timestampSec,
                  lastTs: timestampSec,
                  bestDetection: det,
                });
                continue;
              }
            }
          }
        }
      }

      // Instant 1-frame lock for clean >= 6-digit DEL/REM labels (like `del0615244`) on mobile!
      const digitCount = extractDigitCount(det.canonical_id);
      const canInstantLock =
        sensitivity !== "strict" &&
        digitCount >= 6 &&
        det.confidence >= 0.56 &&
        !det.edge_clipped;

      if (canInstantLock) {
        confirmedDetections.push(det);
        this.pendingOcr.delete(det.canonical_id);
        continue;
      }

      // Multi-frame confirmation for short codes or strict mode
      const prevPend = this.pendingOcr.get(det.canonical_id);
      if (!prevPend) {
        this.pendingOcr.set(det.canonical_id, {
          canonicalId: det.canonical_id,
          sightings: 1,
          firstTs: timestampSec,
          lastTs: timestampSec,
          bestDetection: det,
        });
        verifyingCandidate = det;
      } else {
        const dt = timestampSec - prevPend.firstTs;
        prevPend.sightings += 1;
        prevPend.lastTs = timestampSec;
        if (det.confidence >= prevPend.bestDetection.confidence) {
          prevPend.bestDetection = det;
        } else if (!det.customer && prevPend.bestDetection.customer) {
          det.customer = prevPend.bestDetection.customer;
        }

        const hasSuperstringPending = Array.from(this.pendingOcr.keys()).some(
          (other) =>
            other !== det.canonical_id && other.includes(det.canonical_id)
        );

        if (!hasSuperstringPending && prevPend.sightings >= 2 && dt >= 0.05) {
          confirmedDetections.push(det);
          this.pendingOcr.delete(det.canonical_id);
        } else {
          verifyingCandidate = prevPend.bestDetection;
        }
      }
    }

    // 3. Apply confirmed detections to session inventory & state machine
    let outcomeEvent: "none" | "new_scan" | "duplicate_scan" = "none";
    let hudBanner: HudBannerState | null = null;

    for (const det of confirmedDetections) {
      let cid = det.canonical_id;
      // If barcode only encoded the numeric tail (e.g. "0615244") and "DEL0615244" is already tracked, merge into "DEL0615244"!
      if (/^\d{4,16}$/.test(cid) && !this.rowsMap.has(cid)) {
        for (const knownKey of this.rowsMap.keys()) {
          if (
            /^(?:DEL|DLV|REM|RMV|RET)/.test(knownKey) &&
            knownKey.endsWith(cid)
          ) {
            cid = knownKey;
            break;
          }
        }
      }
      const center = bboxCenter(det.bbox);
      const rememberedCustomer = this.customerMemory.get(cid) || "";
      const fallbackCust = defaultCustomer.trim() || "Okänd kund";
      const resolvedCustomer =
        (det.customer && det.customer.trim()) ||
        rememberedCustomer ||
        fallbackCust;

      if (resolvedCustomer !== "Okänd kund") {
        this.customerMemory.set(cid, resolvedCustomer);
      }

      // Check for Same-Box Superstring Upgrade (e.g. Frame 1 locked DEL061524, Frame 2 on same motionless box sees DEL0615244)
      if (
        !this.rowsMap.has(cid) &&
        this.activeLockedId &&
        cid.includes(this.activeLockedId) &&
        cid !== this.activeLockedId
      ) {
        const prevRow = this.rowsMap.get(this.activeLockedId);
        const prevTrack = this.trackStates.get(this.activeLockedId);
        if (prevRow && prevTrack && prevRow.count === 1) {
          const deltaFromPrev = computeSceneDelta(
            sceneSig,
            prevTrack.lockedSceneSig
          );
          const distFromPrev = Math.hypot(
            center[0] - prevTrack.lastCenter[0],
            center[1] - prevTrack.lastCenter[1]
          );
          if (deltaFromPrev < 10.5 && distFromPrev < 0.25) {
            const oldId = this.activeLockedId;
            this.rowsMap.delete(oldId);
            this.trackStates.delete(oldId);

            const upgradedRow: InventoryRow = {
              ...prevRow,
              id: cid,
              customer:
                prevRow.customer !== "Okänd kund"
                  ? prevRow.customer
                  : resolvedCustomer,
              category: det.category,
              numberTitle: det.display_title,
              numberUpper: det.display_upper,
              verifiedBy: humanizeSource(det.source),
              lastUpdatedTs: Date.now(),
            };
            this.rowsMap.set(cid, upgradedRow);
            this.trackStates.set(cid, {
              ...prevTrack,
              lastSeenSec: timestampSec,
              lastCenter: center,
            });
            this.activeLockedId = cid;
            for (const u of this.undoStack) {
              if (u.rowId === oldId) {
                u.rowId = cid;
                u.label = `${upgradedRow.customer} • ${det.display_title}`;
              }
            }
            hudBanner = {
              kind: "locked_new",
              title: `Registrerad: ${det.display_title} (${det.category})`,
              subtitle: `Kund: ${upgradedRow.customer} • Antal: 1 — flytta kameran till nästa etikett`,
              canonicalId: cid,
            };
            this.lastHeldBanner = hudBanner;
            this.lastBannerHoldUntilSec = timestampSec + 1.5;
            continue;
          }
        }
      }

      const existingRow = this.rowsMap.get(cid);
      const track = this.trackStates.get(cid);

      if (!existingRow || !track) {
        const snapId = `${cid}-1-${Date.now()}`;
        const snap: ScanSnapshot = {
          id: snapId,
          timestampSec,
          formattedTime: formatSeconds(timestampSec),
          source: humanizeSource(det.source),
          confidence: det.confidence,
          thumbnail: det.thumbnail,
          customerDetected: resolvedCustomer,
        };

        const newRow: InventoryRow = {
          id: cid,
          customer: resolvedCustomer,
          category: det.category,
          numberTitle: det.display_title,
          numberUpper: det.display_upper,
          count: 1,
          firstSeen: formatSeconds(timestampSec),
          verifiedBy: humanizeSource(det.source),
          snapshots: [snap],
          lastUpdatedTs: Date.now(),
        };

        this.rowsMap.set(cid, newRow);
        this.trackStates.set(cid, {
          status: "LOCKED",
          lastSeenSec: timestampSec,
          lastCenter: center,
          lockedSceneSig: sceneSig,
          maxSceneDeltaWhileAbsent: 0,
          otherCodeConfirmedSinceLock: false,
        });
        this.markOtherCodesIntervened(cid);
        this.activeLockedId = cid;
        this.undoStack.push({
          rowId: cid,
          snapshotId: snapId,
          wasNewRow: true,
          label: `${resolvedCustomer} • ${det.display_title}`,
        });

        outcomeEvent = "new_scan";
        hudBanner = {
          kind: "locked_new",
          title: `✓ Registrerad: ${det.display_title} (${det.category})`,
          subtitle: `Kund: ${resolvedCustomer} • Antal: 1 — flytta kameran till nästa etikett`,
          canonicalId: cid,
        };
        this.lastHeldBanner = hudBanner;
        this.lastBannerHoldUntilSec = timestampSec + 1.6;
      } else if (track.status === "LOCKED") {
        track.lastSeenSec = timestampSec;
        track.lastCenter = center;
        track.maxSceneDeltaWhileAbsent = 0;
        this.activeLockedId = cid;

        if (
          existingRow.customer === "Okänd kund" &&
          resolvedCustomer !== "Okänd kund"
        ) {
          existingRow.customer = resolvedCustomer;
          existingRow.lastUpdatedTs = Date.now();
        }
        if (
          det.source === "barcode+ocr" &&
          existingRow.verifiedBy !== "Streckkod + Text"
        ) {
          existingRow.verifiedBy = "Streckkod + Text";
        }
        const lastSnap =
          existingRow.snapshots[existingRow.snapshots.length - 1];
        if (lastSnap && !lastSnap.thumbnail && det.thumbnail) {
          lastSnap.thumbnail = det.thumbnail;
        }

        if (!hudBanner) {
          hudBanner = {
            kind: "locked_hold",
            title: `Låst på etikett: ${existingRow.numberTitle} (Antal: ${existingRow.count})`,
            subtitle: `Kund: ${existingRow.customer} • Flytta kameran till nästa låda/etikett`,
            canonicalId: cid,
          };
        }
      } else if (track.status === "REARMED") {
        const nextCount = existingRow.count + 1;
        const snapId = `${cid}-${nextCount}-${Date.now()}`;
        const snap: ScanSnapshot = {
          id: snapId,
          timestampSec,
          formattedTime: formatSeconds(timestampSec),
          source: humanizeSource(det.source),
          confidence: det.confidence,
          thumbnail: det.thumbnail,
          customerDetected: resolvedCustomer,
        };

        if (
          existingRow.customer === "Okänd kund" &&
          resolvedCustomer !== "Okänd kund"
        ) {
          existingRow.customer = resolvedCustomer;
        }
        if (det.source === "barcode+ocr") {
          existingRow.verifiedBy = "Streckkod + Text";
        }

        existingRow.count = nextCount;
        existingRow.snapshots = [...existingRow.snapshots, snap];
        existingRow.lastUpdatedTs = Date.now();

        track.status = "LOCKED";
        track.lastSeenSec = timestampSec;
        track.lastCenter = center;
        track.lockedSceneSig = sceneSig;
        track.maxSceneDeltaWhileAbsent = 0;
        track.otherCodeConfirmedSinceLock = false;

        this.markOtherCodesIntervened(cid);
        this.activeLockedId = cid;
        this.undoStack.push({
          rowId: cid,
          snapshotId: snapId,
          wasNewRow: false,
          label: `${existingRow.customer} • ${existingRow.numberTitle} (+1)`,
        });

        outcomeEvent = "duplicate_scan";
        hudBanner = {
          kind: "duplicate_added",
          title: `✓ +1 Likadan etikett! ${existingRow.numberTitle} → Antal: ${nextCount}`,
          subtitle: `Kund: ${existingRow.customer} • ${existingRow.category}`,
          canonicalId: cid,
        };
        this.lastHeldBanner = hudBanner;
        this.lastBannerHoldUntilSec = timestampSec + 1.8;
      }
    }

    if (!hudBanner) {
      if (
        this.lastHeldBanner &&
        timestampSec <= this.lastBannerHoldUntilSec
      ) {
        hudBanner = this.lastHeldBanner;
      } else if (verifyingCandidate) {
        hudBanner = {
          kind: "verifying",
          title: `Läser: ${verifyingCandidate.display_title}...`,
          subtitle: "Håll kameran stadigt ett ögonblick",
          canonicalId: verifyingCandidate.canonical_id,
        };
      } else if (clippedWarning) {
        hudBanner = {
          kind: "edge_warning",
          title: "Etiketten är nära bildkanten",
          subtitle: "Centrera numret i gröna rutan så alla siffror syns",
        };
      } else {
        hudBanner = {
          kind: "idle",
          title: "Spelar in & söker etiketter...",
          subtitle:
            "Rikta kameran mot del.../rem...-nummer eller streckkod",
        };
      }
    }

    return {
      rows: this.getRows(),
      hud: hudBanner,
      event: outcomeEvent,
      activeLockedId: this.activeLockedId,
      canUndo: this.canUndo(),
    };
  }

  private markOtherCodesIntervened(currentCid: string): void {
    for (const [cid, st] of this.trackStates.entries()) {
      if (cid !== currentCid) {
        st.otherCodeConfirmedSinceLock = true;
      }
    }
  }
}
