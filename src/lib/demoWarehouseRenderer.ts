import { encodeCode128SvgDataUrl } from "./code128Codec";

export interface DemoBoxSpec {
  boxIndex: number;
  customer: string;
  numberText: string;
  canonicalId: string;
  category: "Delivery" | "Removal";
  barcodeText?: string; // undefined = pure text label (tests OCR without barcode!)
  carrierTag: string;
  boxTint: string;
  tapeTint: string;
  weightText: string;
}

export const DEMO_WAREHOUSE_BOXES: DemoBoxSpec[] = [
  {
    boxIndex: 1,
    customer: "Microsoft",
    numberText: "Del001234567",
    canonicalId: "DEL001234567",
    category: "Delivery",
    barcodeText: "DEL001234567",
    carrierTag: "DHL EXPRESS",
    boxTint: "#caa472",
    tapeTint: "#b08954",
    weightText: "14.2 KG",
  },
  {
    boxIndex: 2,
    customer: "Microsoft",
    numberText: "Del001234567",
    canonicalId: "DEL001234567",
    category: "Delivery",
    barcodeText: "DEL001234567",
    carrierTag: "DHL EXPRESS",
    boxTint: "#bfa074",
    tapeTint: "#9b7b4d",
    weightText: "14.2 KG",
  },
  {
    boxIndex: 3,
    customer: "Microsoft",
    numberText: "Rem004455667",
    canonicalId: "REM004455667",
    category: "Removal",
    barcodeText: "REM004455667",
    carrierTag: "POSTNORD",
    boxTint: "#c79d6b",
    tapeTint: "#a67c4e",
    weightText: "8.5 KG",
  },
  {
    boxIndex: 4,
    customer: "Google",
    numberText: "Del009876543",
    canonicalId: "DEL009876543",
    category: "Delivery",
    barcodeText: undefined,
    carrierTag: "UPS",
    boxTint: "#d1ae7e",
    tapeTint: "#b28d5c",
    weightText: "21.0 KG",
  },
  {
    boxIndex: 5,
    customer: "Ericsson",
    numberText: "Rem007788991",
    canonicalId: "REM007788991",
    category: "Removal",
    barcodeText: "REM007788991",
    carrierTag: "DB SCHENKER",
    boxTint: "#c29b69",
    tapeTint: "#9e7748",
    weightText: "11.8 KG",
  },
  {
    boxIndex: 6,
    customer: "Google",
    numberText: "Del009876543",
    canonicalId: "DEL009876543",
    category: "Delivery",
    barcodeText: undefined,
    carrierTag: "UPS",
    boxTint: "#c8a371",
    tapeTint: "#a88251",
    weightText: "21.0 KG",
  },
];

const DWELL_SEC = 2.05;
const PAN_SEC = 1.4;
const STEP_SEC = DWELL_SEC + PAN_SEC;
export const DEMO_TOTAL_DURATION_SEC =
  DEMO_WAREHOUSE_BOXES.length * STEP_SEC - PAN_SEC + 0.8;

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

export interface ProjectedDemoLabel {
  box: DemoBoxSpec;
  labelBboxNorm: [number, number, number, number];
  edgeClipped: boolean;
}

export class DemoWarehouseRenderer {
  private barcodeImages: Map<string, HTMLImageElement> = new Map();

  public async preloadBarcodes(): Promise<void> {
    const uniqueCodes = Array.from(
      new Set(
        DEMO_WAREHOUSE_BOXES.map((b) => b.barcodeText).filter(
          (x): x is string => Boolean(x)
        )
      )
    );

    await Promise.all(
      uniqueCodes.map(
        (code) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              this.barcodeImages.set(code, img);
              resolve();
            };
            img.onerror = () => resolve();
            img.src = encodeCode128SvgDataUrl(code);
          })
      )
    );
  }

  private computeCamOffset(
    width: number,
    height: number,
    elapsedSec: number
  ): { camX: number; shelfY: number; boxSpacing: number } {
    const boxSpacing = width * 1.38;
    const segIdx = Math.min(
      DEMO_WAREHOUSE_BOXES.length - 1,
      Math.max(0, Math.floor(elapsedSec / STEP_SEC))
    );
    const localT = elapsedSec - segIdx * STEP_SEC;

    let virtualBoxPos = segIdx;
    if (localT > DWELL_SEC && segIdx < DEMO_WAREHOUSE_BOXES.length - 1) {
      const panProgress = smoothstep((localT - DWELL_SEC) / PAN_SEC);
      virtualBoxPos = segIdx + panProgress;
    }

    const swayX = Math.sin(elapsedSec * 2.3) * 5;
    const swayY = Math.cos(elapsedSec * 1.9) * 4;
    const camX = virtualBoxPos * boxSpacing + swayX;
    const shelfY = height * 0.85 + swayY;
    return { camX, shelfY, boxSpacing };
  }

  public getProjectedLabels(
    width: number,
    height: number,
    elapsedSec: number
  ): ProjectedDemoLabel[] {
    const { camX, shelfY, boxSpacing } = this.computeCamOffset(
      width,
      height,
      elapsedSec
    );
    const results: ProjectedDemoLabel[] = [];

    DEMO_WAREHOUSE_BOXES.forEach((box, i) => {
      const boxWorldX = i * boxSpacing;
      const cx = width / 2 + (boxWorldX - camX);
      const boxW = width * 0.66;
      const boxH = height * 0.72;
      const by = shelfY - boxH;
      const lw = boxW * 0.78;
      const lh = boxH * 0.72;
      const lx = cx - lw / 2;
      const ly = by + boxH * 0.14;

      // Text & barcode active region inside the label
      const tx1 = lx + lw * 0.06;
      const tx2 = lx + lw * 0.92;
      const ty1 = ly + lh * 0.28;
      const ty2 = ly + lh * 0.9;

      // Check if at least 35% of the label is inside the viewport
      const visX1 = Math.max(0, tx1);
      const visX2 = Math.min(width, tx2);
      if (visX2 - visX1 < (tx2 - tx1) * 0.35) {
        return;
      }

      const x1n = Math.max(0, tx1 / width);
      const y1n = Math.max(0, ty1 / height);
      const x2n = Math.min(1, tx2 / width);
      const y2n = Math.min(1, ty2 / height);
      const edgeClipped = tx1 < width * 0.02 || tx2 > width * 0.98;

      results.push({
        box,
        labelBboxNorm: [
          Number(x1n.toFixed(4)),
          Number(y1n.toFixed(4)),
          Number(x2n.toFixed(4)),
          Number(y2n.toFixed(4)),
        ],
        edgeClipped,
      });
    });

    return results;
  }

  public renderFrame(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    elapsedSec: number
  ): void {
    const { camX, shelfY, boxSpacing } = this.computeCamOffset(
      width,
      height,
      elapsedSec
    );

    const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
    bgGrad.addColorStop(0, "#1e293b");
    bgGrad.addColorStop(0.75, "#0f172a");
    bgGrad.addColorStop(1, "#334155");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "#ea580c";
    ctx.fillRect(0, shelfY, width, height * 0.085);
    ctx.fillStyle = "#9a3412";
    ctx.fillRect(0, shelfY + height * 0.085, width, height * 0.02);

    for (let i = -1; i <= DEMO_WAREHOUSE_BOXES.length; i++) {
      const pillarWorldX = (i + 0.5) * boxSpacing;
      const px = width / 2 + (pillarWorldX - camX);
      if (px > -90 && px < width + 90) {
        ctx.fillStyle = "#2563eb";
        ctx.fillRect(px - 22, 0, 44, shelfY);
        ctx.fillStyle = "#1e3a8a";
        for (let hy = 24; hy < shelfY - 20; hy += 38) {
          ctx.fillRect(px - 7, hy, 14, 18);
        }
      }
    }

    DEMO_WAREHOUSE_BOXES.forEach((box, i) => {
      const boxWorldX = i * boxSpacing;
      const cx = width / 2 + (boxWorldX - camX);
      if (cx < -width || cx > width * 2) return;

      const boxW = width * 0.66;
      const boxH = height * 0.72;
      const bx = cx - boxW / 2;
      const by = shelfY - boxH;

      ctx.fillStyle = "rgba(0, 0, 0, 0.38)";
      ctx.fillRect(bx + 12, by + 10, boxW, boxH);

      ctx.fillStyle = box.boxTint;
      ctx.fillRect(bx, by, boxW, boxH);

      ctx.fillStyle = box.tapeTint;
      ctx.fillRect(bx, by + 16, boxW, 24);
      ctx.strokeStyle = "rgba(60, 40, 20, 0.28)";
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, boxW, boxH);

      ctx.fillStyle = "rgba(30, 20, 10, 0.65)";
      ctx.font = `bold ${Math.round(width * 0.022)}px Inter, Arial, sans-serif`;
      ctx.fillText(`FYSISKT KOLLI #${box.boxIndex}`, bx + 20, by + boxH - 18);

      const lw = boxW * 0.78;
      const lh = boxH * 0.72;
      const lx = cx - lw / 2;
      const ly = by + boxH * 0.14;

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(lx, ly, lw, lh);
      ctx.strokeStyle = "#cbd5e1";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(lx, ly, lw, lh);

      ctx.fillStyle = "#0f172a";
      ctx.font = `bold ${Math.round(lw * 0.048)}px Arial, sans-serif`;
      ctx.fillText(box.carrierTag, lx + lw * 0.06, ly + lh * 0.13);

      ctx.fillStyle = "#475569";
      ctx.font = `${Math.round(lw * 0.042)}px Arial, sans-serif`;
      ctx.fillText(box.weightText, lx + lw * 0.72, ly + lh * 0.13);

      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(lx + lw * 0.05, ly + lh * 0.18);
      ctx.lineTo(lx + lw * 0.95, ly + lh * 0.18);
      ctx.stroke();

      ctx.fillStyle = "#090d16";
      ctx.font = `bold ${Math.round(lw * 0.105)}px Arial, Helvetica, sans-serif`;
      ctx.fillText(box.customer, lx + lw * 0.07, ly + lh * 0.39);

      ctx.fillStyle = "#090d16";
      ctx.font = `bold ${Math.round(lw * 0.088)}px Arial, Helvetica, sans-serif`;
      ctx.fillText(box.numberText, lx + lw * 0.07, ly + lh * 0.58);

      if (box.barcodeText) {
        const bcImg = this.barcodeImages.get(box.barcodeText);
        if (bcImg) {
          const bcW = lw * 0.84;
          const bcH = lh * 0.26;
          ctx.drawImage(bcImg, lx + lw * 0.08, ly + lh * 0.66, bcW, bcH);
        }
      } else {
        ctx.fillStyle = "#64748b";
        ctx.font = `${Math.round(lw * 0.038)}px Arial, sans-serif`;
        ctx.fillText("TEXT-ETIKETT UTAN STRECKKOD", lx + lw * 0.07, ly + lh * 0.82);
      }
    });
  }
}
