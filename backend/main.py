from __future__ import annotations

import asyncio
import base64
import json
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import List, Optional

import cv2
import numpy as np
import zxingcpp
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.excel_exporter import ExportExcelRequest, build_inventory_workbook_bytes
from backend.scanner_engine import DEFAULT_KNOWN_CUSTOMERS, LabelScannerEngine

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
EXPORTS_DIR = BASE_DIR / "exports"
STATIC_DIR = BASE_DIR / "static_bundle"

DATA_DIR.mkdir(parents=True, exist_ok=True)
EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
CUSTOMERS_FILE = DATA_DIR / "customers.json"

app = FastAPI(title="LagerScan Videoinventering API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Singleton recognition engine + lock so ONNX CPU threads stay clean on 2-core machines
scanner_engine = LabelScannerEngine()
engine_lock = asyncio.Lock()


def load_customers() -> List[str]:
    if CUSTOMERS_FILE.exists():
        try:
            data = json.loads(CUSTOMERS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, list) and all(isinstance(x, str) for x in data):
                return data
        except Exception:
            pass
    CUSTOMERS_FILE.write_text(
        json.dumps(DEFAULT_KNOWN_CUSTOMERS, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return list(DEFAULT_KNOWN_CUSTOMERS)


def save_customers(customers: List[str]) -> List[str]:
    seen = set()
    cleaned: List[str] = []
    for c in customers:
        s = c.strip()
        if s and s.lower() not in seen:
            seen.add(s.lower())
            cleaned.append(s)
    CUSTOMERS_FILE.write_text(
        json.dumps(cleaned, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return cleaned


class AnalyzeFrameRequest(BaseModel):
    image_base64: str
    known_customers: Optional[List[str]] = None
    default_customer: str = ""


class CustomersUpdateRequest(BaseModel):
    customers: List[str]


def _decode_base64_image(data_uri: str) -> np.ndarray:
    raw = data_uri.split(",", 1)[1] if "," in data_uri else data_uri
    img_bytes = base64.b64decode(raw)
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("Kunde inte avkoda bildrutan.")
    return bgr


@app.get("/api/health")
async def health() -> dict:
    return {
        "status": "ok",
        "engine": "PP-OCRv4 + ZXing-CPP",
        "customers_count": len(load_customers()),
    }


@app.get("/api/customers")
async def get_customers() -> dict:
    return {"customers": load_customers()}


@app.post("/api/customers")
async def update_customers(req: CustomersUpdateRequest) -> dict:
    saved = save_customers(req.customers)
    return {"customers": saved}


@app.get("/api/barcode-svg")
async def get_barcode_svg(
    text: str = Query(..., min_length=2, max_length=64),
    fmt: str = Query("code128"),
) -> Response:
    bc_fmt = (
        zxingcpp.BarcodeFormat.QRCode
        if fmt.lower() == "qr"
        else zxingcpp.BarcodeFormat.Code128
    )
    bc = zxingcpp.create_barcode(text.strip(), bc_fmt)
    svg = zxingcpp.write_barcode_to_svg(bc)
    return Response(content=svg, media_type="image/svg+xml")


@app.post("/api/analyze-frame")
async def analyze_frame(req: AnalyzeFrameRequest) -> dict:
    try:
        bgr = _decode_base64_image(req.image_base64)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    customers = req.known_customers if req.known_customers is not None else load_customers()
    async with engine_lock:
        result = await asyncio.to_thread(
            scanner_engine.analyze_image,
            bgr,
            customers,
            req.default_customer,
        )
    return result


@app.post("/api/analyze-video-stream")
async def analyze_video_stream(
    video: UploadFile = File(...),
    sample_interval_sec: float = Form(0.32),
    default_customer: str = Form(""),
    known_customers_json: str = Form(""),
) -> StreamingResponse:
    suffix = Path(video.filename or "upload.mp4").suffix or ".mp4"
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    os.close(tmp_fd)

    try:
        content = await video.read()
        Path(tmp_path).write_bytes(content)
    except Exception as exc:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise HTTPException(status_code=400, detail=f"Kunde inte läsa videofilen: {exc}") from exc

    customers = load_customers()
    if known_customers_json.strip():
        try:
            parsed_c = json.loads(known_customers_json)
            if isinstance(parsed_c, list):
                customers = [str(x) for x in parsed_c]
        except Exception:
            pass

    interval = max(0.15, min(1.5, float(sample_interval_sec)))

    async def frame_generator():
        cap = cv2.VideoCapture(tmp_path)
        try:
            if not cap.isOpened():
                yield json.dumps({"type": "error", "message": "Kunde inte öppna videofilen."}) + "\n"
                return

            fps = cap.get(cv2.CAP_PROP_FPS)
            if not fps or fps <= 1 or fps > 240:
                fps = 30.0
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            duration_sec = (total_frames / fps) if total_frames > 0 else 0.0
            step_frames = max(1, int(round(fps * interval)))

            yield json.dumps(
                {
                    "type": "meta",
                    "fps": round(fps, 2),
                    "total_frames": total_frames,
                    "duration_sec": round(duration_sec, 2),
                }
            ) + "\n"

            frame_idx = 0
            analyzed_count = 0
            while True:
                ok, frame = cap.read()
                if not ok or frame is None:
                    break

                if frame_idx % step_frames == 0:
                    ts_sec = frame_idx / fps
                    async with engine_lock:
                        analysis = await asyncio.to_thread(
                            scanner_engine.analyze_image,
                            frame,
                            customers,
                            default_customer,
                        )

                    # Encode lightweight preview JPEG so UI shows real video + live bounding boxes
                    fh, fw = frame.shape[:2]
                    max_pw = 680
                    prev_img = (
                        cv2.resize(
                            frame,
                            (max_pw, max(60, int(fh * (max_pw / fw)))),
                            interpolation=cv2.INTER_AREA,
                        )
                        if fw > max_pw
                        else frame
                    )
                    ok_jpg, jpg_buf = cv2.imencode(
                        ".jpg", prev_img, [int(cv2.IMWRITE_JPEG_QUALITY), 72]
                    )
                    prev_b64 = (
                        "data:image/jpeg;base64,"
                        + base64.b64encode(jpg_buf.tobytes()).decode("ascii")
                        if ok_jpg
                        else ""
                    )

                    prog = (
                        min(0.99, frame_idx / total_frames)
                        if total_frames > 0
                        else 0.5
                    )
                    analyzed_count += 1
                    yield json.dumps(
                        {
                            "type": "frame",
                            "frame_index": frame_idx,
                            "timestamp_sec": round(ts_sec, 2),
                            "progress": round(prog, 4),
                            "preview_jpg": prev_b64,
                            "analysis": analysis,
                        }
                    ) + "\n"
                    await asyncio.sleep(0.005)

                frame_idx += 1

            yield json.dumps(
                {
                    "type": "done",
                    "analyzed_frames": analyzed_count,
                    "progress": 1.0,
                }
            ) + "\n"
        finally:
            cap.release()
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

    return StreamingResponse(frame_generator(), media_type="application/x-ndjson")


@app.post("/api/export-excel")
async def export_excel(req: ExportExcelRequest) -> Response:
    xlsx_bytes = await asyncio.to_thread(build_inventory_workbook_bytes, req)
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    filename = f"Inventering_{stamp}.xlsx"

    # Persist latest exported Excel file in workspace as well
    try:
        (EXPORTS_DIR / filename).write_bytes(xlsx_bytes)
        Path("/home/user/Senaste_Inventering.xlsx").write_bytes(xlsx_bytes)
    except Exception:
        pass

    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


# Mount compiled frontend assets if built
if (STATIC_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR / "assets")), name="assets")


@app.api_route("/{full_path:path}", methods=["GET", "HEAD"])
async def serve_spa(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="API endpoint hittades inte.")
    candidate = STATIC_DIR / full_path
    if full_path and candidate.is_file():
        return FileResponse(str(candidate))
    index_file = STATIC_DIR / "index.html"
    if index_file.is_file():
        return FileResponse(str(index_file))
    return Response(
        content="Frontend byggs...",
        media_type="text/plain; charset=utf-8",
    )
