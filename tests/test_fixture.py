"""The fixture and the engine must agree.

public/fixtures/sample_sheet.json is the contract the frontend builds against. If
the engine ever stops reproducing it, either the engine regressed or the contract
moved -- and both sides of the team need to know.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from _lib import attention  # noqa: E402
from _lib.models import SheetModel  # noqa: E402

FIXTURE = Path(__file__).resolve().parent.parent / "public" / "fixtures" / "sample_sheet.json"


def load():
    return SheetModel.model_validate(json.loads(FIXTURE.read_text()))


def derive(sheet):
    """Strip the stored signals and let the engine work them out again."""
    cells = [c.model_copy(update={"signals": []}) for c in sheet.cells]
    order = attention.apply_signals(
        cells, header_row=sheet.header_row, label_col=sheet.label_col, step_word="month"
    )
    return cells, order


def test_fixture_is_valid_against_the_contract():
    sheet = load()
    assert len(sheet.cells) == sheet.n_rows * sheet.n_cols
    assert len(sheet.col_headers) == sheet.n_cols
    assert len(sheet.row_labels) == sheet.n_rows - 1


def test_engine_reproduces_the_fixtures_signals_exactly():
    sheet = load()
    cells, _ = derive(sheet)
    got = {c.ref: [(s.type, s.severity, s.detail) for s in c.signals] for c in cells if c.signals}
    want = {c.ref: [(s.type, s.severity, s.detail) for s in c.signals]
            for c in sheet.cells if c.signals}
    assert got == want


def test_engine_reproduces_the_attention_order():
    sheet = load()
    _, order = derive(sheet)
    assert order == sheet.attention_order


def test_all_four_signal_types_are_present_and_nothing_else_is_flagged():
    """The four planted moments, and only those four."""
    sheet = load()
    cells, _ = derive(sheet)
    flagged = {c.ref: {s.type for s in c.signals} for c in cells if c.signals}
    assert len(flagged) == 4
    assert {t for types in flagged.values() for t in types} == {
        "visual", "anomaly", "trend", "error"
    }
