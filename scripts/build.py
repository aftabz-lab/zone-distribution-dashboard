#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import shutil
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from posixpath import normpath

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
CONFIG_DIR = ROOT / "config"
WEB_DIR = ROOT / "web"
SITE_DIR = ROOT / "site"

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

def norm_header(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()

def col_number(cell_ref: str) -> int:
    letters = re.match(r"[A-Z]+", cell_ref)
    if not letters:
        return 0
    n = 0
    for ch in letters.group(0):
        n = n * 26 + ord(ch) - 64
    return n

def excel_serial_to_iso(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        number = float(text)
        dt = datetime(1899, 12, 30) + timedelta(days=number)
        return dt.date().isoformat()
    except Exception:
        pass

    # Keep commonly used date strings sortable if possible.
    for fmt in (
        "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y",
        "%d-%b-%Y", "%d %b %Y", "%Y/%m/%d"
    ):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return text

def read_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    result = []
    for si in root.findall(f"{{{MAIN_NS}}}si"):
        result.append("".join(t.text or "" for t in si.iter(f"{{{MAIN_NS}}}t")))
    return result

def read_sheet_rows(zf: zipfile.ZipFile, sheet_target: str, shared: list[str]) -> list[dict[int, str]]:
    # Relationship target is normally worksheets/sheet1.xml.
    target = sheet_target.lstrip("/")
    if not target.startswith("xl/"):
        target = "xl/" + target
    target = normpath(target)

    root = ET.fromstring(zf.read(target))
    sheet_data = root.find(f"{{{MAIN_NS}}}sheetData")
    if sheet_data is None:
        return []

    rows: list[dict[int, str]] = []
    for row in sheet_data.findall(f"{{{MAIN_NS}}}row"):
        values: dict[int, str] = {}
        for cell in row.findall(f"{{{MAIN_NS}}}c"):
            ref = cell.attrib.get("r", "")
            idx = col_number(ref)
            if not idx:
                continue

            cell_type = cell.attrib.get("t")
            value_node = cell.find(f"{{{MAIN_NS}}}v")
            value = ""

            if cell_type == "inlineStr":
                inline = cell.find(f"{{{MAIN_NS}}}is")
                if inline is not None:
                    value = "".join(t.text or "" for t in inline.iter(f"{{{MAIN_NS}}}t"))
            elif value_node is not None:
                raw = value_node.text or ""
                if cell_type == "s":
                    try:
                        value = shared[int(raw)]
                    except Exception:
                        value = raw
                elif cell_type == "b":
                    value = "TRUE" if raw == "1" else "FALSE"
                else:
                    value = raw

            values[idx] = value
        rows.append(values)
    return rows

def workbook_sheets(path: Path) -> list[tuple[str, list[dict[int, str]]]]:
    with zipfile.ZipFile(path) as zf:
        shared = read_shared_strings(zf)
        wb_root = ET.fromstring(zf.read("xl/workbook.xml"))
        rel_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        relmap = {
            r.attrib["Id"]: r.attrib["Target"]
            for r in rel_root.findall(f"{{{PKG_REL_NS}}}Relationship")
        }

        sheets: list[tuple[str, list[dict[int, str]]]] = []
        sheets_node = wb_root.find(f"{{{MAIN_NS}}}sheets")
        if sheets_node is None:
            return sheets

        for sheet in sheets_node:
            name = sheet.attrib.get("name", "")
            rid = sheet.attrib.get(f"{{{OFFICE_REL_NS}}}id")
            if rid and rid in relmap:
                sheets.append((name, read_sheet_rows(zf, relmap[rid], shared)))
        return sheets

def row_to_list(row: dict[int, str], width: int) -> list[str]:
    return [row.get(i, "") for i in range(1, width + 1)]

def detect_source(schema: dict) -> tuple[Path, str, int, dict[str, int], list[dict[int, str]]]:
    required = schema["requiredHeaders"]
    required_norm = {norm_header(h): h for h in required}
    scan_rows = int(schema.get("headerScanRows", 20))

    workbooks = sorted(
        p for p in DATA_DIR.glob("*.xlsx")
        if not p.name.startswith("~$")
    )
    if not workbooks:
        raise RuntimeError(
            "No .xlsx workbook was found in /data. Upload exactly one workbook with the required headers."
        )

    matches = []
    diagnostics = []

    for path in workbooks:
        try:
            sheets = workbook_sheets(path)
        except Exception as exc:
            diagnostics.append(f"{path.name}: could not read workbook ({exc})")
            continue

        for sheet_name, rows in sheets:
            for row_index, row in enumerate(rows[:scan_rows], start=1):
                max_col = max(row.keys(), default=0)
                values = row_to_list(row, max_col)
                norm_values = [norm_header(v) for v in values]
                present = set(norm_values)
                if set(required_norm).issubset(present):
                    colmap = {}
                    for pos, norm_value in enumerate(norm_values, start=1):
                        if norm_value in required_norm and required_norm[norm_value] not in colmap:
                            colmap[required_norm[norm_value]] = pos
                    if len(colmap) == len(required):
                        matches.append((path, sheet_name, row_index, colmap, rows))
                elif row_index == 1 and values:
                    missing = [
                        required_norm[n]
                        for n in required_norm
                        if n not in present
                    ]
                    diagnostics.append(
                        f"{path.name} / {sheet_name}: header row 1 missing "
                        + ", ".join(missing[:6])
                        + (" ..." if len(missing) > 6 else "")
                    )

    if not matches:
        expected = "\n  - ".join(required)
        detail = "\n".join(diagnostics[:12])
        raise RuntimeError(
            "No worksheet matches the required Zone Distribution schema.\n"
            "The Excel filename and worksheet name may change, but these headers must remain present:\n"
            f"  - {expected}\n\nDetected workbook details:\n{detail}"
        )

    unique = {}
    for match in matches:
        key = (str(match[0].resolve()), match[1], match[2])
        unique[key] = match
    matches = list(unique.values())

    if len(matches) > 1:
        choices = "\n".join(
            f"  - {m[0].name} / sheet '{m[1]}' / header row {m[2]}"
            for m in matches
        )
        raise RuntimeError(
            "More than one valid input table was detected. Keep only one current Zone Distribution "
            "workbook/table in /data so the build never guesses.\n" + choices
        )

    return matches[0]

def build_rows(schema: dict) -> tuple[list[dict], dict]:
    path, sheet_name, header_row, colmap, raw_rows = detect_source(schema)
    numeric_cols = set(schema.get("numericColumns", []))
    date_cols = set(schema.get("dateColumns", []))
    headers = schema["requiredHeaders"]

    records = []
    for raw in raw_rows[header_row:]:
        record = {}
        any_value = False
        for header in headers:
            value = str(raw.get(colmap[header], "") or "").strip()
            if value:
                any_value = True

            if header in numeric_cols:
                if value == "":
                    record[header] = None
                else:
                    try:
                        number = float(value)
                        record[header] = int(number) if number.is_integer() else number
                    except ValueError:
                        record[header] = value
            elif header in date_cols:
                record[header] = excel_serial_to_iso(value)
            else:
                record[header] = value

        if any_value:
            records.append(record)

    # Data-quality metadata.
    key = schema.get("uniqueKey", "CODE")
    codes = [str(r.get(key, "") or "").strip() for r in records]
    nonblank_codes = [c for c in codes if c]
    duplicate_codes = len(nonblank_codes) - len(set(nonblank_codes))
    blank_codes = len(codes) - len(nonblank_codes)

    metadata = {
        "sourceWorkbook": path.name,
        "sourceWorksheet": sheet_name,
        "headerRow": header_row,
        "rowCount": len(records),
        "columnCount": len(headers),
        "duplicateCodes": duplicate_codes,
        "blankCodes": blank_codes,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    return records, metadata

def main() -> int:
    try:
        schema = json.loads((CONFIG_DIR / "schema.json").read_text(encoding="utf-8"))
        dashboard_config = json.loads((CONFIG_DIR / "dashboard.config.json").read_text(encoding="utf-8"))

        try:
            rows, metadata = build_rows(schema)
        except Exception as exc:
            # No workbook in /data (or none matched the schema) is now the
            # expected, normal case: this dashboard reads its rows live from
            # the connected Google Drive folder in the browser instead
            # (web/drive-live-rows.js). Publish an empty-but-valid dataset
            # rather than failing the whole deploy — site/ still rebuilds
            # fresh from the current web/ on every run either way, so nothing
            # goes stale. A workbook can still be dropped in /data later as an
            # optional fallback for visitors without Drive access; it isn't
            # required.
            print(f"No workbook in /data ({exc}) — publishing with 0 rows; live data comes from Google Drive.")
            rows = []
            metadata = {
                "sourceWorkbook": "(none \u2014 Google Drive live)",
                "sourceWorksheet": "",
                "headerRow": 0,
                "rowCount": 0,
                "columnCount": len(schema.get("requiredHeaders", [])),
                "duplicateCodes": 0,
                "blankCodes": 0,
                "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }

        if SITE_DIR.exists():
            shutil.rmtree(SITE_DIR)
        SITE_DIR.mkdir(parents=True, exist_ok=True)
        (SITE_DIR / "data").mkdir(parents=True, exist_ok=True)

        for filename in ("index.html", "app.js", "styles.css", "folder-source.js", "local-source-init.js", "drive-owner-mode.js", "cloud-snapshot.js", "supabase-sync.js", "filter-enhance.js", "drive-live-rows.js"):
            shutil.copy2(WEB_DIR / filename, SITE_DIR / filename)

        payload = {
            "meta": metadata,
            "config": dashboard_config,
            "schema": schema,
            "rows": rows,
        }
        (SITE_DIR / "data" / "dashboard_data.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8"
        )
        (SITE_DIR / ".nojekyll").write_text("", encoding="utf-8")

        print(
            f"Built dashboard from '{metadata['sourceWorkbook']}' / '{metadata['sourceWorksheet']}' "
            f"with {metadata['rowCount']:,} rows and {metadata['columnCount']} columns."
        )
        if metadata["duplicateCodes"] or metadata["blankCodes"]:
            print(
                f"Data quality: {metadata['duplicateCodes']} duplicate code row(s), "
                f"{metadata['blankCodes']} blank code row(s)."
            )
        return 0
    except Exception as exc:
        print("\nBUILD FAILED\n============", file=sys.stderr)
        print(str(exc), file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
