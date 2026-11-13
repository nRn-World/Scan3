import React, { useState } from "react";
import { Building2, Plus, Search, Trash2, X } from "lucide-react";

interface CustomerModalProps {
  open: boolean;
  onClose: () => void;
  customers: string[];
  onSaveCustomers: (updated: string[]) => Promise<void>;
}

export const CustomerModal: React.FC<CustomerModalProps> = ({
  open,
  onClose,
  customers,
  onSaveCustomers,
}) => {
  const [newCustomer, setNewCustomer] = useState("");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const filtered = customers.filter((c) =>
    c.toLowerCase().includes(search.trim().toLowerCase())
  );

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newCustomer.trim();
    if (!trimmed) return;
    if (customers.some((c) => c.toLowerCase() === trimmed.toLowerCase())) {
      setNewCustomer("");
      return;
    }
    setSaving(true);
    try {
      await onSaveCustomers([trimmed, ...customers]);
      setNewCustomer("");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (target: string) => {
    setSaving(true);
    try {
      await onSaveCustomers(customers.filter((c) => c !== target));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Kända kunder ({customers.length})
              </h2>
              <p className="text-xs text-slate-500">
                Hjälper OCR-motorn att rättstava och känna igen kundnamn direkt
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3 border-b border-slate-100 p-5">
          <form onSubmit={handleAdd} className="flex gap-2">
            <input
              type="text"
              value={newCustomer}
              onChange={(e) => setNewCustomer(e.target.value)}
              placeholder="Lägg till kundnamn, t.ex. Equinix eller Microsoft..."
              className="flex-1 rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
            />
            <button
              type="submit"
              disabled={saving || !newCustomer.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              Lägg till
            </button>
          </form>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Sök bland sparade kunder..."
              className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-xs text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:bg-white focus:outline-none"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <p className="mb-2.5 text-xs text-slate-500">
            Appen läser även nya kundnamn fritt från etiketten, men namn i denna
            lista får extra stavningskontroll (t.ex. &ldquo;Microsft&rdquo; →{" "}
            <span className="font-medium text-slate-700">Microsoft</span>).
          </p>
          <div className="flex flex-wrap gap-2">
            {filtered.map((cust) => (
              <span
                key={cust}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-800"
              >
                {cust}
                <button
                  type="button"
                  onClick={() => handleRemove(cust)}
                  className="rounded p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  title={`Ta bort ${cust}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
            {filtered.length === 0 && (
              <p className="py-6 text-center text-sm text-slate-400 w-full">
                Inga kunder matchar din sökning.
              </p>
            )}
          </div>
        </div>

        <div className="flex justify-end border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Klar
          </button>
        </div>
      </div>
    </div>
  );
};
