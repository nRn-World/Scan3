import React from "react";
import { Printer, QrCode, X } from "lucide-react";
import { encodeCode128SvgDataUrl } from "../lib/code128Codec";

interface TestLabelsModalProps {
  open: boolean;
  onClose: () => void;
}

const SAMPLE_LABELS = [
  {
    boxTag: "Låda #1 (7-siffrigt del-nummer med små bokstäver)",
    customer: "Microsoft",
    number: "del0615244",
    barcode: "del0615244",
    type: "Delivery",
  },
  {
    boxTag: "Låda #2 (Endast text 'del0615244' utan streckkod → ger Antal: 2)",
    customer: "Microsoft",
    number: "del0615244",
    barcode: null,
    type: "Delivery",
  },
  {
    boxTag: "Låda #3 (Removal med streckkod)",
    customer: "Microsoft",
    number: "Rem004455667",
    barcode: "REM004455667",
    type: "Removal",
  },
  {
    boxTag: "Låda #4 (Endast utskriven text utan streckkod)",
    customer: "Google",
    number: "del0619821",
    barcode: null,
    type: "Delivery",
  },
];

export const TestLabelsModal: React.FC<TestLabelsModalProps> = ({
  open,
  onClose,
}) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600 text-white">
              <QrCode className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Testetiketter för mobilkamera
              </h2>
              <p className="text-xs text-slate-500">
                Öppna appen på mobilen och filma dessa etiketter direkt på
                datorskärmen – eller skriv ut dem!
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Printer className="h-3.5 w-3.5" />
              Skriv ut
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-5 overflow-y-auto bg-slate-100 p-5 sm:grid-cols-2">
          {SAMPLE_LABELS.map((lbl, idx) => (
            <div
              key={idx}
              className="flex flex-col justify-between rounded-xl border-2 border-slate-300 bg-white p-5 shadow-sm"
            >
              <div>
                <div className="mb-3 flex items-center justify-between border-b border-slate-200 pb-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    {lbl.boxTag}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      lbl.type === "Delivery"
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-amber-100 text-amber-800"
                    }`}
                  >
                    {lbl.type}
                  </span>
                </div>
                <div className="py-2">
                  <div className="text-2xl font-bold tracking-tight text-slate-950">
                    {lbl.customer}
                  </div>
                  <div className="mt-2 font-mono text-xl font-bold text-slate-900">
                    {lbl.number}
                  </div>
                </div>
              </div>

              {lbl.barcode ? (
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <img
                    src={encodeCode128SvgDataUrl(lbl.barcode)}
                    alt={lbl.barcode}
                    className="h-14 w-full object-contain"
                  />
                </div>
              ) : (
                <div className="mt-3 rounded-lg bg-slate-50 py-3 text-center text-xs font-medium text-slate-500">
                  Endast textetikett (ingen streckkod)
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
