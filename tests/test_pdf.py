from io import BytesIO

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from conversor import pdf


def _text_page(writer, parts):
    page = writer.add_blank_page(612, 792)
    name = NameObject
    font = DictionaryObject({
        name("/Type"): name("/Font"),
        name("/Subtype"): name("/Type1"),
        name("/BaseFont"): name("/Helvetica"),
        name("/Encoding"): name("/WinAnsiEncoding"),
    })
    page[name("/Resources")] = DictionaryObject({name("/Font"): DictionaryObject({name("/F1"): font})})
    stream = DecodedStreamObject()
    commands = [f"BT /F1 10 Tf 1 0 0 1 {x} {792 - y} Tm <{value.encode('cp1252').hex()}> Tj ET"
                for x, y, value in parts]
    stream.set_data("\n".join(commands).encode("ascii"))
    page.replace_contents(stream)


def _form(writer, number, printed_page=1, *, style=False, footer=True, outgoing=None, incoming=False):
    parts = [
        (27, 40, "Número:"), (114, 42, number), (492, 36, str(printed_page)),
        (84, 54, "2/01/2025"), (454, 49, "Fecha: 3/01/2025"),
        (238, 73, "EMPRESA DE PRUEBA"), (224, 86, "SALIDAS DE PRODUCTO"),
        (25, 104, "Referencia:"), (84, 104, "PRUEBA-01"),
        (373, 104, "Destino:"), (430, 104, "BODEGA"),
        (279, 135, "Ref."), (320, 135, "I.V."), (349, 135, "Costo"),
        (387, 135, "P/Venta"), (432, 135, "Unidades"),
        (11, 150, "01 000012"), (65, 151, "Descripción de prueba"),
        (189, 150, "Caja"), (242, 150, "Muestra"), (268, 150, "0012"),
        (309, 150, "G"), (318, 150, "7.00"), (365, 150, "0.00"),
        (407, 150, "1.2549"), (446, 150, "12.00"),
    ]
    if style:
        parts.append((234, 135, "Estilo"))
    if outgoing is not None:
        parts.append((497, 151, outgoing))
    if incoming:
        parts.extend([(531, 150, "2.00"), (570, 150, "2.5098")])
    if footer:
        parts.extend([
            (26, 180, "OBSERVACIÓN DE PRUEBA"),
            (356, 181, "SubTotal:"), (442, 181, "1,234.56"), (548, 181, "0.00"),
            (356, 194, "Impuesto 0.00 0.00"), (356, 207, "Tota Neto 1,234.56 0.00"),
        ])
    _text_page(writer, parts)


def _bytes(writer):
    stream = BytesIO()
    writer.write(stream)
    return stream.getvalue()


def test_extracts_distinct_sections_and_preserves_printed_values():
    writer = PdfWriter()
    _form(writer, "000001", footer=False)
    _form(writer, "000001", printed_page=2, outgoing="0.00")
    _form(writer, "000002", style=True, incoming=True)
    envelope = pdf.parse_pdf(_bytes(writer))

    assert envelope["page_count"] == 3
    assert envelope["issues"] == []
    first, second = envelope["documents"]
    assert first["number"] == "000001"
    assert first["pages"] == [1, 2]
    assert first["header"] == {
        "date": "2/01/2025", "printed_date": "3/01/2025", "reference": "PRUEBA-01",
        "destination": "BODEGA", "note": "OBSERVACIÓN DE PRUEBA",
        "company": "EMPRESA DE PRUEBA", "title": "SALIDAS DE PRODUCTO",
    }
    assert first["printed_totals"] == {
        "outbound": {"subtotal": "1234.56", "tax": "0.00", "net": "1234.56"},
        "inbound": {"subtotal": "0.00", "tax": "0.00", "net": "0.00"},
    }
    first_row, repeated_row = first["rows"]
    assert first_row == {
        "id": "p1-r1", "page": 1, "line": 1, "code": "000012", "description": "Descripción de prueba",
        "package": "Caja", "style": None, "descriptor": "Muestra", "reference": "0012",
        "tax_class": "G", "tax_rate": "7.00", "cost": "0.00", "sale_price": "1.2549", "units": "12.00",
        "outbound_total": None, "inbound_units": None, "inbound_total": None,
    }
    assert repeated_row == {**first_row, "id": "p2-r1", "page": 2, "outbound_total": "0.00"}
    assert second["number"] == "000002"
    assert second["pages"] == [3]
    assert second["rows"] == [{
        **first_row, "id": "p3-r1", "page": 3, "style": "Muestra", "descriptor": None,
        "inbound_units": "2.00", "inbound_total": "2.5098",
    }]
    assert first["issues"] == second["issues"] == []


def test_reports_image_only_and_unrecognized_pages():
    writer = PdfWriter()
    _form(writer, "000001", footer=False)
    image_page = writer.add_blank_page(612, 792)
    image = DecodedStreamObject()
    image.set_data(b"q 612 0 0 792 0 0 cm\nBI /W 1 /H 1 /BPC 8 /CS /G ID \x80\nEI\nQ\n")
    image_page.replace_contents(image)
    _text_page(writer, [(11, 150, "Texto fuera del formato")])
    envelope = pdf.parse_pdf(_bytes(writer))

    assert envelope["page_count"] == 3
    assert [(issue["code"], issue["page"], issue["severity"]) for issue in envelope["issues"]] == [
        ("no_text_layer", 2, "error"), ("unrecognized_page", 3, "error"),
    ]
    document, = envelope["documents"]
    assert document["pages"] == [1]
    assert len(document["rows"]) == 1
    assert document["printed_totals"]["outbound"] == dict.fromkeys(("subtotal", "tax", "net"))
    assert document["issues"][0]["code"] == "missing_printed_totals"


@pytest.mark.parametrize("data", [b"", b"%PDF-1.7\nContenido incompleto"])
def test_rejects_malformed_pdf(data):
    with pytest.raises(pdf.PdfError):
        pdf.parse_pdf(data)


def test_rejects_encrypted_pdf_and_enforces_processing_limits(monkeypatch):
    writer = PdfWriter()
    writer.add_blank_page(612, 792)
    writer.add_blank_page(612, 792)
    unencrypted = _bytes(writer)
    writer.encrypt("clave de prueba")
    with pytest.raises(pdf.PdfError, match="cifrado"):
        pdf.parse_pdf(_bytes(writer))
    with pytest.raises(pdf.PdfError, match="páginas"):
        pdf.parse_pdf(unencrypted, max_pages=1)
    monkeypatch.setattr(pdf, "MAX_INPUT_BYTES", len(unencrypted) - 1)
    with pytest.raises(pdf.PdfError, match="tamaño máximo"):
        pdf.parse_pdf(unencrypted)
