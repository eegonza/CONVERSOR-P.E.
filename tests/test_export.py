import json
from io import BytesIO

import pytest
from openpyxl import load_workbook

from conversor.export import (
    COLUMN_LABELS,
    DEFAULT_COLUMNS,
    ReviewError,
    build_preview,
    write_excel,
)


@pytest.fixture
def document():
    taxable_row = {
        "id": "p1-r1",
        "page": 1,
        "line": 1,
        "code": "000123",
        "description": "Producto gravado",
        "reference": "00009",
        "tax_class": "G",
        "tax_rate": "7.00",
        "units": "10.00",
        "cost": "2.50",
        "sale_price": "4.00",
        "outbound_total": "25.00",
        "inbound_units": None,
        "inbound_total": None,
    }
    exempt_row = {
        **taxable_row,
        "id": "p1-r2",
        "line": 2,
        "code": "008888",
        "tax_class": "E",
        "tax_rate": "0.00",
        "units": "1.00",
        "cost": "5.00",
        "outbound_total": "5.00",
    }
    zero_row = {
        **taxable_row,
        "id": "p2-r1",
        "page": 2,
        "units": "3.00",
        "cost": "0.00",
        "outbound_total": "0.00",
    }
    return {
        "number": "000105",
        "pages": [1, 2],
        "header": {},
        "rows": [taxable_row, exempt_row, zero_row],
        "printed_totals": {
            "outbound": {"subtotal": "30.00", "tax": "1.75", "net": "31.75"},
            "inbound": {"subtotal": "0.00", "tax": "0.00", "net": "0.00"},
        },
        "issues": [],
    }


def test_excel_matches_preview_and_preserves_literal_text_and_zero(document):
    columns = ["reference", "description", "code", "cost", "outbound_total", "page", "line"]
    formula_like_text = '=HYPERLINK("https://example.invalid")'
    preview = build_preview(
        document,
        edits={"p1-r1": {"description": formula_like_text}, "p2-r1": {"outbound_total": None}},
        exclude_ids=["p1-r2"],
        columns=columns,
    )
    assert preview["columns"] == columns
    assert [row["id"] for row in preview["rows"]] == ["p1-r1", "p2-r1"]
    assert preview["rows"][1]["cost"] == "0.00"
    assert preview["rows"][1]["outbound_total"] is None
    assert any(issue["code"] == "repeated_code" for issue in preview["issues"])

    sheet = load_workbook(BytesIO(write_excel(preview))).active
    assert list(sheet.values) == [
        tuple(COLUMN_LABELS[column] for column in columns),
        ("00009", formula_like_text, "000123", 2.5, 25, 1, 1),
        ("00009", "Producto gravado", "000123", 0, None, 2, 1),
    ]
    table = sheet.tables["DatosSalida"]
    assert table.autoFilter.ref == "A1:G3"
    assert table.tableStyleInfo.showColumnStripes is True
    assert table.tableStyleInfo.showRowStripes is False
    for data_row in sheet.iter_rows(min_row=2):
        for cell in data_row:
            expected_color = "FFE8E8E8" if cell.column % 2 == 0 else "FFFFFFFF"
            assert cell.fill.patternType == "solid" and cell.fill.fgColor.rgb == expected_color
    assert [sheet[coord].data_type for coord in ("A2", "B2", "C2", "D3")] == ["s", "s", "s", "n"]
    assert sheet["D3"].number_format.startswith("#,##0.00")


def test_selection_does_not_inherit_document_tax_even_when_amount_matches(document):
    full = build_preview(document, edits={}, exclude_ids=[], columns=DEFAULT_COLUMNS)
    selected = build_preview(document, edits={}, exclude_ids=["p2-r1"], columns=DEFAULT_COLUMNS)

    assert full["summary"]["subtotal"] == selected["summary"]["subtotal"] == "30.00"
    assert full["summary"]["taxable_subtotal"] == "25.00"
    assert full["summary"]["exempt_subtotal"] == "5.00"
    assert full["summary"]["tax"] == "1.75"
    assert full["summary"]["net"] == "31.75"
    assert full["summary"]["tax_origin"] == "printed"
    assert selected["summary"]["tax"] is None and selected["summary"]["net"] is None
    assert selected["printed_totals"]["outbound"]["net"] == "31.75"


def test_review_is_deterministic_and_does_not_modify_original(document):
    first = build_preview(
        document,
        edits={"p1-r1": {"cost": "0.00", "units": "1.234,50"}},
        exclude_ids=["p1-r2", "p2-r1"],
        columns=DEFAULT_COLUMNS,
    )
    second = build_preview(
        document,
        edits={"p1-r1": {"units": "1,234.50", "cost": "0.00"}},
        exclude_ids=["p2-r1", "p1-r2"],
        columns=DEFAULT_COLUMNS,
    )

    assert json.dumps(first, ensure_ascii=False) == json.dumps(second, ensure_ascii=False)
    assert first["summary"]["units"] == "1234.50"
    assert first["changes"] == [
        {"row_id": "p1-r1", "field": "cost", "original": "2.50", "value": "0.00"},
        {"row_id": "p1-r1", "field": "units", "original": "10.00", "value": "1234.50"},
    ]
    assert document["rows"][0]["units"] == "10.00"
    assert document["rows"][0]["cost"] == "2.50"


@pytest.mark.parametrize(
    "overrides",
    [
        {"columns": ["code", "code"]},
        {"columns": ["unknown"]},
        {"exclude_ids": ["p1-r1", "p1-r1"]},
        {"exclude_ids": ["p9-r9"]},
        {"edits": {"p9-r9": {"cost": "1.00"}}},
        {"edits": {"p1-r1": {"line": "2"}}},
        {"edits": {"p1-r1": {"cost": "1,234"}}},
    ],
)
def test_review_rejects_unknown_ids_duplicate_selection_and_invalid_edits(document, overrides):
    arguments = {"edits": {}, "exclude_ids": [], "columns": DEFAULT_COLUMNS} | overrides
    with pytest.raises(ReviewError):
        build_preview(document, **arguments)


def test_unrepresentable_text_cannot_be_silently_truncated_in_workbook(document):
    document["rows"][0]["description"] = "a" * 32768
    preview = build_preview(document, edits={}, exclude_ids=[], columns=DEFAULT_COLUMNS)

    assert any(issue["code"] == "unexportable_cell" and issue["severity"] == "error" for issue in preview["issues"])
    with pytest.raises(ReviewError):
        write_excel(preview)
