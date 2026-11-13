import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  Camera,
  CheckCircle2,
  Download,
  Eye,
  FileSpreadsheet,
  Film,
  Flashlight,
  Loader2,
  Play,
  Plus,
  QrCode,
  ScanLine,
  ShieldCheck,
  Smartphone,
  Square,
  Undo2,
  Upload,
  Volume2,
  VolumeX,
} from "lucide-react";
import { CustomerModal } from "./components/CustomerModal";
import { ReviewAndExportView } from "./components/ReviewAndExportView";
import { TestLabelsModal } from "./components/TestLabelsModal";
import {
  DEMO_TOTAL_DURATION_SEC,
  DemoWarehouseRenderer,
} from "./lib/demoWarehouseRenderer";
import { DEFAULT_CUSTOMERS_LIST } from "./lib/labelParser";
import {
  analyzeFrameLocally,
  LocalEngineStatus,
  scanBarcodesFastLocally,
  subscribeLocalOcrStatus,
  warmupLocalScanner,
} from "./lib/localScannerFallback";
import {
  formatSeconds,
  InventorySessionTracker,
} from "./lib/sessionTracker";
import { soundEngine } from "./lib/sound";
import { buildInventoryXlsxClientBytes } from "./lib/xlsxClientBuilder";
import {
  AnalyzeFrameResponse,
  FrameDetection,
  HudBannerState,
  InventoryRow,
  PackageCategory,
  SensitivityMode,
} from "./types";

type InputMode = "camera" | "upload" | "demo";
type MainTab = "scan" | "review";

const FOCUS_BOX: [number, number, number, number] = [0.06, 0.15, 0.94, 0.85];

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<MainTab>("scan");
  const [inputMode, setInputMode] = useState<InputMode>("camera");

  // Session inventory state
  const trackerRef = useRef<InventorySessionTracker>(
    new InventorySessionTracker()
  );
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [activeLockedId, setActiveLockedId] = useState<string | null>(null);
  const [justFinishedVideo, setJustFinishedVideo] = useState(false);

  // Scanner settings — autoDownloadOnStop is TRUE by default so stopping video saves Excel immediately!
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [sensitivity, setSensitivity] = useState<SensitivityMode>("standard");
  const [defaultCustomer, setDefaultCustomer] = useState("");
  const [knownCustomers, setKnownCustomers] = useState<string[]>(
    DEFAULT_CUSTOMERS_LIST
  );
  const backendAvailableRef = useRef<boolean | null>(null);
  const [localOcrStatus, setLocalOcrStatus] =
    useState<LocalEngineStatus>("idle");
  const [numberFormat, setNumberFormat] = useState<"title" | "upper">("title");
  const [columnMode, setColumnMode] = useState<
    "standard_4col" | "combined_category"
  >("standard_4col");
  const [autoDownloadOnStop, setAutoDownloadOnStop] = useState(true);
  const [acceptAllBarcodes, setAcceptAllBarcodes] = useState(true);
  const [defaultBarcodeCategory, setDefaultBarcodeCategory] =
    useState<PackageCategory>("Delivery");
  const [cameraZoom, setCameraZoom] = useState<number>(1);
  const [hardwareZoomActive, setHardwareZoomActive] = useState(false);

  // Modals & notifications
  const [showCustomersModal, setShowCustomersModal] = useState(false);
  const [showTestLabelsModal, setShowTestLabelsModal] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  // Live filming / playback runtime state
  const [isFilming, setIsFilming] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [videoDurationSec, setVideoDurationSec] = useState(0);
  const [videoProgress, setVideoProgress] = useState(0);
  const [uploadPreviewSrc, setUploadPreviewSrc] = useState<string>("");
  const [liveDetections, setLiveDetections] = useState<FrameDetection[]>([]);
  const [liveRawText, setLiveRawText] = useState<string>("");
  const [scanFlash, setScanFlash] = useState<"none" | "new" | "dup">("none");
  const [lastSavedLabel, setLastSavedLabel] = useState<string>("");
  const [sharpnessScore, setSharpnessScore] = useState<number>(0);
  const [hudBanner, setHudBanner] = useState<HudBannerState>({
    kind: "idle",
    title: "Redo att spela in & skanna etiketter",
    subtitle:
      "Läser del.../rem...-nummer (t.ex. del0615244), streckkoder och kundnamn direkt i mobilen",
  });

  // Refs for media & loops
  const viewfinderRef = useRef<HTMLDivElement | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const barcodeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const demoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const isFilmingRef = useRef(false);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const demoRafRef = useRef<number | null>(null);
  const startTimeMsRef = useRef<number>(0);

  // Keep latest settings accessible inside async loops
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const sensitivityRef = useRef(sensitivity);
  sensitivityRef.current = sensitivity;
  const defaultCustomerRef = useRef(defaultCustomer);
  defaultCustomerRef.current = defaultCustomer;
  const knownCustomersRef = useRef(knownCustomers);
  knownCustomersRef.current = knownCustomers;
  const autoDownloadRef = useRef(autoDownloadOnStop);
  autoDownloadRef.current = autoDownloadOnStop;
  const acceptAllBarcodesRef = useRef(acceptAllBarcodes);
  acceptAllBarcodesRef.current = acceptAllBarcodes;
  const defaultBarcodeCategoryRef = useRef(defaultBarcodeCategory);
  defaultBarcodeCategoryRef.current = defaultBarcodeCategory;
  const cameraZoomRef = useRef(cameraZoom);
  cameraZoomRef.current = cameraZoom;
  const hardwareZoomActiveRef = useRef(hardwareZoomActive);
  hardwareZoomActiveRef.current = hardwareZoomActive;

  const triggerToast = useCallback((msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3600);
  }, []);

  // Load saved customer dictionary & pre-warm local WASM OCR engine on mount
  useEffect(() => {
    const unsub = subscribeLocalOcrStatus((st) => setLocalOcrStatus(st));
    warmupLocalScanner();

    try {
      const savedLocal = window.localStorage?.getItem("lagerscan_customers");
      if (savedLocal) {
        const parsed = JSON.parse(savedLocal);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setKnownCustomers(parsed);
        }
      }
    } catch {
      // Sandboxed iframe without localStorage; default list already active
    }

    fetch("/api/customers")
      .then((r) => {
        if (!r.ok) throw new Error("offline");
        backendAvailableRef.current = true;
        return r.json();
      })
      .then((data) => {
        if (Array.isArray(data.customers) && data.customers.length > 0) {
          setKnownCustomers(data.customers);
        }
      })
      .catch(() => {
        backendAvailableRef.current = false;
      });

    return () => {
      unsub();
    };
  }, []);

  const handleSaveCustomers = async (updated: string[]) => {
    setKnownCustomers(updated);
    try {
      window.localStorage?.setItem(
        "lagerscan_customers",
        JSON.stringify(updated)
      );
    } catch {
      // ignore in sandboxed iframe
    }
    try {
      if (backendAvailableRef.current !== false) {
        const res = await fetch("/api/customers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customers: updated }),
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.customers)) {
            setKnownCustomers(data.customers);
          }
        }
      }
    } catch {
      // saved locally
    }
    triggerToast(`Sparade kundlista (${updated.length} kunder)`);
  };

  const copyRowsForExcel = useCallback(() => {
    if (rows.length === 0) return;
    const sorted = [...rows].sort((a, b) => {
      const c = (a.customer || "Okänd kund").localeCompare(
        b.customer || "Okänd kund",
        "sv"
      );
      if (c !== 0) return c;
      if (a.category !== b.category) return a.category === "Delivery" ? -1 : 1;
      return a.numberUpper.localeCompare(b.numberUpper);
    });

    const lines: string[] = [];
    if (columnMode === "combined_category") {
      lines.push(["Kategorisering", "Kund", "Typ", "Nummer", "Antal"].join("\t"));
      for (const r of sorted) {
        const cust = r.customer?.trim() || "Okänd kund";
        const num = numberFormat === "upper" ? r.numberUpper : r.numberTitle;
        lines.push(
          [`Kund ${cust} ${r.category}`, cust, r.category, num, String(r.count)].join("\t")
        );
      }
    } else {
      lines.push(["Kund", "Kategori", "Nummer", "Antal"].join("\t"));
      for (const r of sorted) {
        const cust = r.customer?.trim() || "Okänd kund";
        const num = numberFormat === "upper" ? r.numberUpper : r.numberTitle;
        lines.push([cust, r.category, num, String(r.count)].join("\t"));
      }
    }

    const tsv = lines.join("\n");
    const fallbackCopy = () => {
      const ta = document.createElement("textarea");
      ta.value = tsv;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(tsv)
        .then(() =>
          triggerToast(
            "Tabellen kopierad! Öppna Excel och klistra in direkt."
          )
        )
        .catch(() => {
          fallbackCopy();
          triggerToast("Tabellen kopierad!");
        });
    } else {
      fallbackCopy();
      triggerToast("Tabellen kopierad!");
    }
  }, [columnMode, numberFormat, rows, triggerToast]);

  const generateExcelFilePayload = useCallback(
    async (
      targetRows: InventoryRow[]
    ): Promise<{ blob: Blob; filename: string }> => {
      const mappedItems = targetRows.map((r) => ({
        customer: r.customer?.trim() || "Okänd kund",
        category: r.category,
        number:
          numberFormat === "upper"
            ? r.numberUpper || r.id
            : r.numberTitle || r.id,
        count: r.count,
        first_seen: r.firstSeen,
        verified_by: r.verifiedBy,
      }));

      let blob: Blob | null = null;

      if (backendAvailableRef.current !== false) {
        try {
          const res = await fetch("/api/export-excel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items: mappedItems,
              number_format: numberFormat,
              column_mode: columnMode,
              include_metadata: false,
              session_title: "Videoinventering",
            }),
          });
          if (res.ok) {
            blob = await res.blob();
          }
        } catch {
          backendAvailableRef.current = false;
        }
      }

      if (!blob) {
        const xlsxBytes = buildInventoryXlsxClientBytes(
          mappedItems.map((m) => ({
            customer: m.customer,
            category: m.category,
            number: m.number,
            count: m.count,
          })),
          columnMode
        );
        blob = new Blob([xlsxBytes.buffer as ArrayBuffer], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
      }

      const now = new Date();
      const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
        2,
        "0"
      )}-${String(now.getDate()).padStart(2, "0")}_${String(
        now.getHours()
      ).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
      const filename = `Inventering_${stamp}.xlsx`;
      return { blob, filename };
    },
    [columnMode, numberFormat]
  );

  const downloadExcelForRows = useCallback(
    async (targetRows: InventoryRow[]) => {
      if (targetRows.length === 0) {
        triggerToast("Inga paket att spara ännu.");
        return;
      }
      setIsDownloading(true);
      try {
        const { blob, filename } = await generateExcelFilePayload(targetRows);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 12000);
        triggerToast(`Excel-fil sparad: ${filename}`);
      } catch (err) {
        triggerToast(
          err instanceof Error ? err.message : "Fel vid export till Excel"
        );
      } finally {
        setIsDownloading(false);
      }
    },
    [generateExcelFilePayload, triggerToast]
  );

  // Native iOS Safari / Android Share Sheet ("Spara i Filer", Mail, Teams, WhatsApp)
  const shareExcelOnMobile = useCallback(async () => {
    if (rows.length === 0) return;
    setIsDownloading(true);
    try {
      const { blob, filename } = await generateExcelFilePayload(rows);
      const file = new File([blob], filename, {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const nav = navigator as Navigator & {
        canShare?: (data?: ShareData) => boolean;
      };
      if (nav.share && (!nav.canShare || nav.canShare({ files: [file] }))) {
        await nav.share({
          title: filename,
          text: `Lagerinventering (${rows.reduce((s, r) => s + r.count, 0)} paket)`,
          files: [file],
        });
        triggerToast("Excel-fil delad/sparad!");
      } else {
        await downloadExcelForRows(rows);
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        await downloadExcelForRows(rows);
      }
    } finally {
      setIsDownloading(false);
    }
  }, [downloadExcelForRows, generateExcelFilePayload, rows, triggerToast]);

  // Stop all media streams cleanly
  const stopAllStreamsOnly = useCallback(() => {
    isFilmingRef.current = false;
    setIsFilming(false);
    setLiveDetections([]);
    setLiveRawText("");
    setTorchOn(false);
    setTorchSupported(false);

    if (uploadAbortRef.current) {
      uploadAbortRef.current.abort();
      uploadAbortRef.current = null;
    }
    if (demoRafRef.current !== null) {
      cancelAnimationFrame(demoRafRef.current);
      demoRafRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (videoElRef.current) {
      videoElRef.current.srcObject = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopAllStreamsOnly();
    };
  }, [stopAllStreamsOnly]);

  // Called when user stops video OR when uploaded/demo video finishes
  const finishVideoAndOpenReview = useCallback(() => {
    stopAllStreamsOnly();
    const latestRows = trackerRef.current.getRows();
    setRows(latestRows);
    setJustFinishedVideo(true);
    setActiveTab("review");
    if (latestRows.length > 0) {
      if (autoDownloadRef.current) {
        downloadExcelForRows(latestRows);
      }
    } else {
      triggerToast(
        "Inga del.../rem...-nummer registrerades i videon. Håll etiketten i gröna rutan tills det piper grönt!"
      );
    }
  }, [downloadExcelForRows, stopAllStreamsOnly, triggerToast]);

  const applyAnalyzedFrame = useCallback(
    (analysis: AnalyzeFrameResponse, tsSec: number) => {
      setSharpnessScore(analysis.sharpness || 0);
      setLiveDetections(analysis.detections || []);
      if (analysis.raw_text_preview) {
        setLiveRawText(analysis.raw_text_preview);
      } else if (analysis.ocr_regions && analysis.ocr_regions.length > 0) {
        setLiveRawText(
          analysis.ocr_regions
            .slice(0, 3)
            .map((r) => r.text)
            .join(" · ")
        );
      }

      const outcome = trackerRef.current.processFrame(
        analysis,
        tsSec,
        sensitivityRef.current,
        defaultCustomerRef.current
      );

      setRows(outcome.rows);
      setHudBanner(outcome.hud);
      setActiveLockedId(outcome.activeLockedId);
      setCanUndo(outcome.canUndo);

      if (outcome.event === "new_scan") {
        soundEngine.playNewScan(soundEnabledRef.current);
        try {
          navigator.vibrate?.(70);
        } catch {
          // ignore
        }
        const topRow = outcome.rows[0];
        if (topRow) {
          setLastSavedLabel(
            `${topRow.numberTitle} (${topRow.count} st)`
          );
        }
        setScanFlash("new");
        window.setTimeout(() => setScanFlash("none"), 500);
      } else if (outcome.event === "duplicate_scan") {
        soundEngine.playDuplicateScan(soundEnabledRef.current);
        try {
          navigator.vibrate?.([60, 50, 80]);
        } catch {
          // ignore
        }
        const topRow = outcome.rows[0];
        if (topRow) {
          setLastSavedLabel(
            `+1 ${topRow.numberTitle} (${topRow.count} st)`
          );
        }
        setScanFlash("dup");
        window.setTimeout(() => setScanFlash("none"), 550);
      }
    },
    []
  );

  /**
   * Draws `<video>` onto `canvas` using the exact `object-cover` crop displayed
   * inside `viewfinderRef` (plus center sensor zoom when hardware zoom isn't active)
   * so thin 1D barcode bars stay razor-sharp at native camera resolution!
   */
  const drawVideoObjectCoverToCanvas = (
    vid: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    maxTargetW = 1600
  ): boolean => {
    const vw = vid.videoWidth;
    const vh = vid.videoHeight;
    if (!vw || !vh) return false;

    const vf = viewfinderRef.current;
    const boxAspect =
      vf && vf.clientWidth > 0 && vf.clientHeight > 0
        ? vf.clientWidth / vf.clientHeight
        : 4 / 3;
    const vidAspect = vw / vh;

    let sx = 0;
    let sy = 0;
    let sw = vw;
    let sh = vh;

    if (vidAspect > boxAspect) {
      sw = Math.round(vh * boxAspect);
      sx = Math.round((vw - sw) / 2);
    } else {
      sh = Math.round(vw / boxAspect);
      sy = Math.round((vh - sh) / 2);
    }

    // Apply lossless center-sensor crop zoom if digital zoom fallback is active
    const softZoom = hardwareZoomActiveRef.current
      ? 1
      : Math.max(1, cameraZoomRef.current);
    if (softZoom > 1.01) {
      const zw = Math.round(sw / softZoom);
      const zh = Math.round(sh / softZoom);
      sx = sx + Math.round((sw - zw) / 2);
      sy = sy + Math.round((sh - zh) / 2);
      sw = Math.max(160, zw);
      sh = Math.max(120, zh);
    }

    const scale = sw > maxTargetW ? maxTargetW / sw : 1.0;
    canvas.width = Math.max(320, Math.round(sw * scale));
    canvas.height = Math.max(240, Math.round(sh * scale));

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.drawImage(vid, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return true;
  };

  const applyCameraZoom = async (targetZoom: number) => {
    setCameraZoom(targetZoom);
    cameraZoomRef.current = targetZoom;
    const stream = mediaStreamRef.current;
    const track = stream?.getVideoTracks()?.[0];
    if (!track || !("getCapabilities" in track)) {
      setHardwareZoomActive(false);
      return;
    }
    try {
      const caps = track.getCapabilities() as MediaTrackCapabilities & {
        zoom?: { min: number; max: number };
      };
      if (caps?.zoom && typeof caps.zoom.max === "number" && caps.zoom.max > 1) {
        const clamped = Math.min(
          caps.zoom.max,
          Math.max(caps.zoom.min ?? 1, targetZoom)
        );
        await track.applyConstraints({
          advanced: [{ zoom: clamped } as unknown as MediaTrackConstraintSet],
        });
        setHardwareZoomActive(true);
        hardwareZoomActiveRef.current = true;
        return;
      }
    } catch {
      // Fall back to center-sensor crop zoom
    }
    setHardwareZoomActive(false);
    hardwareZoomActiveRef.current = false;
  };

  // -------------------------------------------------------------------------
  // MODE 1: LIVE CAMERA (16 FPS Full-HD ZXing-WASM Barcode + Parallel OCR)
  // -------------------------------------------------------------------------
  const startLiveCamera = async () => {
    soundEngine.unlock();
    warmupLocalScanner();
    setCameraError(null);
    stopAllStreamsOnly();
    setInputMode("camera");
    setHardwareZoomActive(false);
    hardwareZoomActiveRef.current = false;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError(
        "Direktkameran kunde inte startas i denna vy. Använd knappen 'Filma med mobilens kameraapp' nedan eller öppna sidan via HTTPS!"
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      mediaStreamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      if (track) {
        if ("getCapabilities" in track) {
          const caps = track.getCapabilities() as MediaTrackCapabilities & {
            torch?: boolean;
            focusMode?: string[];
            zoom?: { min: number; max: number };
          };
          if (caps?.torch) {
            setTorchSupported(true);
          }
          if (caps?.focusMode && caps.focusMode.includes("continuous")) {
            try {
              await track.applyConstraints({
                advanced: [
                  { focusMode: "continuous" } as unknown as MediaTrackConstraintSet,
                ],
              });
            } catch {
              // autofocus already managed by OS
            }
          }
          if (cameraZoomRef.current > 1 && caps?.zoom && caps.zoom.max > 1) {
            try {
              const clamped = Math.min(caps.zoom.max, cameraZoomRef.current);
              await track.applyConstraints({
                advanced: [{ zoom: clamped } as unknown as MediaTrackConstraintSet],
              });
              setHardwareZoomActive(true);
              hardwareZoomActiveRef.current = true;
            } catch {
              // fallback to sensor crop
            }
          }
        }
      }

      if (videoElRef.current) {
        videoElRef.current.srcObject = stream;
        await videoElRef.current.play();
      }

      isFilmingRef.current = true;
      setIsFilming(true);
      setJustFinishedVideo(false);
      startTimeMsRef.current = performance.now();
      setElapsedSec(0);
      setHudBanner({
        kind: "idle",
        title: "● SPELAR IN – Rikta mot streckkod eller del.../rem...",
        subtitle:
          "Tips: Använd 1.5x / 2x zoom och håll mobilen ~20 cm från streckkoden för knivskarp fokus!",
      });

      // LOOP A: High-Speed 16 FPS Full-HD Barcode Scanner (never blocked by OCR!)
      const runFastBarcodeLoop = async () => {
        while (isFilmingRef.current && videoElRef.current) {
          const vid = videoElRef.current;
          const nowSec = (performance.now() - startTimeMsRef.current) / 1000;
          setElapsedSec(nowSec);

          if (vid.readyState >= 2 && vid.videoWidth > 0) {
            const bcCanvas =
              barcodeCanvasRef.current || document.createElement("canvas");
            barcodeCanvasRef.current = bcCanvas;

            // Keep full 1920px sharpness so thin 1D Code128/Code39/EAN bars never blur!
            if (drawVideoObjectCoverToCanvas(vid, bcCanvas, 1920)) {
              const fastRes = await scanBarcodesFastLocally(
                bcCanvas,
                knownCustomersRef.current,
                {
                  acceptAllBarcodes: acceptAllBarcodesRef.current,
                  defaultCategory: defaultBarcodeCategoryRef.current,
                }
              );
              if (
                isFilmingRef.current &&
                (fastRes.detections.length > 0 || fastRes.raw_text_preview)
              ) {
                const frameTs =
                  (performance.now() - startTimeMsRef.current) / 1000;
                applyAnalyzedFrame(fastRes, frameTs);
              }
            }
          }
          await new Promise((r) => setTimeout(r, 55));
        }
      };

      // LOOP B: Parallel Non-Blocking OCR Scanner for printed `del0615244` & customer text
      const runBackgroundOcrLoop = async () => {
        while (isFilmingRef.current && videoElRef.current) {
          const vid = videoElRef.current;
          if (vid.readyState >= 2 && vid.videoWidth > 0) {
            const ocrCanvas =
              captureCanvasRef.current || document.createElement("canvas");
            captureCanvasRef.current = ocrCanvas;

            if (drawVideoObjectCoverToCanvas(vid, ocrCanvas, 1080)) {
              let handledByBackend = false;
              if (backendAvailableRef.current !== false) {
                try {
                  const dataUrl = ocrCanvas.toDataURL("image/jpeg", 0.84);
                  const res = await fetch("/api/analyze-frame", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      image_base64: dataUrl,
                      known_customers: knownCustomersRef.current,
                      default_customer: defaultCustomerRef.current,
                    }),
                  });
                  if (res.ok && isFilmingRef.current) {
                    const data: AnalyzeFrameResponse = await res.json();
                    const frameTs =
                      (performance.now() - startTimeMsRef.current) / 1000;
                    applyAnalyzedFrame(data, frameTs);
                    handledByBackend = true;
                  }
                } catch {
                  backendAvailableRef.current = false;
                }
              }

              if (!handledByBackend && isFilmingRef.current) {
                const localData = await analyzeFrameLocally(
                  ocrCanvas,
                  knownCustomersRef.current,
                  FOCUS_BOX,
                  {
                    acceptAllBarcodes: acceptAllBarcodesRef.current,
                    defaultCategory: defaultBarcodeCategoryRef.current,
                  }
                );
                if (isFilmingRef.current) {
                  const frameTs =
                    (performance.now() - startTimeMsRef.current) / 1000;
                  applyAnalyzedFrame(localData, frameTs);
                }
              }
            }
          }
          await new Promise((r) => setTimeout(r, 220));
        }
      };

      runFastBarcodeLoop();
      runBackgroundOcrLoop();
    } catch {
      setCameraError(
        "Kunde inte öppna direktkameran (kontrollera kameratillstånd eller använd 'Filma med mobilens kameraapp' här nedanför!)."
      );
      stopAllStreamsOnly();
    }
  };

  const toggleTorch = async () => {
    const stream = mediaStreamRef.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as unknown as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      triggerToast("Kunde inte växla blixt på denna enhet.");
    }
  };

  // -------------------------------------------------------------------------
  // MODE 2: RECORD WITH NATIVE PHONE CAMERA OR UPLOAD VIDEO (.mp4 / .mov)
  // -------------------------------------------------------------------------
  const handleVideoFileSelected = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    soundEngine.unlock();
    warmupLocalScanner();
    stopAllStreamsOnly();
    setInputMode("upload");
    setJustFinishedVideo(false);
    isFilmingRef.current = true;
    setIsFilming(true);
    setVideoProgress(0);
    setElapsedSec(0);
    setVideoDurationSec(0);
    setHudBanner({
      kind: "verifying",
      title: `Läser av inspelad video (${file.name})`,
      subtitle:
        "Skannar alla etiketter (t.ex. del0615244) och sparar Excel-fil när videon är klar...",
    });

    const controller = new AbortController();
    uploadAbortRef.current = controller;

    const runLocalVideoFallback = async (videoFile: File) => {
      const objUrl = URL.createObjectURL(videoFile);
      const tempVid = document.createElement("video");
      tempVid.muted = true;
      tempVid.playsInline = true;
      tempVid.setAttribute("playsinline", "true");
      tempVid.preload = "auto";
      tempVid.src = objUrl;
      tempVid.load();

      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => resolve(), 3500);
          tempVid.onloadeddata = () => {
            window.clearTimeout(timeout);
            resolve();
          };
          tempVid.onloadedmetadata = () => {
            // Prime iOS Safari video decoder
            tempVid
              .play()
              .then(() => {
                tempVid.pause();
                tempVid.currentTime = 0;
                window.clearTimeout(timeout);
                resolve();
              })
              .catch(() => {
                window.clearTimeout(timeout);
                resolve();
              });
          };
          tempVid.onerror = () => {
            window.clearTimeout(timeout);
            reject(new Error("Webbläsaren kunde inte öppna videofilen."));
          };
        });

        const dur =
          Number.isFinite(tempVid.duration) && tempVid.duration > 0
            ? tempVid.duration
            : 0;
        setVideoDurationSec(dur);

        const step = 0.25;
        const offCanvas = document.createElement("canvas");
        const maxSide = 1440;
        const vw = Math.max(320, tempVid.videoWidth || 720);
        const vh = Math.max(240, tempVid.videoHeight || 1280);
        const scale = Math.max(vw, vh) > maxSide ? maxSide / Math.max(vw, vh) : 1;
        offCanvas.width = Math.round(vw * scale);
        offCanvas.height = Math.round(vh * scale);
        const octx = offCanvas.getContext("2d", { willReadFrequently: true });

        const maxT = dur > 0 ? dur : 0.1;
        for (let t = 0.05; t <= maxT && isFilmingRef.current; t += step) {
          await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
              if (!done) {
                done = true;
                resolve();
              }
            };
            tempVid.onseeked = finish;
            window.setTimeout(finish, 450);
            try {
              tempVid.currentTime = Math.min(t, Math.max(0, dur - 0.02));
            } catch {
              finish();
            }
          });

          if (!isFilmingRef.current) break;
          if (octx) {
            octx.drawImage(tempVid, 0, 0, offCanvas.width, offCanvas.height);
            setUploadPreviewSrc(offCanvas.toDataURL("image/jpeg", 0.72));
            setElapsedSec(t);
            setVideoProgress(dur > 0 ? Math.min(0.99, t / dur) : 0.5);

            // Scan full recorded frame so labels & barcodes anywhere in the video are caught!
            const localRes = await analyzeFrameLocally(
              offCanvas,
              knownCustomersRef.current,
              [0.02, 0.05, 0.98, 0.95],
              {
                acceptAllBarcodes: acceptAllBarcodesRef.current,
                defaultCategory: defaultBarcodeCategoryRef.current,
              }
            );
            applyAnalyzedFrame(localRes, t);
          }
          await new Promise((r) => setTimeout(r, 20));
        }

        if (isFilmingRef.current) {
          setVideoProgress(1);
          finishVideoAndOpenReview();
        }
      } finally {
        URL.revokeObjectURL(objUrl);
      }
    };

    try {
      if (backendAvailableRef.current === false) {
        await runLocalVideoFallback(file);
        return;
      }

      const form = new FormData();
      form.append("video", file);
      form.append("sample_interval_sec", "0.28");
      form.append("default_customer", defaultCustomerRef.current);
      form.append(
        "known_customers_json",
        JSON.stringify(knownCustomersRef.current)
      );

      let res: Response;
      try {
        res = await fetch("/api/analyze-video-stream", {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
      } catch (netErr) {
        if ((netErr as Error)?.name === "AbortError") return;
        backendAvailableRef.current = false;
        await runLocalVideoFallback(file);
        return;
      }

      if (!res.ok || !res.body) {
        backendAvailableRef.current = false;
        await runLocalVideoFallback(file);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (isFilmingRef.current) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nlIdx: number;
        while ((nlIdx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          if (!line) continue;

          const msg = JSON.parse(line);
          if (msg.type === "meta") {
            setVideoDurationSec(msg.duration_sec || 0);
          } else if (msg.type === "frame") {
            setElapsedSec(msg.timestamp_sec || 0);
            setVideoProgress(msg.progress || 0);
            if (msg.preview_jpg) {
              setUploadPreviewSrc(msg.preview_jpg);
            }
            if (msg.analysis) {
              applyAnalyzedFrame(msg.analysis, msg.timestamp_sec || 0);
            }
          } else if (msg.type === "error") {
            throw new Error(msg.message || "Fel vid videoanalys");
          } else if (msg.type === "done") {
            setVideoProgress(1);
            finishVideoAndOpenReview();
            return;
          }
        }
      }

      if (isFilmingRef.current) {
        finishVideoAndOpenReview();
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        return;
      }
      triggerToast(
        err instanceof Error ? err.message : "Kunde inte läsa videofilen"
      );
      stopAllStreamsOnly();
    }
  };

  // -------------------------------------------------------------------------
  // MODE 3: DEMO WAREHOUSE VIDEO (Works both online & 100% offline on GitHub Pages!)
  // -------------------------------------------------------------------------
  const startDemoWarehouseVideo = async () => {
    soundEngine.unlock();
    warmupLocalScanner();
    stopAllStreamsOnly();
    setInputMode("demo");
    setJustFinishedVideo(false);
    setCameraError(null);

    const renderer = new DemoWarehouseRenderer();
    await renderer.preloadBarcodes();

    isFilmingRef.current = true;
    setIsFilming(true);
    setVideoDurationSec(DEMO_TOTAL_DURATION_SEC);
    setVideoProgress(0);
    startTimeMsRef.current = performance.now();

    const renderTick = () => {
      if (!isFilmingRef.current) return;
      const elapsed = (performance.now() - startTimeMsRef.current) / 1000;
      setElapsedSec(elapsed);
      setVideoProgress(Math.min(1, elapsed / DEMO_TOTAL_DURATION_SEC));

      const canvas = demoCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          renderer.renderFrame(ctx, canvas.width, canvas.height, elapsed);
        }
      }

      if (elapsed >= DEMO_TOTAL_DURATION_SEC) {
        finishVideoAndOpenReview();
        return;
      }
      demoRafRef.current = requestAnimationFrame(renderTick);
    };
    demoRafRef.current = requestAnimationFrame(renderTick);

    const analyzeDemoLoop = async () => {
      while (isFilmingRef.current) {
        const canvas = demoCanvasRef.current;
        const elapsed = (performance.now() - startTimeMsRef.current) / 1000;
        if (elapsed >= DEMO_TOTAL_DURATION_SEC) break;

        if (canvas) {
          let handled = false;
          if (backendAvailableRef.current !== false) {
            try {
              const jpgUrl = canvas.toDataURL("image/jpeg", 0.82);
              const res = await fetch("/api/analyze-frame", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  image_base64: jpgUrl,
                  known_customers: knownCustomersRef.current,
                  default_customer: defaultCustomerRef.current,
                }),
              });
              if (res.ok && isFilmingRef.current) {
                const data: AnalyzeFrameResponse = await res.json();
                applyAnalyzedFrame(data, elapsed);
                handled = true;
              }
            } catch {
              backendAvailableRef.current = false;
            }
          }

          if (!handled && isFilmingRef.current) {
            const snapCanvas = document.createElement("canvas");
            snapCanvas.width = canvas.width;
            snapCanvas.height = canvas.height;
            const sctx = snapCanvas.getContext("2d");
            if (sctx) {
              sctx.drawImage(canvas, 0, 0);
              const localData = await analyzeFrameLocally(
                snapCanvas,
                knownCustomersRef.current,
                [0.02, 0.04, 0.98, 0.96]
              );
              if (isFilmingRef.current) {
                applyAnalyzedFrame(localData, elapsed);
              }
            }
          }
        }
        await new Promise((r) => setTimeout(r, 95));
      }
    };
    analyzeDemoLoop();
  };

  // Manual Undo & +1 actions
  const handleUndoLast = () => {
    const { undoneLabel, rows: updated } = trackerRef.current.undoLast();
    setRows(updated);
    setCanUndo(trackerRef.current.canUndo());
    setActiveLockedId(trackerRef.current.getActiveLockedId());
    if (undoneLabel) {
      soundEngine.playUndo(soundEnabled);
      triggerToast(`Ångrade: ${undoneLabel}`);
    }
  };

  const handleManualPlusOne = () => {
    const { addedRow, rows: updated } =
      trackerRef.current.manualIncrementLocked(elapsedSec);
    if (addedRow) {
      setRows(updated);
      setCanUndo(trackerRef.current.canUndo());
      soundEngine.playDuplicateScan(soundEnabled);
      triggerToast(
        `+1 räknad på ${addedRow.customer} • ${addedRow.numberTitle} (Antal: ${addedRow.count})`
      );
    }
  };

  const handleUpdateRowsFromReview = (updated: InventoryRow[]) => {
    trackerRef.current.setRowsFromExternal(updated);
    setRows(updated);
  };

  const handleResetAll = () => {
    stopAllStreamsOnly();
    trackerRef.current.reset();
    setRows([]);
    setCanUndo(false);
    setActiveLockedId(null);
    setJustFinishedVideo(false);
    setUploadPreviewSrc("");
    setLastSavedLabel("");
    setActiveTab("scan");
    setHudBanner({
      kind: "idle",
      title: "Ny inventering redo",
      subtitle: "Starta kameran eller spela in en video av dina etiketter",
    });
  };

  const liveStats = useMemo(() => {
    let total = 0;
    let del = 0;
    let rem = 0;
    for (const r of rows) {
      total += r.count;
      if (r.category === "Delivery") del += r.count;
      else rem += r.count;
    }
    return { total, del, rem, unique: rows.length };
  }, [rows]);

  const hudColorClass = useMemo(() => {
    switch (hudBanner.kind) {
      case "locked_new":
        return "border-emerald-400 bg-emerald-950/95 text-emerald-50";
      case "locked_hold":
        return "border-emerald-500/60 bg-slate-900/90 text-emerald-100";
      case "duplicate_added":
        return "border-sky-400 bg-sky-950/95 text-sky-50";
      case "verifying":
        return "border-amber-400/80 bg-slate-900/90 text-amber-100";
      case "edge_warning":
        return "border-rose-400/80 bg-rose-950/90 text-rose-100";
      default:
        return "border-slate-700 bg-slate-900/85 text-slate-100";
    }
  }, [hudBanner.kind]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-5 left-4 right-4 z-50 mx-auto flex max-w-md items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-xs font-semibold text-white shadow-xl sm:left-auto sm:right-5">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Top Header Bar */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2.5 px-3.5 py-2.5 sm:px-6 sm:py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-900 text-emerald-400 shadow-sm">
              <ScanLine className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-bold tracking-tight text-slate-900">
                  LagerScan
                </span>
                <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                  Mobil OCR + Excel
                </span>
              </div>
              <p className="hidden text-[11px] text-slate-500 sm:block">
                Filma del.../rem...-etiketter (t.ex. del0615244) → automatisk Excel-fil
              </p>
            </div>
          </div>

          {/* Primary Navigation Tabs */}
          <nav className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setActiveTab("scan")}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === "scan"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Camera className="h-3.5 w-3.5" />
              1. Filma
            </button>
            <button
              type="button"
              onClick={() => {
                if (isFilming) {
                  finishVideoAndOpenReview();
                } else {
                  setActiveTab("review");
                }
              }}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === "review"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              2. Excel-lista
              {liveStats.total > 0 && (
                <span className="rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white tabular-nums">
                  {liveStats.total}
                </span>
              )}
            </button>
          </nav>

          {/* Utility Actions */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowTestLabelsModal(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              title="Visa testetiketter (inkl. del0615244)"
            >
              <QrCode className="h-3.5 w-3.5 text-emerald-600" />
              <span className="hidden md:inline">Testetiketter</span>
            </button>
            <button
              type="button"
              onClick={() => setShowCustomersModal(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              title="Hantera kända kunder"
            >
              <Building2 className="h-3.5 w-3.5 text-slate-500" />
              <span>Kunder</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="mx-auto max-w-7xl px-3.5 py-4 sm:px-6 sm:py-5">
        {activeTab === "review" ? (
          <ReviewAndExportView
            rows={rows}
            knownCustomers={knownCustomers}
            numberFormat={numberFormat}
            onChangeNumberFormat={setNumberFormat}
            columnMode={columnMode}
            onChangeColumnMode={setColumnMode}
            autoDownloadOnStop={autoDownloadOnStop}
            onChangeAutoDownload={setAutoDownloadOnStop}
            onUpdateRows={handleUpdateRowsFromReview}
            onDownloadExcel={() => downloadExcelForRows(rows)}
            onShareExcelMobile={shareExcelOnMobile}
            onCopyForExcel={copyRowsForExcel}
            isDownloading={isDownloading}
            justFinishedVideo={justFinishedVideo}
            onResumeFilming={() => setActiveTab("scan")}
            onResetSession={handleResetAll}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            {/* LEFT COLUMN: Video Viewfinder + Controls (7 cols) */}
            <div className="space-y-3.5 lg:col-span-7">
              {/* Mode & Engine Status Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white p-2.5 shadow-sm sm:p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    disabled={isFilming}
                    onClick={() => {
                      setInputMode("camera");
                      setCameraError(null);
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition ${
                      inputMode === "camera"
                        ? "bg-slate-900 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200/70 disabled:opacity-50"
                    }`}
                  >
                    <Camera className="h-3.5 w-3.5" />
                    Livekamera
                  </button>

                  {/* Native Smartphone Camera Video Recorder (autofocus macro + 1080p) */}
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-900 ring-1 ring-sky-200 transition hover:bg-sky-100">
                    <Smartphone className="h-3.5 w-3.5 text-sky-600" />
                    Filma med kameraapp
                    <input
                      type="file"
                      accept="video/*"
                      capture="environment"
                      onChange={handleVideoFileSelected}
                      className="hidden"
                    />
                  </label>

                  <label
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition ${
                      inputMode === "upload"
                        ? "bg-slate-900 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200/70"
                    }`}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    Välj video
                    <input
                      type="file"
                      accept="video/*"
                      onChange={handleVideoFileSelected}
                      className="hidden"
                    />
                  </label>

                  <button
                    type="button"
                    onClick={startDemoWarehouseVideo}
                    className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition ${
                      inputMode === "demo" && isFilming
                        ? "bg-emerald-600 text-white"
                        : "bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                    }`}
                  >
                    <Play className="h-3.5 w-3.5" />
                    Demo
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {/* OCR Readiness Pill */}
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                      localOcrStatus === "ready" || backendAvailableRef.current
                        ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200"
                        : localOcrStatus === "loading"
                          ? "bg-amber-50 text-amber-800 ring-1 ring-amber-200"
                          : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {localOcrStatus === "loading" && !backendAvailableRef.current ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Laddar OCR...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                        OCR &amp; Streckkod redo
                      </>
                    )}
                  </span>

                  <button
                    type="button"
                    onClick={() => setSoundEnabled((s) => !s)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    title="Ljudbekräftelse (pip) vid registrerat paket"
                  >
                    {soundEnabled ? (
                      <Volume2 className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <VolumeX className="h-3.5 w-3.5 text-slate-400" />
                    )}
                  </button>
                </div>
              </div>

              {/* Viewfinder Card */}
              <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-lg">
                {/* Green/Blue Flash Overlay when a package is registered */}
                {scanFlash !== "none" && (
                  <div
                    className={`pointer-events-none absolute inset-0 z-30 border-4 transition-opacity ${
                      scanFlash === "new"
                        ? "border-emerald-400 bg-emerald-400/20"
                        : "border-sky-400 bg-sky-400/20"
                    }`}
                  />
                )}

                {/* Top HUD Status Banner */}
                <div className="relative z-20 p-2.5 sm:p-3">
                  <div
                    className={`flex items-center justify-between gap-2.5 rounded-xl border px-3 py-2 backdrop-blur-md transition ${hudColorClass}`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs font-bold sm:text-sm">
                        {hudBanner.title}
                      </div>
                      <div className="truncate text-[11px] opacity-90">
                        {hudBanner.subtitle}
                      </div>
                    </div>
                    {isFilming && (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-2.5 py-1 font-mono text-[11px] font-bold text-white shadow-sm tabular-nums">
                          <span className="h-2 w-2 animate-ping rounded-full bg-white" />
                          REC {formatSeconds(elapsedSec)}
                          {videoDurationSec > 0
                            ? ` / ${formatSeconds(videoDurationSec)}`
                            : ""}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Video / Canvas Surface */}
                <div
                  ref={viewfinderRef}
                  className="relative aspect-[4/3] w-full overflow-hidden bg-slate-950 sm:aspect-[16/10]"
                >
                  {/* Live Camera Element */}
                  <video
                    ref={videoElRef}
                    playsInline
                    muted
                    style={
                      !hardwareZoomActive && cameraZoom > 1
                        ? { transform: `scale(${cameraZoom})` }
                        : undefined
                    }
                    className={`h-full w-full object-cover transition-transform duration-150 ${
                      inputMode === "camera" && isFilming ? "block" : "hidden"
                    }`}
                  />

                  {/* Uploaded / Recorded Video Stream Preview */}
                  {inputMode === "upload" && uploadPreviewSrc && (
                    <img
                      src={uploadPreviewSrc}
                      alt="Videoanalys"
                      className="h-full w-full object-contain"
                    />
                  )}

                  {/* Demo Warehouse Simulated Camera Canvas */}
                  <canvas
                    ref={demoCanvasRef}
                    width={800}
                    height={500}
                    className={`h-full w-full object-cover ${
                      inputMode === "demo" && isFilming ? "block" : "hidden"
                    }`}
                  />

                  {/* Idle / Start Overlay when not filming */}
                  {!isFilming && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center px-5 text-center">
                      {cameraError ? (
                        <div className="max-w-md rounded-2xl border border-amber-500/40 bg-slate-900/95 p-5 text-left">
                          <p className="text-xs leading-relaxed text-amber-200">
                            {cameraError}
                          </p>
                          <div className="mt-4 flex flex-wrap gap-2">
                            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2.5 text-xs font-bold text-slate-950 hover:bg-emerald-400">
                              <Smartphone className="h-4 w-4" />
                              Filma med mobilens kameraapp
                              <input
                                type="file"
                                accept="video/*"
                                capture="environment"
                                onChange={handleVideoFileSelected}
                                className="hidden"
                              />
                            </label>
                            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-slate-600 bg-slate-800 px-3.5 py-2.5 text-xs font-semibold text-slate-100 hover:bg-slate-700">
                              <Upload className="h-3.5 w-3.5" />
                              Välj sparad video
                              <input
                                type="file"
                                accept="video/*"
                                onChange={handleVideoFileSelected}
                                className="hidden"
                              />
                            </label>
                          </div>
                        </div>
                      ) : inputMode === "upload" ? (
                        <div className="flex max-w-sm flex-col items-center gap-3 rounded-2xl border border-slate-700 bg-slate-900/85 p-6">
                          <Film className="h-9 w-9 text-emerald-400" />
                          <div className="text-sm font-bold text-white">
                            Spela in eller välj en video av etiketterna
                          </div>
                          <p className="text-xs text-slate-400">
                            Filma alla etiketter (t.ex.{" "}
                            <span className="font-mono text-emerald-300">
                              del0615244
                            </span>
                            ) i en följd – appen läser varje etikett och skapar
                            Excel-filen automatiskt!
                          </p>
                          <div className="mt-1 flex flex-wrap justify-center gap-2">
                            <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-xs font-bold text-slate-950 hover:bg-emerald-400">
                              <Smartphone className="h-4 w-4" />
                              Spela in med kameraapp
                              <input
                                type="file"
                                accept="video/*"
                                capture="environment"
                                onChange={handleVideoFileSelected}
                                className="hidden"
                              />
                            </label>
                            <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-600 bg-slate-800 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-700">
                              <Upload className="h-4 w-4" />
                              Välj från galleri
                              <input
                                type="file"
                                accept="video/*"
                                onChange={handleVideoFileSelected}
                                className="hidden"
                              />
                            </label>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center">
                          <button
                            type="button"
                            onClick={startLiveCamera}
                            className="group inline-flex items-center gap-2.5 rounded-2xl bg-emerald-500 px-6 py-4 text-sm font-extrabold text-slate-950 shadow-lg shadow-emerald-500/25 transition hover:bg-emerald-400"
                          >
                            <span className="h-3 w-3 rounded-full bg-rose-600 ring-2 ring-white" />
                            Starta inspelning &amp; skanning (Kamera)
                          </button>

                          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900/90 px-3.5 py-2 text-xs font-semibold text-sky-300 hover:bg-slate-800">
                              <Smartphone className="h-3.5 w-3.5" />
                              Eller filma med mobilens kameraapp (skarp närbild)
                              <input
                                type="file"
                                accept="video/*"
                                capture="environment"
                                onChange={handleVideoFileSelected}
                                className="hidden"
                              />
                            </label>
                          </div>

                          <p className="mt-3 max-w-sm text-[11px] text-slate-400">
                            Läser både streckkoder och utskrivna nummer som{" "}
                            <span className="font-mono font-semibold text-emerald-300">
                              del0615244
                            </span>
                            ,{" "}
                            <span className="font-mono text-slate-300">
                              Del001234567
                            </span>{" "}
                            och{" "}
                            <span className="font-mono text-amber-300">
                              rem...
                            </span>
                            . När du trycker Stoppa sparas Excel-filen direkt!
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Active Viewfinder Reticle, Live Counter Pill & Bounding Boxes */}
                  {isFilming && (
                    <div className="pointer-events-none absolute inset-0">
                      {/* Green Target Scan Box matching FOCUS_BOX */}
                      <div
                        style={{
                          left: `${FOCUS_BOX[0] * 100}%`,
                          top: `${FOCUS_BOX[1] * 100}%`,
                          width: `${(FOCUS_BOX[2] - FOCUS_BOX[0]) * 100}%`,
                          height: `${(FOCUS_BOX[3] - FOCUS_BOX[1]) * 100}%`,
                        }}
                        className="absolute rounded-2xl border border-emerald-400/45 shadow-[0_0_0_9999px_rgba(2,6,23,0.28)]"
                      >
                        <div className="absolute -left-0.5 -top-0.5 h-6 w-6 rounded-tl-xl border-l-4 border-t-4 border-emerald-400" />
                        <div className="absolute -right-0.5 -top-0.5 h-6 w-6 rounded-tr-xl border-r-4 border-t-4 border-emerald-400" />
                        <div className="absolute -bottom-0.5 -left-0.5 h-6 w-6 rounded-bl-xl border-b-4 border-l-4 border-emerald-400" />
                        <div className="absolute -bottom-0.5 -right-0.5 h-6 w-6 rounded-br-xl border-b-4 border-r-4 border-emerald-400" />
                      </div>

                      {/* On-Screen Floating Counter Pill + Zoom Controls */}
                      <div className="absolute bottom-9 left-3 right-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="inline-flex items-center gap-2 rounded-xl border border-slate-700/90 bg-slate-950/90 px-3 py-1.5 text-xs font-bold text-white shadow-lg backdrop-blur-sm">
                          <span className="rounded-md bg-emerald-500 px-1.5 py-0.5 text-[11px] font-extrabold text-slate-950 tabular-nums">
                            {liveStats.total} st
                          </span>
                          <span className="truncate">
                            {lastSavedLabel
                              ? `Senast: ${lastSavedLabel}`
                              : "Håll streckkod/etikett i rutan..."}
                          </span>
                        </div>

                        {inputMode === "camera" && (
                          <div className="pointer-events-auto inline-flex items-center gap-1 rounded-xl border border-slate-700/90 bg-slate-950/90 p-1 shadow-lg backdrop-blur-sm">
                            {[1, 1.5, 2, 3].map((z) => (
                              <button
                                key={z}
                                type="button"
                                onClick={() => applyCameraZoom(z)}
                                className={`rounded-lg px-2 py-1 text-[11px] font-extrabold transition ${
                                  cameraZoom === z
                                    ? "bg-emerald-500 text-slate-950"
                                    : "text-slate-200 hover:bg-slate-800"
                                }`}
                                title="Zooma in och håll mobilen ~20 cm från små streckkoder för skarpare autofokus!"
                              >
                                {z}x
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Live OCR Text Monitor Strip at very bottom of viewfinder */}
                      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-slate-950/85 px-3 py-1 text-[11px] text-slate-300 backdrop-blur-sm">
                        <Eye className="h-3 w-3 shrink-0 text-emerald-400" />
                        <span className="truncate font-mono">
                          {liveRawText
                            ? `Kamera läser: ${liveRawText}`
                            : "Söker text/streckkod i bild..."}
                        </span>
                      </div>

                      {/* Real-time Bounding Boxes around Detected Numbers/Barcodes */}
                      {liveDetections.map((det) => {
                        const [x1, y1, x2, y2] = det.bbox;
                        const isDel = det.category === "Delivery";
                        return (
                          <div
                            key={det.canonical_id}
                            style={{
                              left: `${x1 * 100}%`,
                              top: `${y1 * 100}%`,
                              width: `${Math.max(8, (x2 - x1) * 100)}%`,
                              height: `${Math.max(7, (y2 - y1) * 100)}%`,
                            }}
                            className={`absolute rounded-lg border-2 transition-all duration-100 ${
                              det.edge_clipped
                                ? "border-dashed border-amber-400 bg-amber-400/10"
                                : isDel
                                  ? "border-emerald-400 bg-emerald-400/20 shadow-[0_0_16px_rgba(16,185,129,0.45)]"
                                  : "border-amber-400 bg-amber-400/20 shadow-[0_0_16px_rgba(245,158,11,0.45)]"
                            }`}
                          >
                            <div
                              className={`-top-7 left-0 inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-bold shadow-md ${
                                isDel
                                  ? "bg-emerald-500 text-slate-950"
                                  : "bg-amber-500 text-slate-950"
                              }`}
                            >
                              <span>
                                {det.display_title} ({det.category})
                                {det.customer ? ` • ${det.customer}` : ""}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Progress bar for Uploaded / Demo Video */}
                {isFilming &&
                  (inputMode === "upload" || inputMode === "demo") && (
                    <div className="h-1.5 w-full bg-slate-800">
                      <div
                        style={{
                          width: `${Math.round(videoProgress * 100)}%`,
                        }}
                        className="h-full bg-emerald-500 transition-all duration-200"
                      />
                    </div>
                  )}

                {/* Bottom Action Controls inside Scanner Card */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 bg-slate-900 px-3.5 py-3 sm:px-4">
                  {isFilming ? (
                    <>
                      <button
                        type="button"
                        onClick={finishVideoAndOpenReview}
                        className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-rose-600 px-4 py-3 text-xs font-extrabold text-white shadow-sm transition hover:bg-rose-500 sm:flex-none sm:text-sm"
                      >
                        <Square className="h-4 w-4 fill-current" />
                        Stoppa &amp; Spara Excel ({liveStats.total} paket)
                      </button>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {torchSupported && inputMode === "camera" && (
                          <button
                            type="button"
                            onClick={toggleTorch}
                            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-xs font-semibold ${
                              torchOn
                                ? "bg-amber-400 text-slate-950"
                                : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                            }`}
                          >
                            <Flashlight className="h-3.5 w-3.5" />
                            Blixt
                          </button>
                        )}

                        <button
                          type="button"
                          disabled={rows.length === 0}
                          onClick={handleManualPlusOne}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-700 disabled:opacity-40"
                          title="Lägg manuellt till +1 på senaste låsta nummer"
                        >
                          <Plus className="h-3.5 w-3.5 text-sky-400" />
                          +1
                        </button>

                        <button
                          type="button"
                          disabled={!canUndo}
                          onClick={handleUndoLast}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                        >
                          <Undo2 className="h-3.5 w-3.5" />
                          Ångra
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex w-full flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                      <span className="inline-flex items-center gap-1.5">
                        <ShieldCheck className="h-4 w-4 text-emerald-400" />
                        Auto-sparar .xlsx när du stoppar inspelningen
                      </span>
                      {sharpnessScore > 0 && (
                        <span className="font-mono text-[11px] text-slate-500">
                          Skärpa: {sharpnessScore}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Barcode Filter + Quick Customer Chips + Sensitivity Settings */}
              <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm sm:p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                  <div>
                    <div className="text-xs font-semibold text-slate-700">
                      Streckkodsläge (Code128, Code39, QR, DataMatrix, EAN, ITF)
                    </div>
                    <div className="text-[11px] text-slate-500">
                      Läser även streckkoder där själva streckkoden saknar prefixet{" "}
                      <span className="font-mono">del</span>/<span className="font-mono">rem</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setAcceptAllBarcodes(true)}
                      className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                        acceptAllBarcodes
                          ? "bg-emerald-600 text-white"
                          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                      }`}
                    >
                      Alla streckkoder + del/rem
                    </button>
                    <button
                      type="button"
                      onClick={() => setAcceptAllBarcodes(false)}
                      className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                        !acceptAllBarcodes
                          ? "bg-slate-900 text-white"
                          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                      }`}
                    >
                      Endast del.../rem...
                    </button>
                    {acceptAllBarcodes && (
                      <select
                        value={defaultBarcodeCategory}
                        onChange={(e) =>
                          setDefaultBarcodeCategory(
                            e.target.value as PackageCategory
                          )
                        }
                        className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs font-semibold text-slate-800"
                        title="Kategori om streckkoden saknar del/rem-prefix"
                      >
                        <option value="Delivery">Standard: Delivery</option>
                        <option value="Removal">Standard: Removal</option>
                      </select>
                    )}
                  </div>
                </div>

                <div className="mb-3">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-slate-700">
                      Snabbval av kund (om etiketten bara har t.ex.{" "}
                      <span className="font-mono">del0615244</span> utan kundnamn)
                    </label>
                    {defaultCustomer && (
                      <button
                        type="button"
                        onClick={() => setDefaultCustomer("")}
                        className="text-[11px] font-semibold text-emerald-700 hover:underline"
                      >
                        Återställ till Auto
                      </button>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => setDefaultCustomer("")}
                      className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                        defaultCustomer === ""
                          ? "bg-slate-900 text-white"
                          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                      }`}
                    >
                      Auto (läs från etikett)
                    </button>
                    {knownCustomers.slice(0, 6).map((cust) => (
                      <button
                        key={cust}
                        type="button"
                        onClick={() => setDefaultCustomer(cust)}
                        className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                          defaultCustomer === cust
                            ? "bg-emerald-600 text-white"
                            : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                        }`}
                      >
                        {cust}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Dubbletträkning (likadana nummer)
                    </label>
                    <select
                      value={sensitivity}
                      onChange={(e) =>
                        setSensitivity(e.target.value as SensitivityMode)
                      }
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-800 focus:border-slate-500 focus:outline-none"
                    >
                      <option value="fast">
                        Snabb (snabb kameraförflyttning)
                      </option>
                      <option value="standard">
                        Standard – Rekommenderad
                      </option>
                      <option value="strict">
                        Extra strikt (2 bildrutor + stort scenbyte)
                      </option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Eget kundnamn (valfritt)
                    </label>
                    <input
                      type="text"
                      list="known-customers-scan"
                      value={defaultCustomer}
                      onChange={(e) => setDefaultCustomer(e.target.value)}
                      placeholder="Auto eller skriv kundnamn..."
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-slate-500 focus:bg-white focus:outline-none"
                    />
                    <datalist id="known-customers-scan">
                      {knownCustomers.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                  </div>
                </div>
              </div>
            </div>

            {/* RIGHT COLUMN: Live Categorized Feed & Instant Excel Save (5 cols) */}
            <div className="flex flex-col rounded-2xl border border-slate-200 bg-white shadow-sm lg:col-span-5">
              <div className="border-b border-slate-200 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-bold text-slate-900">
                      Registrerade etiketter ({liveStats.total} st)
                    </h2>
                    <p className="text-xs text-slate-500">
                      Sparas automatiskt till Excel när du stoppar
                    </p>
                  </div>
                  {rows.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        if (isFilming) {
                          finishVideoAndOpenReview();
                        } else {
                          downloadExcelForRows(rows);
                        }
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm hover:bg-emerald-700"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Spara Excel (.xlsx)
                    </button>
                  )}
                </div>

                {/* Live Mini Counters */}
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                    <div className="text-[11px] font-medium text-slate-500">
                      Totalt antal
                    </div>
                    <div className="text-lg font-bold tabular-nums text-slate-900">
                      {liveStats.total}
                    </div>
                  </div>
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-2">
                    <div className="text-[11px] font-medium text-emerald-800">
                      Delivery
                    </div>
                    <div className="text-lg font-bold tabular-nums text-emerald-700">
                      {liveStats.del}
                    </div>
                  </div>
                  <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2">
                    <div className="text-[11px] font-medium text-amber-800">
                      Removal
                    </div>
                    <div className="text-lg font-bold tabular-nums text-amber-700">
                      {liveStats.rem}
                    </div>
                  </div>
                </div>
              </div>

              {/* Live Scanned Rows List */}
              <div className="max-h-[460px] flex-1 divide-y divide-slate-100 overflow-y-auto">
                {rows.length === 0 ? (
                  <div className="px-6 py-10 text-center">
                    <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-400">
                      <FileSpreadsheet className="h-5 w-5" />
                    </div>
                    <p className="mt-3 text-xs font-semibold text-slate-700">
                      Inga etiketter skannade ännu
                    </p>
                    <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-slate-500">
                      Rikta mobilkameran mot etiketter som innehåller t.ex.{" "}
                      <span className="font-mono font-semibold text-slate-800">
                        del0615244
                      </span>{" "}
                      eller{" "}
                      <span className="font-mono font-semibold text-slate-800">
                        rem...
                      </span>
                      . Varje avläst etikett piper till och dyker upp här!
                    </p>
                  </div>
                ) : (
                  rows.map((row) => {
                    const isCurrentlyLocked =
                      activeLockedId === row.id && isFilming;
                    const lastThumb =
                      row.snapshots.length > 0
                        ? row.snapshots[row.snapshots.length - 1].thumbnail
                        : "";
                    return (
                      <div
                        key={row.id}
                        className={`flex items-center justify-between gap-3 px-4 py-3 transition ${
                          isCurrentlyLocked
                            ? "bg-emerald-50/70"
                            : "hover:bg-slate-50"
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          {lastThumb ? (
                            <img
                              src={lastThumb}
                              alt={row.numberTitle}
                              className="h-11 w-14 shrink-0 rounded-lg border border-slate-200 bg-slate-900 object-cover"
                            />
                          ) : (
                            <div className="flex h-11 w-14 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-[10px] text-slate-400">
                              OCR
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-sm font-bold text-slate-900">
                                {row.customer}
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                  row.category === "Delivery"
                                    ? "bg-emerald-100 text-emerald-800"
                                    : "bg-amber-100 text-amber-800"
                                }`}
                              >
                                {row.category}
                              </span>
                            </div>
                            <div className="mt-0.5 font-mono text-xs font-semibold text-slate-700">
                              {numberFormat === "upper"
                                ? row.numberUpper
                                : row.numberTitle}
                            </div>
                            <div className="text-[11px] text-slate-400">
                              {row.verifiedBy} • {row.firstSeen}
                            </div>
                          </div>
                        </div>

                        <div className="shrink-0 text-right">
                          <div
                            className={`inline-flex min-w-[2.75rem] items-center justify-center rounded-xl px-2.5 py-1 text-sm font-extrabold tabular-nums ${
                              row.count > 1
                                ? "bg-sky-100 text-sky-800 ring-1 ring-sky-300"
                                : "bg-slate-100 text-slate-800"
                            }`}
                          >
                            {row.count} st
                          </div>
                          {isCurrentlyLocked && (
                            <div className="mt-1 text-[10px] font-semibold text-emerald-700">
                              Låst i bild
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {rows.length > 0 && (
                <div className="border-t border-slate-200 bg-slate-50 p-3.5">
                  <button
                    type="button"
                    onClick={() => {
                      if (isFilming) {
                        finishVideoAndOpenReview();
                      } else {
                        setActiveTab("review");
                      }
                    }}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-800"
                  >
                    <FileSpreadsheet className="h-4 w-4 text-emerald-400" />
                    Granska lista &amp; dela/spara Excel (.xlsx)
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Modals */}
      <CustomerModal
        open={showCustomersModal}
        onClose={() => setShowCustomersModal(false)}
        customers={knownCustomers}
        onSaveCustomers={handleSaveCustomers}
      />
      <TestLabelsModal
        open={showTestLabelsModal}
        onClose={() => setShowTestLabelsModal(false)}
      />
    </div>
  );
};

export default App;
