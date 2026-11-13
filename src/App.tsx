import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  Camera,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Film,
  Flashlight,
  Play,
  Plus,
  QrCode,
  ScanLine,
  ShieldCheck,
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
import {
  analyzeCanvasLocally,
  DEFAULT_CUSTOMERS_LIST,
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
  SensitivityMode,
} from "./types";

type InputMode = "camera" | "upload" | "demo";
type MainTab = "scan" | "review";

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

  // Scanner settings
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [sensitivity, setSensitivity] = useState<SensitivityMode>("standard");
  const [defaultCustomer, setDefaultCustomer] = useState("");
  const [knownCustomers, setKnownCustomers] = useState<string[]>(
    DEFAULT_CUSTOMERS_LIST
  );
  const backendAvailableRef = useRef<boolean | null>(null);
  const [numberFormat, setNumberFormat] = useState<"title" | "upper">("title");
  const [columnMode, setColumnMode] = useState<
    "standard_4col" | "combined_category"
  >("standard_4col");
  const [autoDownloadOnStop, setAutoDownloadOnStop] = useState(false);

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
  const [sharpnessScore, setSharpnessScore] = useState<number>(0);
  const [hudBanner, setHudBanner] = useState<HudBannerState>({
    kind: "idle",
    title: "Redo att filma paket",
    subtitle:
      "Starta kameran, ladda upp en video eller testa med exempelvideon",
  });

  // Refs for media & loops
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
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

  const triggerToast = useCallback((msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3200);
  }, []);

  // Load saved customer dictionary on mount (graceful fallback if standalone/offline)
  useEffect(() => {
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
      // saved locally in memory
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
            "Tabellen kopierad! Öppna Excel och tryck Ctrl+V för att klistra in."
          )
        )
        .catch(() => {
          fallbackCopy();
          triggerToast(
            "Tabellen kopierad! Öppna Excel och tryck Ctrl+V för att klistra in."
          );
        });
    } else {
      fallbackCopy();
      triggerToast(
        "Tabellen kopierad! Öppna Excel och tryck Ctrl+V för att klistra in."
      );
    }
  }, [columnMode, numberFormat, rows, triggerToast]);

  const downloadExcelForRows = useCallback(
    async (targetRows: InventoryRow[]) => {
      if (targetRows.length === 0) return;
      setIsDownloading(true);
      try {
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
          // Pure client-side .xlsx generation (works 100% offline & standalone!)
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

        const url = URL.createObjectURL(blob);
        const now = new Date();
        const stamp = `${now.getFullYear()}-${String(
          now.getMonth() + 1
        ).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(
          now.getHours()
        ).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
        const a = document.createElement("a");
        a.href = url;
        a.download = `Inventering_${stamp}.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 3000);
        triggerToast("Excel-filen (.xlsx) är skapad!");
      } catch (err) {
        triggerToast(
          err instanceof Error ? err.message : "Fel vid export till Excel"
        );
      } finally {
        setIsDownloading(false);
      }
    },
    [columnMode, numberFormat, triggerToast]
  );

  // Stop all media streams cleanly
  const stopAllStreamsOnly = useCallback(() => {
    isFilmingRef.current = false;
    setIsFilming(false);
    setLiveDetections([]);
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

  // Called when user closes video OR when uploaded/demo video finishes
  const finishVideoAndOpenReview = useCallback(() => {
    stopAllStreamsOnly();
    const latestRows = trackerRef.current.getRows();
    setRows(latestRows);
    setJustFinishedVideo(true);
    setActiveTab("review");
    if (autoDownloadRef.current && latestRows.length > 0) {
      downloadExcelForRows(latestRows);
    }
  }, [downloadExcelForRows, stopAllStreamsOnly]);

  const applyAnalyzedFrame = useCallback(
    (analysis: AnalyzeFrameResponse, tsSec: number) => {
      setSharpnessScore(analysis.sharpness || 0);
      setLiveDetections(analysis.detections || []);

      const outcome = trackerRef.current.processFrame(
        analysis,
        tsSec,
        sensitivityRef.current
      );

      setRows(outcome.rows);
      setHudBanner(outcome.hud);
      setActiveLockedId(outcome.activeLockedId);
      setCanUndo(outcome.canUndo);

      if (outcome.event === "new_scan") {
        soundEngine.playNewScan(soundEnabledRef.current);
      } else if (outcome.event === "duplicate_scan") {
        soundEngine.playDuplicateScan(soundEnabledRef.current);
      }
    },
    []
  );

  // -------------------------------------------------------------------------
  // MODE 1: LIVE CAMERA (Mobile rear camera or webcam)
  // -------------------------------------------------------------------------
  const startLiveCamera = async () => {
    soundEngine.unlock();
    setCameraError(null);
    stopAllStreamsOnly();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError(
        "Kameran är inte tillgänglig i denna vy (kräver HTTPS eller direkt webbläsarflik). Du kan ladda upp en inspelad video eller köra demovideon!"
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      mediaStreamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      if (track && "getCapabilities" in track) {
        const caps = track.getCapabilities() as MediaTrackCapabilities & {
          torch?: boolean;
        };
        if (caps && caps.torch) {
          setTorchSupported(true);
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
        title: "Kameran är igång – filma dina paket",
        subtitle:
          "Rikta mot streckkod eller Delivery/Removal-nummer. När du stänger videon skapas listan.",
      });

      // Async non-blocking frame analysis loop
      const runCameraLoop = async () => {
        while (isFilmingRef.current && videoElRef.current) {
          const vid = videoElRef.current;
          const nowSec = (performance.now() - startTimeMsRef.current) / 1000;
          setElapsedSec(nowSec);

          if (vid.readyState >= 2 && vid.videoWidth > 0) {
            const canvas =
              captureCanvasRef.current || document.createElement("canvas");
            captureCanvasRef.current = canvas;
            const maxW = 860;
            const scale =
              vid.videoWidth > maxW ? maxW / vid.videoWidth : 1.0;
            canvas.width = Math.round(vid.videoWidth * scale);
            canvas.height = Math.round(vid.videoHeight * scale);
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
              let handledByBackend = false;
              if (backendAvailableRef.current !== false) {
                try {
                  const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
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
                const localData = await analyzeCanvasLocally(
                  canvas,
                  knownCustomersRef.current,
                  defaultCustomerRef.current
                );
                const frameTs =
                  (performance.now() - startTimeMsRef.current) / 1000;
                applyAnalyzedFrame(localData, frameTs);
              }
            }
          }
          await new Promise((r) => setTimeout(r, 90));
        }
      };

      runCameraLoop();
    } catch (err) {
      setCameraError(
        "Kunde inte öppna kameran (behörighet nekad eller ingen kamera hittades). Öppna länken i mobilens webbläsare, ladda upp en videofil eller prova demovideon!"
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
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      triggerToast("Kunde inte växla ficklampa på denna enhet.");
    }
  };

  // -------------------------------------------------------------------------
  // MODE 2: UPLOAD RECORDED VIDEO (.mp4 / .mov / .webm)
  // -------------------------------------------------------------------------
  const handleVideoFileSelected = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    soundEngine.unlock();
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
      title: `Läser av video: ${file.name}`,
      subtitle:
        "Analyserar alla streckkoder, kundnamn och Delivery/Removal-nummer...",
    });

    const controller = new AbortController();
    uploadAbortRef.current = controller;

    const runLocalVideoFallback = async (videoFile: File) => {
      const objUrl = URL.createObjectURL(videoFile);
      const tempVid = document.createElement("video");
      tempVid.muted = true;
      tempVid.playsInline = true;
      tempVid.preload = "auto";
      tempVid.src = objUrl;

      try {
        await new Promise<void>((resolve, reject) => {
          tempVid.onloadedmetadata = () => resolve();
          tempVid.onerror = () =>
            reject(new Error("Webbläsaren kunde inte spela upp videofilen."));
        });

        const dur = Number.isFinite(tempVid.duration) ? tempVid.duration : 0;
        setVideoDurationSec(dur);
        const step = 0.3;
        const offCanvas = document.createElement("canvas");
        const maxW = 800;
        const scale = tempVid.videoWidth > maxW ? maxW / tempVid.videoWidth : 1;
        offCanvas.width = Math.max(320, Math.round(tempVid.videoWidth * scale));
        offCanvas.height = Math.max(
          240,
          Math.round(tempVid.videoHeight * scale)
        );
        const octx = offCanvas.getContext("2d");

        for (let t = 0; t <= dur && isFilmingRef.current; t += step) {
          tempVid.currentTime = t;
          await new Promise<void>((resolve) => {
            tempVid.onseeked = () => resolve();
            window.setTimeout(resolve, 400);
          });
          if (!isFilmingRef.current) break;
          if (octx) {
            octx.drawImage(tempVid, 0, 0, offCanvas.width, offCanvas.height);
            setUploadPreviewSrc(offCanvas.toDataURL("image/jpeg", 0.72));
            setElapsedSec(t);
            setVideoProgress(dur > 0 ? Math.min(0.99, t / dur) : 0.5);
            const localRes = await analyzeCanvasLocally(
              offCanvas,
              knownCustomersRef.current,
              defaultCustomerRef.current
            );
            applyAnalyzedFrame(localRes, t);
          }
          await new Promise((r) => setTimeout(r, 30));
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
      form.append("sample_interval_sec", "0.30");
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
        throw new Error("Kunde inte analysera videofilen.");
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
  // MODE 3: REALISTIC SIMULATED WAREHOUSE VIDEO (Uses real /api/analyze-frame!)
  // -------------------------------------------------------------------------
  const startDemoWarehouseVideo = async () => {
    soundEngine.unlock();
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

    // 30fps smooth canvas animation loop
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

    // Real backend OCR + Barcode analysis loop reading the live canvas stream!
    const analyzeDemoLoop = async () => {
      while (isFilmingRef.current) {
        const canvas = demoCanvasRef.current;
        const elapsed = (performance.now() - startTimeMsRef.current) / 1000;
        if (elapsed >= DEMO_TOTAL_DURATION_SEC) break;

        if (canvas) {
          const jpgUrl = canvas.toDataURL("image/jpeg", 0.82);
          try {
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
            }
          } catch {
            // ignore
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
    setActiveTab("scan");
    setHudBanner({
      kind: "idle",
      title: "Ny inventering redo",
      subtitle: "Starta kameran eller ladda upp en video",
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

  // HUD Banner Styling
  const hudColorClass = useMemo(() => {
    switch (hudBanner.kind) {
      case "locked_new":
        return "border-emerald-400/80 bg-emerald-950/90 text-emerald-50";
      case "locked_hold":
        return "border-emerald-500/50 bg-slate-900/90 text-emerald-100";
      case "duplicate_added":
        return "border-sky-400 bg-sky-950/95 text-sky-50";
      case "verifying":
        return "border-amber-400/70 bg-slate-900/90 text-amber-100";
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
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white shadow-xl">
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          {toastMessage}
        </div>
      )}

      {/* Top Header Bar */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          {/* Brand */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-900 text-emerald-400 shadow-sm">
              <ScanLine className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-bold tracking-tight text-slate-900">
                  LagerScan
                </span>
                <span className="hidden rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 sm:inline-block">
                  Video → Excel
                </span>
              </div>
              <p className="text-[11px] text-slate-500">
                Automatisk Delivery &amp; Removal-inventering per kund
              </p>
            </div>
          </div>

          {/* Primary Navigation Tabs */}
          <nav className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setActiveTab("scan")}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
                activeTab === "scan"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Camera className="h-3.5 w-3.5" />
              1. Filma paket
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
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
                activeTab === "review"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              2. Lista &amp; Excel
              {liveStats.total > 0 && (
                <span className="rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white tabular-nums">
                  {liveStats.total}
                </span>
              )}
            </button>
          </nav>

          {/* Utility Actions */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowTestLabelsModal(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              title="Visa testetiketter att filma med mobilen"
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
              <span>Kunder ({knownCustomers.length})</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
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
            onCopyForExcel={copyRowsForExcel}
            isDownloading={isDownloading}
            justFinishedVideo={justFinishedVideo}
            onResumeFilming={() => setActiveTab("scan")}
            onResetSession={handleResetAll}
          />
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
            {/* LEFT COLUMN: Video Viewfinder + Controls (7 cols) */}
            <div className="space-y-4 lg:col-span-7">
              {/* Input Mode Selector Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
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
                    Mobil-/Webbkamera
                  </button>

                  <label
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition ${
                      inputMode === "upload"
                        ? "bg-slate-900 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200/70"
                    }`}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    Ladda upp video
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
                    Kör exempelvideo (6 paket)
                  </button>
                </div>

                {/* Audio toggle */}
                <button
                  type="button"
                  onClick={() => setSoundEnabled((s) => !s)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  title="Ljudbekräftelse (pip) vid registrerat paket"
                >
                  {soundEnabled ? (
                    <>
                      <Volume2 className="h-3.5 w-3.5 text-emerald-600" />
                      Pip på
                    </>
                  ) : (
                    <>
                      <VolumeX className="h-3.5 w-3.5 text-slate-400" />
                      Ljud av
                    </>
                  )}
                </button>
              </div>

              {/* Viewfinder Viewport */}
              <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-lg">
                {/* Top HUD Status Banner */}
                <div className="relative z-20 p-3">
                  <div
                    className={`flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 backdrop-blur-md transition ${hudColorClass}`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs font-bold sm:text-sm">
                        {hudBanner.title}
                      </div>
                      <div className="truncate text-[11px] opacity-85">
                        {hudBanner.subtitle}
                      </div>
                    </div>
                    {isFilming && (
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-600/90 px-2.5 py-1 font-mono text-[11px] font-bold text-white tabular-nums">
                          <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
                          {formatSeconds(elapsedSec)}
                          {videoDurationSec > 0
                            ? ` / ${formatSeconds(videoDurationSec)}`
                            : ""}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Video / Canvas Surface */}
                <div className="relative aspect-[4/3] w-full bg-slate-950 sm:aspect-[16/10]">
                  {/* Live Camera Element */}
                  <video
                    ref={videoElRef}
                    playsInline
                    muted
                    className={`h-full w-full object-cover ${
                      inputMode === "camera" && isFilming ? "block" : "hidden"
                    }`}
                  />

                  {/* Uploaded Video Stream Preview */}
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
                    <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
                      {cameraError ? (
                        <div className="max-w-md rounded-2xl border border-amber-500/40 bg-slate-900/95 p-5 text-left">
                          <p className="text-xs leading-relaxed text-amber-200">
                            {cameraError}
                          </p>
                          <div className="mt-4 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={startDemoWarehouseVideo}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
                            >
                              <Play className="h-3.5 w-3.5" />
                              Kör exempelvideo nu
                            </button>
                            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-700">
                              <Upload className="h-3.5 w-3.5" />
                              Välj videofil
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
                        <label className="flex max-w-sm cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed border-slate-700 bg-slate-900/70 px-8 py-8 transition hover:border-emerald-500/70 hover:bg-slate-900">
                          <Film className="h-10 w-10 text-emerald-400" />
                          <span className="mt-3 text-sm font-bold text-white">
                            Välj inspelad videofil (.mp4 / .mov)
                          </span>
                          <span className="mt-1 text-xs text-slate-400">
                            Filma alla paket i en följd med mobilkameran och
                            ladda upp videon här – listan skapas automatiskt
                          </span>
                          <input
                            type="file"
                            accept="video/*"
                            onChange={handleVideoFileSelected}
                            className="hidden"
                          />
                        </label>
                      ) : (
                        <div className="flex flex-col items-center">
                          <button
                            type="button"
                            onClick={startLiveCamera}
                            className="group inline-flex items-center gap-2.5 rounded-2xl bg-emerald-500 px-6 py-3.5 text-sm font-bold text-slate-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400"
                          >
                            <Camera className="h-5 w-5" />
                            Starta filmning (Kamera)
                          </button>
                          <p className="mt-3 max-w-sm text-xs text-slate-400">
                            Eller klicka på{" "}
                            <button
                              type="button"
                              onClick={startDemoWarehouseVideo}
                              className="font-semibold text-emerald-400 underline hover:text-emerald-300"
                            >
                              Kör exempelvideo (6 paket)
                            </button>{" "}
                            för att se hur dubbletter (t.ex. 2 st{" "}
                            <span className="font-mono text-slate-300">
                              Del001234567
                            </span>
                            ) räknas och blir till en Excel-fil!
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Active Viewfinder Reticle & Live Detection Bounding Boxes */}
                  {isFilming && (
                    <div className="pointer-events-none absolute inset-0">
                      {/* Subtle framing guide corners */}
                      <div className="absolute inset-x-[8%] inset-y-[10%] rounded-2xl border border-white/15">
                        <div className="absolute -left-0.5 -top-0.5 h-5 w-5 rounded-tl-lg border-l-2 border-t-2 border-emerald-400/80" />
                        <div className="absolute -right-0.5 -top-0.5 h-5 w-5 rounded-tr-lg border-r-2 border-t-2 border-emerald-400/80" />
                        <div className="absolute -bottom-0.5 -left-0.5 h-5 w-5 rounded-bl-lg border-b-2 border-l-2 border-emerald-400/80" />
                        <div className="absolute -bottom-0.5 -right-0.5 h-5 w-5 rounded-br-lg border-b-2 border-r-2 border-emerald-400/80" />
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
                              width: `${Math.max(6, (x2 - x1) * 100)}%`,
                              height: `${Math.max(6, (y2 - y1) * 100)}%`,
                            }}
                            className={`absolute rounded-lg border-2 transition-all duration-100 ${
                              det.edge_clipped
                                ? "border-dashed border-amber-400 bg-amber-400/10"
                                : isDel
                                  ? "border-emerald-400 bg-emerald-400/15 shadow-[0_0_16px_rgba(16,185,129,0.35)]"
                                  : "border-amber-400 bg-amber-400/15 shadow-[0_0_16px_rgba(245,158,11,0.35)]"
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
                                {det.customer || "Läser kund..."} •{" "}
                                {det.category} • {det.display_title}
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
                <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-slate-800 bg-slate-900 px-4 py-3">
                  {isFilming ? (
                    <>
                      <button
                        type="button"
                        onClick={finishVideoAndOpenReview}
                        className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-bold text-white shadow-sm transition hover:bg-rose-500 sm:text-sm"
                      >
                        <Square className="h-4 w-4 fill-current" />
                        Stäng video &amp; Skapa Excel ({liveStats.total} paket)
                      </button>

                      <div className="flex flex-wrap items-center gap-2">
                        {torchSupported && inputMode === "camera" && (
                          <button
                            type="button"
                            onClick={toggleTorch}
                            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold ${
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
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-700 disabled:opacity-40"
                          title="Lägg manuellt till +1 på senaste låsta nummer om två lådor står tätt ihop"
                        >
                          <Plus className="h-3.5 w-3.5 text-sky-400" />
                          +1 Samma nr
                        </button>

                        <button
                          type="button"
                          disabled={!canUndo}
                          onClick={handleUndoLast}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40"
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
                        Dubbelkontrollerad avläsning (Streckkod + OCR)
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

              {/* Precision Settings Strip beneath Scanner */}
              <div className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Känslighet för likadana nummer (Dubbletträkning)
                  </label>
                  <p className="mb-1.5 text-[11px] text-slate-500">
                    Hur länge kameran lämnar låda 1 innan låda 2 räknas som +1
                  </p>
                  <select
                    value={sensitivity}
                    onChange={(e) =>
                      setSensitivity(e.target.value as SensitivityMode)
                    }
                    className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-800 focus:border-slate-500 focus:outline-none"
                  >
                    <option value="fast">
                      Snabb (0.7s kameraförflyttning)
                    </option>
                    <option value="standard">
                      Standard – Rekommenderad (1.1s + scenbyte)
                    </option>
                    <option value="strict">
                      Extra säker mot skakning (1.8s + stort scenbyte)
                    </option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Förvald kund (valfritt reservval)
                  </label>
                  <p className="mb-1.5 text-[11px] text-slate-500">
                    Används endast om en etikett helt saknar utskrivet kundnamn
                  </p>
                  <input
                    type="text"
                    list="known-customers-scan"
                    value={defaultCustomer}
                    onChange={(e) => setDefaultCustomer(e.target.value)}
                    placeholder="Automatisk avläsning från etikett..."
                    className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-slate-500 focus:bg-white focus:outline-none"
                  />
                  <datalist id="known-customers-scan">
                    {knownCustomers.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </div>
              </div>
            </div>

            {/* RIGHT COLUMN: Live Categorized Feed & Instant Summary (5 cols) */}
            <div className="flex flex-col rounded-2xl border border-slate-200 bg-white shadow-sm lg:col-span-5">
              <div className="border-b border-slate-200 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-bold text-slate-900">
                      Filmade &amp; kategoriserade paket
                    </h2>
                    <p className="text-xs text-slate-500">
                      Uppdateras i realtid medan du filmar
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
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                    >
                      <Download className="h-3.5 w-3.5" />
                      {isFilming ? "Färdigställ Excel" : "Spara Excel"}
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
                  <div className="px-6 py-12 text-center">
                    <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-400">
                      <FileSpreadsheet className="h-5 w-5" />
                    </div>
                    <p className="mt-3 text-xs font-semibold text-slate-700">
                      Listan är tom
                    </p>
                    <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-slate-500">
                      Exempel: Står det{" "}
                      <span className="font-semibold text-slate-700">
                        Microsoft
                      </span>{" "}
                      och{" "}
                      <span className="font-mono font-semibold text-slate-700">
                        Del001234567
                      </span>{" "}
                      på två paket visas{" "}
                      <span className="font-semibold text-emerald-700">
                        Kund Microsoft • Delivery • Del001234567 • Antal: 2
                      </span>
                      .
                    </p>
                  </div>
                ) : (
                  rows.map((row) => {
                    const isCurrentlyLocked = activeLockedId === row.id && isFilming;
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
                              Kund {row.customer} {row.category} •{" "}
                              {row.verifiedBy}
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
                    Granska alla detaljer &amp; ladda ner Excel (.xlsx)
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
