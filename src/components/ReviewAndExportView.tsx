import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileSpreadsheet,
  Image as ImageIcon,
  Minus,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { InventoryRow, PackageCategory } from "../types";

interface ReviewAndExportViewProps {
  rows: InventoryRow[];
  knownCustomers: string[];
  numberFormat: "title" | "upper";
  onChangeNumberFormat: (fmt: "title" | "upper") => void;
  columnMode: "standard_4col" | "combined_category";
  onChangeColumnMode: (mode: "standard_4col" | "combined_category") => void;
  autoDownloadOnStop: boolean;
  onChangeAutoDownload: (val: boolean) => void;
  onUpdateRows: (updated: InventoryRow[]) => void;
  onDownloadExcel: () => Promise<void>;
  onCopyForExcel: () => void;
  isDownloading: boolean;
  justFinishedVideo: boolean;
  onResumeFilming: () => void;
  onResetSession: () => void;
}

function formatNumberDisplay(row: InventoryRow, mode: "title" | "upper"): string {
  const raw = (mode === "upper" ? row.numberUpper : row.numberTitle) || row.id;
  if (mode === "upper") return raw.toUpperCase();
  let alphaLen = 0;
  while (alphaLen < raw.length && /[A-Za-z]/.test(raw[alphaLen])) {
    alphaLen++;
  }
  if (alphaLen > 0) {
    return (
      raw.slice(0, 1).toUpperCase() +
      raw.slice(1, alphaLen).toLowerCase() +
      raw.slice(alphaLen)
    );
  }
  return raw;
}

export const ReviewAndExportView: React.FC<ReviewAndExportViewProps> = ({
  rows,
  knownCustomers,
  numberFormat,
  onChangeNumberFormat,
  columnMode,
  onChangeColumnMode,
  autoDownloadOnStop,
  onChangeAutoDownload,
  onUpdateRows,
  onDownloadExcel,
  onCopyForExcel,
  isDownloading,
  justFinishedVideo,
  onResumeFilming,
  onResetSession,
}) => {
  const [filterCat, setFilterCat] = useState<
    "all" | "Delivery" | "Removal" | "unknown_customer"
  >("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

  // Manual add row state
  const [showAddForm, setShowAddForm] = useState(false);
  const [manualCustomer, setManualCustomer] = useState("");
  const [manualCategory, setManualCategory] =
    useState<PackageCategory>("Delivery");
  const [manualNumber, setManualNumber] = useState("");
  const [manualCount, setManualCount] = useState(1);

  const stats = useMemo(() => {
    let totalBoxes = 0;
    let deliveryBoxes = 0;
    let removalBoxes = 0;
    let unknownCustCount = 0;
    const customerSet = new Set<string>();

    for (const r of rows) {
      totalBoxes += r.count;
      if (r.category === "Delivery") deliveryBoxes += r.count;
      else removalBoxes += r.count;
      if (!r.customer || r.customer === "Okänd kund") {
        unknownCustCount += 1;
      } else {
        customerSet.add(r.customer.trim());
      }
    }
    return {
      totalBoxes,
      deliveryBoxes,
      removalBoxes,
      uniqueNumbers: rows.length,
      uniqueCustomers: customerSet.size,
      unknownCustCount,
    };
  }, [rows]);

  const sortedFilteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return [...rows]
      .filter((r) => {
        if (filterCat === "Delivery" && r.category !== "Delivery") return false;
        if (filterCat === "Removal" && r.category !== "Removal") return false;
        if (
          filterCat === "unknown_customer" &&
          r.customer &&
          r.customer !== "Okänd kund"
        ) {
          return false;
        }
        if (!q) return true;
        return (
          r.customer.toLowerCase().includes(q) ||
          r.numberUpper.toLowerCase().includes(q) ||
          r.category.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const ca = (a.customer || "Okänd kund").localeCompare(
          b.customer || "Okänd kund",
          "sv"
        );
        if (ca !== 0) return ca;
        if (a.category !== b.category) {
          return a.category === "Delivery" ? -1 : 1;
        }
        return a.numberUpper.localeCompare(b.numberUpper);
      });
  }, [rows, filterCat, searchQuery]);

  const updateRowField = (
    id: string,
    updater: (row: InventoryRow) => InventoryRow
  ) => {
    onUpdateRows(rows.map((r) => (r.id === id ? updater({ ...r }) : r)));
  };

  const deleteRow = (id: string) => {
    onUpdateRows(rows.filter((r) => r.id !== id));
    if (expandedRowId === id) setExpandedRowId(null);
  };

  const deleteSingleSnapshot = (rowId: string, snapId: string) => {
    const target = rows.find((r) => r.id === rowId);
    if (!target) return;
    if (target.count <= 1 && target.snapshots.length <= 1) {
      deleteRow(rowId);
      return;
    }
    updateRowField(rowId, (r) => ({
      ...r,
      count: Math.max(1, r.count - 1),
      snapshots: r.snapshots.filter((s) => s.id !== snapId),
    }));
  };

  const handleAddManual = (e: React.FormEvent) => {
    e.preventDefault();
    const rawNum = manualNumber.trim();
    if (!rawNum) return;

    const cleanCust = manualCustomer.trim() || "Okänd kund";
    const upper = rawNum.toUpperCase().replace(/\s+/g, "");
    // Auto-detect category from prefix if Rem/Rmv typed
    let cat: PackageCategory = manualCategory;
    if (/^(REM|RMV|RET)/i.test(upper)) cat = "Removal";
    else if (/^(DEL|DLV)/i.test(upper)) cat = "Delivery";

    let alpha = 0;
    while (alpha < upper.length && /[A-Z]/.test(upper[alpha])) alpha++;
    const titleNum =
      alpha > 0
        ? upper.slice(0, 1) + upper.slice(1, alpha).toLowerCase() + upper.slice(alpha)
        : upper;

    // Merge if identical canonical ID already exists!
    const existing = rows.find((r) => r.id === upper);
    if (existing) {
      updateRowField(upper, (r) => ({
        ...r,
        customer:
          r.customer === "Okänd kund" && cleanCust !== "Okänd kund"
            ? cleanCust
            : r.customer,
        count: r.count + Math.max(1, manualCount),
        lastUpdatedTs: Date.now(),
      }));
    } else {
      const newRow: InventoryRow = {
        id: upper,
        customer: cleanCust,
        category: cat,
        numberTitle: titleNum,
        numberUpper: upper,
        count: Math.max(1, manualCount),
        firstSeen: "Manuell",
        verifiedBy: "Manuell inmatning",
        snapshots: [],
        lastUpdatedTs: Date.now(),
      };
      onUpdateRows([newRow, ...rows]);
    }

    setManualNumber("");
    setManualCount(1);
    setShowAddForm(false);
  };

  return (
    <div className="space-y-5">
      {/* Datalist for customer autocomplete */}
      <datalist id="known-customers-list">
        {knownCustomers.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      {/* Top Completion & Primary Excel CTA Card */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              {justFinishedVideo ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Video avslutad – färdigkategoriserad
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
                  <FileSpreadsheet className="h-3.5 w-3.5" />
                  Granskning &amp; Excel-export
                </span>
              )}
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
              {rows.length > 0
                ? `${stats.totalBoxes} filmade paket redo som Excel-fil`
                : "Inga paket har filmats ännu"}
            </h1>
            <p className="text-sm text-slate-500">
              Kontrollera kund, Delivery/Removal och antal nedan (inklusive
              bildbevis per paket) och spara ner din färdiga{" "}
              <span className="font-mono text-xs font-semibold text-slate-700">
                .xlsx
              </span>
              -fil.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onResumeFilming}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <ArrowLeft className="h-4 w-4" />
              Fortsätt filma
            </button>

            <button
              type="button"
              onClick={onCopyForExcel}
              disabled={rows.length === 0}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="Kopierar tabellen så du kan klistra in direkt i Excel (Ctrl+V)"
            >
              <Copy className="h-4 w-4" />
              Kopiera till Excel
            </button>

            <button
              type="button"
              onClick={onDownloadExcel}
              disabled={rows.length === 0 || isDownloading}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {isDownloading
                ? "Skapar Excel..."
                : `Ladda ner Excel (.xlsx)`}
            </button>
          </div>
        </div>

        {/* KPI Summary Strip */}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3">
            <div className="text-xs font-medium text-slate-500">
              Totalt antal paket
            </div>
            <div className="mt-0.5 text-2xl font-bold tabular-nums text-slate-900">
              {stats.totalBoxes}
            </div>
            <div className="text-[11px] text-slate-400">
              {stats.uniqueNumbers} unika nummer
            </div>
          </div>

          <div className="rounded-xl border border-emerald-200/80 bg-emerald-50/50 px-4 py-3">
            <div className="text-xs font-medium text-emerald-800">
              Delivery-paket
            </div>
            <div className="mt-0.5 text-2xl font-bold tabular-nums text-emerald-700">
              {stats.deliveryBoxes}
            </div>
            <div className="text-[11px] text-emerald-600/80">Prefix DEL / DLV</div>
          </div>

          <div className="rounded-xl border border-amber-200/80 bg-amber-50/50 px-4 py-3">
            <div className="text-xs font-medium text-amber-800">
              Removal-paket
            </div>
            <div className="mt-0.5 text-2xl font-bold tabular-nums text-amber-700">
              {stats.removalBoxes}
            </div>
            <div className="text-[11px] text-amber-600/80">Prefix REM / RMV</div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3">
            <div className="text-xs font-medium text-slate-500">
              Identifierade kunder
            </div>
            <div className="mt-0.5 text-2xl font-bold tabular-nums text-slate-900">
              {stats.uniqueCustomers}
            </div>
            <div className="text-[11px] text-slate-400">
              {stats.unknownCustCount > 0
                ? `${stats.unknownCustCount} rad saknar kundnamn`
                : "Alla rader har kundnamn"}
            </div>
          </div>
        </div>
      </div>

      {/* Alert if any row had unreadable/missing customer text */}
      {stats.unknownCustCount > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5 text-sm text-amber-900">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>
              <strong>{stats.unknownCustCount} rad(er)</strong> hade inget
              synligt kundnamn på etiketten. Skriv in kundnamn i tabellen innan
              du sparar Excel.
            </span>
          </div>
          <button
            type="button"
            onClick={() =>
              setFilterCat(
                filterCat === "unknown_customer" ? "all" : "unknown_customer"
              )
            }
            className="self-start rounded-lg bg-amber-200/70 px-3 py-1 text-xs font-semibold text-amber-950 hover:bg-amber-200 sm:self-auto"
          >
            {filterCat === "unknown_customer"
              ? "Visa alla rader"
              : "Filtrera saknad kund"}
          </button>
        </div>
      )}

      {/* Excel Formatting & Filter Controls */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 lg:flex-row lg:items-center lg:justify-between">
          {/* Category Filter Pills + Search */}
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                { id: "all", label: `Alla (${rows.length})` },
                {
                  id: "Delivery",
                  label: `Delivery (${rows.filter((r) => r.category === "Delivery").length})`,
                },
                {
                  id: "Removal",
                  label: `Removal (${rows.filter((r) => r.category === "Removal").length})`,
                },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilterCat(tab.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  filterCat === tab.id
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200/70"
                }`}
              >
                {tab.label}
              </button>
            ))}

            <div className="relative ml-0 sm:ml-2">
              <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Sök kund eller nummer..."
                className="w-48 rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-3 text-xs text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          {/* Excel Output Options */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-1">
              <button
                type="button"
                onClick={() => onChangeNumberFormat("title")}
                className={`rounded-md px-2 py-1 font-mono text-[11px] font-medium ${
                  numberFormat === "title"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500"
                }`}
              >
                Del00123...
              </button>
              <button
                type="button"
                onClick={() => onChangeNumberFormat("upper")}
                className={`rounded-md px-2 py-1 font-mono text-[11px] font-medium ${
                  numberFormat === "upper"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500"
                }`}
              >
                DEL00123...
              </button>
            </div>

            <select
              value={columnMode}
              onChange={(e) =>
                onChangeColumnMode(
                  e.target.value as "standard_4col" | "combined_category"
                )
              }
              className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:border-slate-400 focus:outline-none"
              title="Välj kolumnuppbyggnad i Excel-filen"
            >
              <option value="standard_4col">
                Excel: Kund | Kategori | Nummer | Antal
              </option>
              <option value="combined_category">
                Excel: Kund Microsoft Delivery + separata kolumner
              </option>
            </select>

            <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={autoDownloadOnStop}
                onChange={(e) => onChangeAutoDownload(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              />
              Auto-spara Excel när video stängs
            </label>
          </div>
        </div>

        {/* Main Editable Inventory Table */}
        {sortedFilteredRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
              <Camera className="h-6 w-6" />
            </div>
            <h3 className="mt-3 text-sm font-semibold text-slate-800">
              {rows.length === 0
                ? "Inga paket i listan ännu"
                : "Inga rader matchar filtret"}
            </h3>
            <p className="mt-1 max-w-md text-xs text-slate-500">
              {rows.length === 0
                ? "Filma paket med kameran, ladda upp en video eller kör demovideon så kategoriseras alla Delivery- och Removal-nummer automatiskt."
                : "Prova att rensa sökningen eller visa alla kategorier."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/90 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3">Kund</th>
                  <th className="px-4 py-3">Kategori</th>
                  <th className="px-4 py-3">Nummer</th>
                  <th className="px-4 py-3 text-center">Antal</th>
                  <th className="px-4 py-3">Bildbevis &amp; Kontroll</th>
                  <th className="px-4 py-3 text-right">Åtgärd</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sortedFilteredRows.map((row) => {
                  const isExpanded = expandedRowId === row.id;
                  const missingCust =
                    !row.customer || row.customer === "Okänd kund";
                  return (
                    <React.Fragment key={row.id}>
                      <tr className="transition hover:bg-slate-50/70">
                        {/* KUND */}
                        <td className="px-4 py-3 align-middle">
                          <input
                            type="text"
                            list="known-customers-list"
                            value={row.customer}
                            onChange={(e) =>
                              updateRowField(row.id, (r) => ({
                                ...r,
                                customer: e.target.value,
                              }))
                            }
                            className={`w-40 rounded-lg border px-2.5 py-1.5 text-sm font-semibold focus:outline-none sm:w-48 ${
                              missingCust
                                ? "border-amber-400 bg-amber-50 text-amber-950"
                                : "border-transparent bg-transparent text-slate-900 hover:border-slate-200 focus:border-slate-400 focus:bg-white"
                            }`}
                          />
                          <div className="mt-0.5 px-2.5 text-[11px] text-slate-400">
                            Kund {row.customer || "?"} {row.category}
                          </div>
                        </td>

                        {/* KATEGORI */}
                        <td className="px-4 py-3 align-middle">
                          <button
                            type="button"
                            onClick={() =>
                              updateRowField(row.id, (r) => ({
                                ...r,
                                category:
                                  r.category === "Delivery"
                                    ? "Removal"
                                    : "Delivery",
                              }))
                            }
                            title="Klicka för att växla mellan Delivery och Removal"
                            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold transition ${
                              row.category === "Delivery"
                                ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                                : "bg-amber-100 text-amber-800 hover:bg-amber-200"
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                row.category === "Delivery"
                                  ? "bg-emerald-600"
                                  : "bg-amber-600"
                              }`}
                            />
                            {row.category}
                          </button>
                        </td>

                        {/* NUMMER */}
                        <td className="px-4 py-3 align-middle">
                          <input
                            type="text"
                            value={formatNumberDisplay(row, numberFormat)}
                            onChange={(e) => {
                              const val = e.target.value.trim();
                              updateRowField(row.id, (r) => ({
                                ...r,
                                numberTitle: val,
                                numberUpper: val.toUpperCase(),
                              }));
                            }}
                            className="w-40 rounded-lg border border-transparent bg-transparent px-2.5 py-1.5 font-mono text-sm font-semibold text-slate-900 hover:border-slate-200 focus:border-slate-400 focus:bg-white focus:outline-none"
                          />
                        </td>

                        {/* ANTAL (+/-) */}
                        <td className="px-4 py-3 text-center align-middle">
                          <div className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 p-1">
                            <button
                              type="button"
                              onClick={() =>
                                updateRowField(row.id, (r) => ({
                                  ...r,
                                  count: Math.max(1, r.count - 1),
                                }))
                              }
                              className="flex h-7 w-7 items-center justify-center rounded-lg bg-white text-slate-600 shadow-sm hover:bg-slate-100"
                              title="Minska antal"
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                            <span
                              className={`min-w-[2rem] text-center text-sm font-bold tabular-nums ${
                                row.count > 1
                                  ? "text-sky-700"
                                  : "text-slate-900"
                              }`}
                            >
                              {row.count}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                updateRowField(row.id, (r) => ({
                                  ...r,
                                  count: r.count + 1,
                                }))
                              }
                              className="flex h-7 w-7 items-center justify-center rounded-lg bg-white text-slate-600 shadow-sm hover:bg-slate-100"
                              title="Öka antal"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>

                        {/* BILDBEVIS & METOD */}
                        <td className="px-4 py-3 align-middle">
                          <div className="flex items-center gap-2">
                            <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                              {row.verifiedBy}
                            </span>
                            {row.snapshots.length > 0 && (
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedRowId(isExpanded ? null : row.id)
                                }
                                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                              >
                                <ImageIcon className="h-3 w-3 text-slate-500" />
                                {row.snapshots.length} foto
                                {isExpanded ? (
                                  <ChevronUp className="h-3 w-3" />
                                ) : (
                                  <ChevronDown className="h-3 w-3" />
                                )}
                              </button>
                            )}
                          </div>
                        </td>

                        {/* DELETE */}
                        <td className="px-4 py-3 text-right align-middle">
                          <button
                            type="button"
                            onClick={() => deleteRow(row.id)}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                            title="Ta bort rad"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>

                      {/* Expanded Photo Proof Drawer for verifying duplicates / digits */}
                      {isExpanded && row.snapshots.length > 0 && (
                        <tr className="bg-slate-50/90">
                          <td colSpan={6} className="px-6 py-4">
                            <div className="mb-2 flex items-center justify-between">
                              <span className="text-xs font-semibold text-slate-700">
                                Bildbevis för varje filmat exemplar av{" "}
                                <span className="font-mono">
                                  {formatNumberDisplay(row, numberFormat)}
                                </span>{" "}
                                ({row.snapshots.length} skanningar):
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-3">
                              {row.snapshots.map((snap, sIdx) => (
                                <div
                                  key={snap.id}
                                  className="flex w-52 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
                                >
                                  {snap.thumbnail ? (
                                    <img
                                      src={snap.thumbnail}
                                      alt={`Paket #${sIdx + 1}`}
                                      className="h-28 w-full bg-slate-900 object-contain"
                                    />
                                  ) : (
                                    <div className="flex h-28 items-center justify-center bg-slate-100 text-xs text-slate-400">
                                      Ingen miniatyrbild
                                    </div>
                                  )}
                                  <div className="flex items-center justify-between px-3 py-2 text-[11px]">
                                    <div>
                                      <div className="font-semibold text-slate-800">
                                        Paket #{sIdx + 1} • kl {snap.formattedTime}
                                      </div>
                                      <div className="text-slate-500">
                                        {snap.source}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        deleteSingleSnapshot(row.id, snap.id)
                                      }
                                      className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                                      title="Ta bort denna enskilda skanning (-1)"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Bottom Actions: Manual Add Row + Reset */}
        <div className="border-t border-slate-200 bg-slate-50/60 p-4">
          {showAddForm ? (
            <form
              onSubmit={handleAddManual}
              className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3.5"
            >
              <div>
                <label className="block text-[11px] font-semibold text-slate-600">
                  Kund
                </label>
                <input
                  type="text"
                  list="known-customers-list"
                  value={manualCustomer}
                  onChange={(e) => setManualCustomer(e.target.value)}
                  placeholder="t.ex. Microsoft"
                  className="mt-1 w-40 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600">
                  Kategori
                </label>
                <select
                  value={manualCategory}
                  onChange={(e) =>
                    setManualCategory(e.target.value as PackageCategory)
                  }
                  className="mt-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
                >
                  <option value="Delivery">Delivery</option>
                  <option value="Removal">Removal</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600">
                  Nummer
                </label>
                <input
                  type="text"
                  required
                  value={manualNumber}
                  onChange={(e) => setManualNumber(e.target.value)}
                  placeholder="t.ex. Del001234567"
                  className="mt-1 w-44 rounded-lg border border-slate-300 px-3 py-1.5 font-mono text-sm focus:border-slate-900 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600">
                  Antal
                </label>
                <input
                  type="number"
                  min={1}
                  value={manualCount}
                  onChange={(e) =>
                    setManualCount(Math.max(1, Number(e.target.value) || 1))
                  }
                  className="mt-1 w-20 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
                >
                  Spara rad
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                >
                  Avbryt
                </button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setShowAddForm(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <Plus className="h-3.5 w-3.5" />
                Lägg till paket manuellt
              </button>

              {rows.length > 0 && (
                <button
                  type="button"
                  onClick={onResetSession}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-rose-600 hover:bg-rose-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Nollställ &amp; börja ny inventering
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
