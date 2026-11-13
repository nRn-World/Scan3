from __future__ import annotations

import io
from datetime import datetime
from typing import List, Literal, Optional

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from pydantic import BaseModel, Field


class ExportRowItem(BaseModel):
    customer: str = Field(default="Okänd kund")
    category: str = Field(default="Delivery")  # "Delivery" | "Removal"
    number: str
    count: int = Field(default=1, ge=1)
    first_seen: Optional[str] = None
    verified_by: Optional[str] = None


class ExportExcelRequest(BaseModel):
    items: List[ExportRowItem]
    number_format: Literal["title", "upper"] = "title"
    column_mode: Literal["standard_4col", "combined_category"] = "standard_4col"
    include_metadata: bool = False
    session_title: str = "Videoinventering"


def format_number_case(num: str, mode: Literal["title", "upper"]) -> str:
    s = num.strip()
    if not s:
        return s
    if mode == "upper":
        return s.upper()
    # Title prefix: e.g. DEL001234567 -> Del001234567, REM00123 -> Rem00123
    m_alpha = 0
    while m_alpha < len(s) and s[m_alpha].isalpha():
        m_alpha += 1
    if m_alpha > 0:
        return s[:m_alpha].capitalize() + s[m_alpha:]
    return s


def build_inventory_workbook_bytes(req: ExportExcelRequest) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Inventering"

    # Typography & Palette (clean, high-legibility spreadsheet styling)
    font_header = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    font_cell = Font(name="Calibri", size=11, bold=False, color="111827")
    font_customer = Font(name="Calibri", size=11, bold=True, color="111827")
    font_number = Font(name="Consolas", size=11, bold=False, color="1F2937")
    font_count = Font(name="Calibri", size=11, bold=True, color="111827")
    font_delivery = Font(name="Calibri", size=11, bold=True, color="065F46")
    font_removal = Font(name="Calibri", size=11, bold=True, color="9A3412")
    font_total = Font(name="Calibri", size=11, bold=True, color="0F172A")

    fill_header = PatternFill(start_color="0F172A", end_color="0F172A", fill_type="solid")
    fill_zebra = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")
    fill_white = PatternFill(start_color="FFFFFF", end_color="FFFFFF", fill_type="solid")
    fill_delivery = PatternFill(start_color="D1FAE5", end_color="D1FAE5", fill_type="solid")
    fill_removal = PatternFill(start_color="FFEDD5", end_color="FFEDD5", fill_type="solid")
    fill_total = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")

    thin_side = Side(border_style="thin", color="CBD5E1")
    med_top = Side(border_style="medium", color="64748B")
    double_bottom = Side(border_style="double", color="475569")

    border_data = Border(left=thin_side, right=thin_side, top=thin_side, bottom=thin_side)
    border_total = Border(left=thin_side, right=thin_side, top=med_top, bottom=double_bottom)

    # Sort cleanly: Customer A-Z -> Delivery before Removal -> Number A-Z
    sorted_items = sorted(
        req.items,
        key=lambda x: (
            (x.customer or "Okänd kund").strip().lower(),
            0 if x.category.lower() == "delivery" else 1,
            x.number.upper(),
        ),
    )

    if req.column_mode == "combined_category":
        headers = ["Kategorisering", "Kund", "Typ", "Nummer", "Antal"]
    else:
        headers = ["Kund", "Kategori", "Nummer", "Antal"]

    if req.include_metadata:
        headers.extend(["Först filmad", "Avläsning"])

    ws.append(headers)
    ws.row_dimensions[1].height = 26

    for col_idx in range(1, len(headers) + 1):
        c = ws.cell(row=1, column=col_idx)
        c.font = font_header
        c.fill = fill_header
        c.alignment = Alignment(
            horizontal="center" if headers[col_idx - 1] == "Antal" else "left",
            vertical="center",
        )
        c.border = border_data

    count_col_idx = headers.index("Antal") + 1

    for idx, item in enumerate(sorted_items, start=2):
        cust = (item.customer or "Okänd kund").strip()
        cat = "Removal" if item.category.strip().lower() == "removal" else "Delivery"
        formatted_num = format_number_case(item.number, req.number_format)
        row_fill = fill_white if idx % 2 == 0 else fill_zebra

        if req.column_mode == "combined_category":
            combined_label = f"Kund {cust} {cat}"
            row_vals = [combined_label, cust, cat, formatted_num, int(item.count)]
        else:
            row_vals = [cust, cat, formatted_num, int(item.count)]

        if req.include_metadata:
            row_vals.extend([item.first_seen or "-", item.verified_by or "OCR"])

        ws.append(row_vals)
        ws.row_dimensions[idx].height = 22

        for c_i in range(1, len(headers) + 1):
            cell = ws.cell(row=idx, column=c_i)
            col_name = headers[c_i - 1]
            cell.border = border_data
            cell.fill = row_fill
            cell.font = font_cell
            cell.alignment = Alignment(horizontal="left", vertical="center")

            if col_name in ("Kund", "Kategorisering"):
                cell.font = font_customer
            elif col_name in ("Kategori", "Typ"):
                is_del = cat == "Delivery"
                cell.font = font_delivery if is_del else font_removal
                cell.fill = fill_delivery if is_del else fill_removal
                cell.alignment = Alignment(horizontal="center", vertical="center")
            elif col_name == "Nummer":
                cell.font = font_number
                cell.number_format = "@"
            elif col_name == "Antal":
                cell.font = font_count
                cell.number_format = "0"
                cell.alignment = Alignment(horizontal="center", vertical="center")

    # Add clean Total row at bottom
    last_data_row = len(sorted_items) + 1
    total_row_idx = last_data_row + 1
    ws.row_dimensions[total_row_idx].height = 25

    count_col_letter = get_column_letter(count_col_idx)
    for c_i in range(1, len(headers) + 1):
        cell = ws.cell(row=total_row_idx, column=c_i)
        cell.fill = fill_total
        cell.border = border_total
        cell.font = font_total
        if c_i == 1:
            cell.value = f"Totalt ({len(sorted_items)} unika nummer)"
            cell.alignment = Alignment(horizontal="left", vertical="center")
        elif c_i == count_col_idx:
            if len(sorted_items) > 0:
                cell.value = f"=SUM({count_col_letter}2:{count_col_letter}{last_data_row})"
            else:
                cell.value = 0
            cell.number_format = "0"
            cell.alignment = Alignment(horizontal="center", vertical="center")

    # Freeze header & add AutoFilter across data rows
    ws.freeze_panes = "A2"
    if last_data_row >= 1:
        last_col_letter = get_column_letter(len(headers))
        ws.auto_filter.ref = f"A1:{last_col_letter}{max(1, last_data_row)}"

    # Set clean generous column widths so nothing is ever truncated (###)
    width_map = {
        "Kategorisering": 32,
        "Kund": 24,
        "Kategori": 16,
        "Typ": 16,
        "Nummer": 22,
        "Antal": 12,
        "Först filmad": 16,
        "Avläsning": 18,
    }
    for c_i, h_name in enumerate(headers, start=1):
        col_letter = get_column_letter(c_i)
        max_len = max(
            [len(h_name)]
            + [
                len(str(ws.cell(row=r, column=c_i).value or ""))
                for r in range(2, last_data_row + 1)
            ]
        )
        ws.column_dimensions[col_letter].width = max(width_map.get(h_name, 16), min(44, max_len + 5))

    ws.views.sheetView[0].showGridLines = True

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
