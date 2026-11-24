import re
from collections import defaultdict
from decimal import Decimal, localcontext
from io import BytesIO

from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Alignment
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

COLUMN_LABELS = {
    "code": "Código",
    "description": "Descripción",
    "package": "Empaque",
    "style": "Estilo",
    "descriptor": "Descriptor",
    "reference": "Ref.",
    "tax_class": "Clase I.V.",
    "tax_rate": "I.V. (%)",
    "units": "Salidas · Unidades",
    "cost": "Costo unitario",
    "sale_price": "P/Venta",
    "outbound_total": "Salidas · Total",
    "inbound_units": "Entradas · Unidades",
    "inbound_total": "Entradas · Total",
    "page": "Página de origen",
    "line": "Renglón de origen",
}

DEFAULT_COLUMNS = [
    "code",
    "description",
    "reference",
    "tax_class",
    "tax_rate",
    "units",
    "cost",
    "sale_price",
    "outbound_total",
    "page",
    "line",
]

_ORIGIN_FIELDS = {"page", "line"}
_EDITABLE_FIELDS = COLUMN_LABELS.keys() - _ORIGIN_FIELDS
_DECIMAL_FIELDS = {
    "tax_rate", "units", "cost", "sale_price", "outbound_total", "inbound_units", "inbound_total"
}
_FINANCIAL_FIELDS = (_DECIMAL_FIELDS - {"sale_price"}) | {"tax_class"}
_PLAIN_DECIMAL = re.compile(r"[+-]?(?:[0-9]+(?:[.,][0-9]+)?|[.,][0-9]+)\Z")
_DOT_DECIMAL = re.compile(r"[+-]?[0-9]{1,3}(?:,[0-9]{3})+\.[0-9]+\Z")
_COMMA_DECIMAL = re.compile(r"[+-]?[0-9]{1,3}(?:\.[0-9]{3})+,[0-9]+\Z")
_AMBIGUOUS_COMMA = re.compile(r"[+-]?[1-9][0-9]{0,2},[0-9]{3}\Z")
_DECIMAL_FORMAT = "#,##0.00######"
_TOTAL_FIELDS = ("subtotal", "tax", "net")


class ReviewError(ValueError):
    """A review request contains values that cannot be represented in the export."""


def _decimal_value(value: str, label: str) -> str:
    if _AMBIGUOUS_COMMA.fullmatch(value):
        raise ReviewError(f"{label} tiene una coma ambigua. Usa un punto decimal y escribe los miles sin separador.")
    if len(value) <= 32 and _PLAIN_DECIMAL.fullmatch(value):
        normalized = value.replace(",", ".")
    elif len(value) <= 32 and _DOT_DECIMAL.fullmatch(value):
        normalized = value.replace(",", "")
    elif len(value) <= 32 and _COMMA_DECIMAL.fullmatch(value):
        normalized = value.replace(".", "").replace(",", ".")
    else:
        raise ReviewError(f"{label} requiere un decimal válido.")

    amount = Decimal(normalized)
    digits = "".join(map(str, amount.as_tuple().digits)).rstrip("0")
    if len(digits) > 15 or amount.as_tuple().exponent < -8:
        raise ReviewError(f"{label} admite hasta 15 dígitos significativos y hasta 8 decimales.")
    return format(amount if amount else abs(amount), "f")


def _validate_text(value: str, label: str) -> None:
    if len(value) > 32767 or ILLEGAL_CHARACTERS_RE.search(value) or "\ufffe" in value or "\uffff" in value:
        raise ReviewError(f"{label} contiene texto que Excel no puede conservar.")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ReviewError(f"{label} contiene texto que Excel no puede conservar.") from error


def _normalize_field(field: str, value: str | None) -> str | None:
    if value is None:
        return None

    label = COLUMN_LABELS[field]
    if not isinstance(value, str):
        raise ReviewError(f"{label} requiere texto o un campo vacío.")
    if not value.strip():
        return None
    if field in _DECIMAL_FIELDS:
        normalized = _decimal_value(value.strip(), label)
        if field == "tax_rate" and not Decimal(0) <= Decimal(normalized) <= Decimal(100):
            raise ReviewError("La tasa I.V. debe estar entre 0 y 100.")
        return normalized
    _validate_text(value, label)
    if field == "tax_class":
        normalized = {"G": "G", "GRAVADO": "G", "E": "E", "EXENTO": "E"}.get(value.strip().upper())
        if normalized is None:
            raise ReviewError("La clase I.V. debe ser G (gravado), E (exento) o quedar vacía.")
        return normalized
    return value


def _apply_edits(row: dict, edits: dict) -> tuple[dict, list[dict]]:
    if not isinstance(edits, dict) or any(not isinstance(field, str) for field in edits):
        raise ReviewError(f"Las correcciones de {row['id']} deben indicar campo y valor.")
    updated = dict(row)
    changes = []
    for field in sorted(edits):
        if field not in _EDITABLE_FIELDS:
            raise ReviewError(f"El campo «{field}» no admite correcciones.")
        try:
            revised = _normalize_field(field, edits[field])
        except ReviewError as error:
            raise ReviewError(f"Página {row['page']}, renglón {row['line']}. {error}") from error
        original = row.get(field)
        if revised != original:
            updated[field] = revised
            changes.append({"row_id": row["id"], "field": field, "original": original, "value": revised})
    return updated, changes


def _issue(code: str, severity: str, message: str, row: dict | None = None) -> dict:
    issue = {"code": code, "severity": severity, "message": message}
    if row is not None:
        issue.update(page=row["page"], row=row["line"])
    return issue


def _decimal(row: dict, field: str) -> Decimal | None:
    value = row.get(field)
    return Decimal(value) if value is not None else None


def _outbound(row: dict) -> bool:
    return (
        row.get("units") is not None
        or row.get("outbound_total") is not None
        or not _inbound(row)
    )


def _inbound(row: dict) -> bool:
    return row.get("inbound_units") is not None or row.get("inbound_total") is not None


def _check_rows(rows: list[dict], columns: list[str]) -> list[dict]:
    issues = []
    by_code = defaultdict(list)
    for row in rows:
        code = row.get("code")
        if code:
            by_code[code].append(row)
        else:
            issues.append(_issue("missing_code", "error", "Falta el código del producto.", row))
        if not row.get("description"):
            issues.append(_issue("missing_description", "warning", "Falta la descripción del producto.", row))

        for field in columns:
            value = row.get(field)
            if value is None or field in _ORIGIN_FIELDS:
                continue
            try:
                label = COLUMN_LABELS[field]
                if field in _DECIMAL_FIELDS:
                    _decimal_value(value, label)
                else:
                    _validate_text(value, label)
            except ReviewError as error:
                issues.append(_issue("unexportable_cell", "error", str(error), row))

        outbound, inbound = _outbound(row), _inbound(row)
        fields = ["cost", "sale_price"]
        if outbound:
            fields.extend(("units", "outbound_total"))
        if inbound:
            fields.extend(("inbound_units", "inbound_total"))
        missing = [COLUMN_LABELS[field] for field in fields if row.get(field) is None]
        if missing:
            issues.append(_issue("missing_values", "warning", "Campos vacíos: " + ", ".join(missing) + ".", row))

        tax_class = row.get("tax_class")
        tax_rate = _decimal(row, "tax_rate")
        if outbound and tax_class not in {"G", "E"}:
            issues.append(_issue("unknown_tax_class", "warning", "No se pudo clasificar el I.V. de la salida.", row))
        elif outbound and tax_class == "G" and tax_rate is None:
            issues.append(_issue("missing_tax_rate", "warning", "El renglón gravado no indica una tasa I.V.", row))
        elif tax_class == "E" and tax_rate not in {None, Decimal(0)}:
            issues.append(_issue("exempt_tax_rate", "warning", "El renglón exento indica una tasa distinta de cero.", row))

        price = _decimal(row, "cost")
        for label, units_field, total_field in (
            ("Salidas", "units", "outbound_total"),
            ("Entradas", "inbound_units", "inbound_total"),
        ):
            units, total = _decimal(row, units_field), _decimal(row, total_field)
            if price is None or units is None or total is None:
                continue
            expected = price * units
            if expected != total:
                issues.append(_issue(
                    "line_total_difference", "warning",
                    f"{label}. {units:f} × {price:f} = {expected:f}. El total del renglón es {total:f} "
                    f"(diferencia {total - expected:+f}).",
                    row,
                ))

    for code, occurrences in by_code.items():
        if len(occurrences) > 1:
            locations = ", ".join(f"pág. {row['page']}, renglón {row['line']}" for row in occurrences)
            issues.append(_issue(
                "repeated_code", "warning",
                f"El código {code} figura en {len(occurrences)} renglones ({locations}). "
                "Se conservaron todas las apariciones seleccionadas.",
                occurrences[0],
            ))
    return issues


def _check_footers(source_rows: list[dict], printed: dict) -> list[dict]:
    issues = []
    for side, label, field, movement in (
        ("outbound", "Salidas", "outbound_total", _outbound),
        ("inbound", "Entradas", "inbound_total", _inbound),
    ):
        totals = printed[side]
        subtotal, tax, net = (_decimal(totals, field) for field in _TOTAL_FIELDS)
        values = [_decimal(row, field) for row in source_rows if movement(row)]
        if (side == "outbound" or values or any(value is not None for value in (subtotal, tax, net))) and (
            subtotal is None or tax is None or net is None
        ):
            issues.append(_issue("missing_printed_totals", "warning", f"{label}. El pie del PDF tiene importes vacíos."))
        known_total = sum((value for value in values if value is not None), Decimal(0))
        if subtotal is not None and known_total != subtotal:
            missing_count = values.count(None)
            issues.append(_issue(
                "printed_subtotal_difference", "warning",
                f"{label}. Los totales visibles suman {known_total:f} y el subtotal impreso es {subtotal:f} "
                f"(diferencia {subtotal - known_total:+f}). Renglones del movimiento sin total: {missing_count}.",
            ))
        if subtotal is not None and tax is not None and net is not None and subtotal + tax != net:
            issues.append(_issue(
                "printed_net_difference", "warning",
                f"{label}. El subtotal y el impuesto impresos suman {subtotal + tax:f} y el neto impreso es "
                f"{net:f} (diferencia {net - subtotal - tax:+f}).",
            ))
    return issues


def _as_text(value: Decimal | None) -> str | None:
    return format(value, "f") if value is not None else None


def _summarize(
    document: dict, selected: list[dict], changes: list[dict], outbound_footer: dict, issues: list[dict]
) -> dict:
    source_row_count = len(document["rows"])
    lines = [row for row in selected if _outbound(row)]
    unit_values = [_decimal(row, "units") for row in lines]
    units = sum(unit_values, Decimal("0.00")) if None not in unit_values else None
    amounts = {"G": [], "E": []}
    line_totals = []
    unknown_class = False
    for row in lines:
        tax_class = row.get("tax_class")
        value = _decimal(row, "outbound_total")
        line_totals.append(value)
        if tax_class in amounts:
            amounts[tax_class].append(value)
        else:
            unknown_class = True

    known_subtotals = {
        tax_class: sum((value for value in values if value is not None), Decimal("0.00"))
        for tax_class, values in amounts.items()
    }
    taxable = known_subtotals["G"] if not unknown_class and None not in amounts["G"] else None
    exempt = known_subtotals["E"] if not unknown_class and None not in amounts["E"] else None
    selected_subtotal = sum(line_totals, Decimal("0.00")) if None not in line_totals else None

    subtotal, printed_tax, printed_net = (_decimal(outbound_footer, field) for field in _TOTAL_FIELDS)
    can_use_printed_tax = (
        bool(selected)
        and len(selected) == source_row_count
        and all(change["field"] not in _FINANCIAL_FIELDS for change in changes)
        and taxable is not None
        and exempt is not None
        and units is not None
        and taxable + exempt == subtotal
    )
    tax = printed_tax if can_use_printed_tax else None
    net = printed_net if tax is not None and subtotal + tax == printed_net else None
    if selected and (tax is None or net is None):
        issues.append(_issue(
            "selection_tax_unverified", "info",
            "El impuesto o el neto de la selección quedan sin determinar cuando el pie original no se puede "
            "conciliar con la selección íntegra. El pie original se muestra por separado.",
        ))
    if selected and (taxable is None or exempt is None):
        issues.append(_issue(
            "selection_subtotal_incomplete", "info",
            "Los subtotales por clase requieren importes y clases I.V. completos. Las sumas parciales usan "
            "solo los totales explícitos de cada clase.",
        ))

    return {
        "page_count": len(document["pages"]),
        "detected_rows": source_row_count,
        "export_rows": len(selected),
        "excluded_rows": source_row_count - len(selected),
        "distinct_products": len({row["code"] for row in selected if row.get("code")}),
        "units": _as_text(units) if selected else None,
        "subtotal": _as_text(selected_subtotal) if selected else None,
        "taxable_subtotal": _as_text(taxable) if selected else None,
        "exempt_subtotal": _as_text(exempt) if selected else None,
        "known_taxable_subtotal": _as_text(known_subtotals["G"]) if selected else None,
        "known_exempt_subtotal": _as_text(known_subtotals["E"]) if selected else None,
        "tax": _as_text(tax),
        "net": _as_text(net),
        "tax_origin": "printed" if tax is not None else None,
        "net_origin": "printed" if net is not None else None,
    }


def build_preview(document: dict, *, edits: dict, exclude_ids: list[str], columns: list[str]) -> dict:
    """Build the canonical review from immutable extracted rows and a selection."""
    if not isinstance(columns, list) or not columns:
        raise ReviewError("Selecciona al menos una columna.")
    if any(not isinstance(field, str) or field not in COLUMN_LABELS for field in columns):
        raise ReviewError("La selección contiene una columna desconocida.")
    if len(set(columns)) != len(columns):
        raise ReviewError("La selección contiene columnas repetidas.")

    if not isinstance(exclude_ids, list) or any(not isinstance(row_id, str) for row_id in exclude_ids):
        raise ReviewError("Las exclusiones deben contener identificadores de renglón.")
    excluded = set(exclude_ids)
    if len(excluded) != len(exclude_ids):
        raise ReviewError("Las exclusiones contienen renglones repetidos.")
    if not isinstance(edits, dict) or any(not isinstance(row_id, str) for row_id in edits):
        raise ReviewError("Las correcciones deben contener identificadores de renglón.")
    source_rows = document["rows"]
    source_ids = {row["id"] for row in source_rows}
    if len(source_ids) != len(source_rows):
        raise ReviewError("El documento contiene identificadores de renglón repetidos.")
    if not (excluded | edits.keys()) <= source_ids:
        raise ReviewError("La revisión contiene renglones ajenos al documento.")

    changes = []
    selected = []
    for row in source_rows:
        updated, row_changes = _apply_edits(row, edits.get(row["id"], {}))
        changes.extend(row_changes)
        if row["id"] not in excluded:
            selected.append(updated)
    printed = {
        side: {field: document.get("printed_totals", {}).get(side, {}).get(field) for field in _TOTAL_FIELDS}
        for side in ("outbound", "inbound")
    }
    issues = list(document.get("issues", []))
    if not selected:
        issues.append(_issue("no_export_rows", "error", "Selecciona al menos un renglón para exportar."))
    with localcontext() as context:
        context.prec = 40
        issues.extend(_check_rows(selected, columns))
        issues.extend(_check_footers(source_rows, printed))
        summary = _summarize(document, selected, changes, printed["outbound"], issues)

    return {
        "number": document["number"],
        "columns": list(columns),
        "rows": [{"id": row["id"], **{field: row.get(field) for field in columns}} for row in selected],
        "summary": summary,
        "issues": issues,
        "changes": changes,
        "printed_totals": printed,
        "excluded_ids": [row["id"] for row in source_rows if row["id"] in excluded],
    }


def write_excel(preview: dict) -> bytes:
    """Serialize the approved columns and rows to an Excel worksheet and native table."""
    columns, rows = preview["columns"], preview["rows"]
    if not columns or not rows:
        raise ReviewError("Selecciona columnas y renglones para generar el archivo Excel.")
    if any(issue["severity"] == "error" for issue in preview.get("issues", [])):
        raise ReviewError("Corrige las inconsistencias críticas antes de generar el archivo Excel.")

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Salida"
    sheet.freeze_panes = "A2"
    for column_index, field in enumerate(columns, start=1):
        label = COLUMN_LABELS[field]
        sheet.cell(1, column_index, label)
        width = len(label)
        for row_index, row in enumerate(rows, start=2):
            value = row[field]
            if value is None:
                continue
            cell = sheet.cell(row_index, column_index)
            if field in _DECIMAL_FIELDS:
                cell.value = Decimal(value)
                cell.number_format = _DECIMAL_FORMAT
            elif field in _ORIGIN_FIELDS:
                cell.value = value
            else:
                cell.value = value
                cell.data_type = "s"
                cell.alignment = Alignment(vertical="top", wrap_text=True)
            width = max(width, max(map(len, str(value).splitlines()), default=0))
        sheet.column_dimensions[get_column_letter(column_index)].width = min(64, max(12, width + 4))

    table = Table(displayName="DatosSalida", ref=f"A1:{get_column_letter(len(columns))}{len(rows) + 1}")
    table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
    sheet.add_table(table)

    with BytesIO() as output:
        workbook.save(output)
        return output.getvalue()
