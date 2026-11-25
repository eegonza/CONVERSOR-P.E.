"""Read the approved Salidas de Producto forms from their PDF text layer."""

import re
from bisect import bisect_left
from dataclasses import dataclass
from io import BytesIO
from math import isfinite

from pypdf import PdfReader

MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_PAGE_FRAGMENTS = 16_000
_NUMBER = re.compile(r"[0-9]{1,40}\Z")
_ROW_START = re.compile(r"(?:01\s+)?([0-9]{4,40})(?:\s+(.*))?\Z")
_DECIMAL = re.compile(r"[+-]?(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?\Z")
_COMMA_DECIMAL = re.compile(r"[+-]?(?:[0-9]{1,3}(?:\.[0-9]{3})+|[0-9]+),[0-9]+\Z")
_DATE = re.compile(r"[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}\Z")
_FOOTER = re.compile(r"(subtotal:?|impuesto:?|tota(?:l)? neto:?)\s*(.*)\Z", re.I)
_FOOTER_FIELDS = ("subtotal", "tax", "net")
_INBOUND_OUTBOUND = ("outbound", "inbound")
_DECIMAL_FIELDS = ("tax_rate", "cost", "sale_price", "units", "outbound_total", "inbound_units", "inbound_total")
_TEXT_FIELDS = ("description", "package", "style", "descriptor", "reference", "tax_class")
_AMOUNT_LABELS = {"tax_rate": "tasa de I.V.", "cost": "costo", "sale_price": "P/Venta",
                  "units": "unidades de salida", "outbound_total": "total de salida",
                  "inbound_units": "unidades de entrada", "inbound_total": "total de entrada"}


class PdfError(ValueError):
    """The PDF could not be opened or processed within the configured limits."""


@dataclass(frozen=True, slots=True)
class _Fragment:
    x: float
    y: float
    text: str


def _issue(code, message, page=None, *, severity="warning"):
    issue = {"code": code, "message": message, "severity": severity}
    if page is not None:
        issue["page"] = page
    return issue


def _plain_decimal(text):
    if _DECIMAL.fullmatch(text):
        return text.replace(",", "")
    if _COMMA_DECIMAL.fullmatch(text):
        return text.replace(".", "").replace(",", ".")
    return None


def _fragments(page):
    """Put raw text starts on the 612 × 792 reference sheet, top left first."""
    left, bottom, right, top = map(float, page.cropbox)
    width, height = right - left, top - bottom
    if page.rotation or not (width > 0 and height > 0 and abs(width / height - 612 / 792) < 0.01):
        return None

    fragments = []

    def visit(text, user_matrix, text_matrix, _font, _size):
        text = " ".join(text.split())
        if not text:
            return
        a, b, c, d, e, f = user_matrix
        tx, ty = text_matrix[4:6]
        x = (tx * a + ty * c + e - left) * 612 / width
        y = (top - (tx * b + ty * d + f)) * 792 / height
        if not (isfinite(x) and isfinite(y)) or len(fragments) >= MAX_PAGE_FRAGMENTS:
            raise PdfError("El PDF contiene una página con geometría o volumen de texto no admitido.")
        fragments.append(_Fragment(x, y, text))

    page.extract_text(visitor_text=visit)
    return fragments


def _header(fragments):
    top = [f for f in fragments if 25 < f.y < 140]
    heading = [f.text.casefold() for f in top if 131 < f.y < 141]
    table = " ".join(heading)
    if not all(label in table for label in ("costo", "p/venta", "unidades", "i.v.", "ref.")):
        return None, False, None

    title = next((f.text for f in top if f.text.casefold() == "salidas de producto"), None)
    company = next((f.text for f in top if 65 < f.y < 78 and 175 < f.x < 340), None)
    if not title or not company or not any(f.text.casefold().startswith("número:") for f in top):
        return None, False, None

    numbers = list(dict.fromkeys(
        f.text for f in top if 75 < f.x < 240 and 34 < f.y < 47 and _NUMBER.fullmatch(f.text)
    ))
    header = {"date": None, "printed_date": None, "reference": None, "destination": None,
              "note": None, "company": company, "title": title}
    printed_page = None
    for f in top:
        if 44 < f.y < 60 and 76 < f.x < 210 and _DATE.fullmatch(f.text):
            header["date"] = f.text
        elif 44 < f.y < 55 and f.x >= 444:
            value = re.sub(r"^Fecha:\s*", "", f.text, flags=re.I)
            if _DATE.fullmatch(value):
                header["printed_date"] = value
        elif 34 < f.y < 42 and f.x >= 470 and f.text.isascii() and f.text.isdigit() and len(f.text) <= 6:
            printed_page = int(f.text)
        elif 100 < f.y < 108:
            if f.text.casefold().startswith("referencia:"):
                header["reference"] = f.text.split(":", 1)[1].strip() or header["reference"]
            elif f.text.casefold().startswith("destino:"):
                header["destination"] = f.text.split(":", 1)[1].strip() or header["destination"]
            elif 65 < f.x < 355:
                header["reference"] = f.text
            elif f.x > 405:
                header["destination"] = f.text
    return (numbers, header), "estilo" in table, printed_page


def _row_cells(anchor, fragments, has_style, page, line, issues):
    beginning = _ROW_START.fullmatch(anchor.text)
    code, description = beginning.groups() if beginning else (None, anchor.text)
    row = {"id": f"p{page}-r{line}", "page": page, "line": line, "code": code}
    row.update(dict.fromkeys(_TEXT_FIELDS + _DECIMAL_FIELDS))
    row["description"] = description
    if code is None:
        issues.append(_issue("missing_product_code", f"No se pudo identificar el código de producto en la línea {line}.", page))

    def put(field, value):
        if value is None:
            return
        if field in _DECIMAL_FIELDS:
            decimal = _plain_decimal(value)
            if decimal is None:
                issues.append(_issue("invalid_numeric_cell", f"Valor ilegible en la línea {line}, campo {_AMOUNT_LABELS[field]}.", page))
                return
            if row[field] is not None:
                issues.append(_issue("ambiguous_cell", f"Se encontraron dos valores en la línea {line}, campo {_AMOUNT_LABELS[field]}.", page))
                return
            value = decimal
        row[field] = " ".join(filter(None, (row[field], value)))

    for f in sorted(fragments, key=lambda item: (round(item.y), item.x)):
        x = f.x
        if 57 <= x < 179:
            put("description", f.text)
        elif 179 <= x < 230:
            put("package", f.text)
        elif 230 <= x < 261:
            put("style" if has_style else "descriptor", f.text)
        elif 261 <= x < 301:
            put("reference", f.text)
        elif 301 <= x < 314:
            # The sample printer may emit I.V., P/Venta and Salidas Unidades in
            # one text fragment. The rate and cost have their own text starts.
            parts = f.text.split()
            put("tax_class", parts[0])
            if len(parts) == 3:
                put("sale_price", parts[1])
                put("units", parts[2])
            elif len(parts) != 1:
                issues.append(_issue("ambiguous_cell", f"P/Venta o Unidades no distinguibles en la línea {line}.", page))
        elif 314 <= x < 345:
            put("tax_rate", f.text)
        elif 345 <= x < 378:
            put("cost", f.text)
        elif 378 <= x < 430:
            put("sale_price", f.text)
        elif 430 <= x < 474:
            put("units", f.text)
        elif 474 <= x < 515:
            put("outbound_total", f.text)
        elif 515 <= x < 554:
            put("inbound_units", f.text)
        elif 554 <= x <= 610:
            put("inbound_total", f.text)
        else:
            issues.append(_issue("unassigned_row_text", f"Hay texto sin columna identificada cerca de la línea {line}.", page))
    if any(value and "\ufffd" in value for value in (row[key] for key in _TEXT_FIELDS)):
        issues.append(_issue("unreadable_row_text", f"Hay caracteres ilegibles en la línea {line}.", page))
    return row


def _rows(body, has_style, page, issues):
    # The left band is printed once per row. Split fields can share its baseline
    # and descriptions, style and reference can occupy distinct text fragments.
    anchors = sorted((f for f in body if 5 <= f.x <= 55), key=lambda f: f.y)
    y_values = [f.y for f in anchors]
    attached = [[] for _ in anchors]
    orphaned = 0
    for f in body:
        if 5 <= f.x <= 55:
            continue
        index = bisect_left(y_values, f.y)
        choices = range(max(0, index - 1), min(len(anchors), index + 1))
        nearest = min(choices, key=lambda i: abs(y_values[i] - f.y), default=None)
        if nearest is None or abs(y_values[nearest] - f.y) > 5.5:
            orphaned += 1
        else:
            attached[nearest].append(f)
    if orphaned:
        issues.append(_issue("unassigned_body_text", f"Hay {orphaned} fragmentos que no se pudieron asociar a una fila.", page))
    rows = [_row_cells(anchor, cells, has_style, page, line, issues)
            for line, (anchor, cells) in enumerate(zip(anchors, attached), 1)]
    if not rows:
        issues.append(_issue("no_rows", "No se identificaron filas de productos en la página.", page, severity="error"))
    return rows


def _blank_totals():
    return {side: dict.fromkeys(_FOOTER_FIELDS) for side in _INBOUND_OUTBOUND}


def _footer(fragments, page, issues):
    totals = _blank_totals()
    labels = [(f, _FOOTER.fullmatch(f.text)) for f in fragments if 347 < f.x < 373 and f.y > 145]
    labels = [(f, matched) for f, matched in labels if matched]
    if not labels:
        return None, totals, None

    start_y = min(f.y for f, _ in labels)
    for label, match in labels:
        name = match[1].casefold()
        key = "subtotal" if name.startswith("subtotal") else "tax" if name.startswith("impuesto") else "net"
        matches = match[2].split()
        if len(matches) == 2:
            for side, value in zip(_INBOUND_OUTBOUND, matches):
                totals[side][key] = _plain_decimal(value)
        elif matches:
            issues.append(_issue("ambiguous_printed_total", "Hay un importe impreso cuya columna de pie no se pudo verificar.", page))
        for f in fragments:
            if abs(f.y - label.y) <= 2.5 and 415 < f.x < 610:
                side = "inbound" if f.x >= 520 else "outbound"
                if totals[side][key] is None:
                    totals[side][key] = _plain_decimal(f.text)

    notes = [f for f in fragments if 5 < f.x < 345 and start_y - 4 <= f.y <= start_y + 29]
    note = " ".join(f.text for f in sorted(notes, key=lambda item: (round(item.y), item.x))) or None
    return start_y - 4, totals, note


def _add_page(document, header, totals, rows, page, printed_page, issues):
    if printed_page is not None and printed_page != len(document["pages"]) + 1:
        issues.append(_issue("printed_page_sequence", f"La página impresa {printed_page} no coincide con la secuencia detectada de la salida.", page))
    document["pages"].append(page)
    document["rows"].extend(rows)
    for key, value in header.items():
        if value is None:
            continue
        previous = document["header"].get(key)
        if previous is not None and previous != value:
            issues.append(_issue("conflicting_header", f"El campo de encabezado {key} cambia entre páginas de la salida.", page))
        else:
            document["header"][key] = value
    for side, amounts in totals.items():
        for key, value in amounts.items():
            if value is None:
                continue
            previous = document["printed_totals"][side][key]
            if previous is not None:
                issues.append(_issue("repeated_printed_total", "Se encontraron totales impresos en más de una página de la salida.", page))
            else:
                document["printed_totals"][side][key] = value
    document["issues"].extend(issues)


def parse_pdf(data: bytes, *, max_pages: int = 100) -> dict:
    """Extract sections in physical-page order while preserving row identity."""
    if not isinstance(data, bytes) or not data.startswith(b"%PDF-"):
        raise PdfError("El archivo no tiene una cabecera PDF válida.")
    if len(data) > MAX_INPUT_BYTES:
        raise PdfError("El PDF sobrepasa el tamaño máximo de procesamiento.")
    if not isinstance(max_pages, int) or isinstance(max_pages, bool) or max_pages < 1:
        raise PdfError("El límite de páginas no es válido.")
    try:
        reader = PdfReader(BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise PdfError("El PDF está cifrado. Seleccione una copia que se pueda abrir sin contraseña.")
        page_count = len(reader.pages)
    except (PdfError, MemoryError):
        raise
    except Exception as error:
        raise PdfError("No se pudo leer la estructura del PDF.") from error
    if not 0 < page_count <= max_pages:
        raise PdfError(f"El PDF debe contener de 1 a {max_pages} páginas.")

    documents = {}
    issues = []
    for page_number, page in enumerate(reader.pages, 1):
        try:
            fragments = _fragments(page)
        except (PdfError, MemoryError):
            raise
        except Exception:
            issues.append(_issue("unreadable_page", "No se pudo leer el texto de la página.", page_number, severity="error"))
            continue
        if fragments is None:
            issues.append(_issue("unrecognized_page", "El formato o la orientación de la página no coincide con la plantilla aprobada.", page_number, severity="error"))
            continue
        if not fragments:
            issues.append(_issue("no_text_layer", "La página está vacía o es un escaneo sin capa de texto.", page_number, severity="error"))
            continue
        header_result, has_style, printed_page = _header(fragments)
        if not header_result:
            issues.append(_issue("unrecognized_page", "La página no coincide con una plantilla aprobada de Salidas de Producto.", page_number, severity="error"))
            continue
        numbers, header = header_result
        if not numbers:
            issues.append(_issue("missing_output_number", "Falta un número de salida válido en la página.", page_number, severity="error"))
            continue
        if len(numbers) > 1:
            candidates = ", ".join(numbers[:6])
            if len(numbers) > 6:
                candidates += ", …"
            issues.append(_issue("ambiguous_output_number", f"Se encontraron varios candidatos al número de salida ({candidates}).", page_number, severity="error"))
            continue
        number = numbers[0]

        page_issues = []
        end_y, totals, header["note"] = _footer(fragments, page_number, page_issues)
        body = [f for f in fragments if 145 < f.y < (end_y if end_y is not None else 771)]
        rows = _rows(body, has_style, page_number, page_issues)
        document = documents.setdefault(number, {"number": number, "pages": [], "header": {}, "rows": [],
                                                 "printed_totals": _blank_totals(), "issues": []})
        _add_page(document, header, totals, rows, page_number, printed_page, page_issues)

    for document in documents.values():
        for key in ("date", "printed_date", "reference", "destination", "note", "company", "title"):
            document["header"].setdefault(key, None)
        if any(value is None for value in document["printed_totals"]["outbound"].values()):
            document["issues"].append(_issue("missing_printed_totals", "El pie de salidas está ausente o incompleto."))
    return {"page_count": page_count, "documents": list(documents.values()), "issues": issues}
