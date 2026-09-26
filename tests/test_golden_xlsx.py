"""The working demo must not move.

tests/golden/sales_demo_model.json is exactly what /api/upload returned for the
demo workbook before chart support was added. Every cell, every signal, the
attention order and the spoken overview are compared, so any change to how an
ordinary workbook is read, flagged or described fails here first.

Fields added later for charts are allowed only while they are empty: a workbook
with no chart must come back exactly as it always did.

If the demo is ever changed on purpose, regenerate the golden file deliberately
rather than editing it by hand.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

DEMO = ROOT / "public" / "demo" / "sales_demo.xlsx"
GOLDEN = ROOT / "tests" / "golden" / "sales_demo_model.json"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# Chart fields: allowed in the response, but must be empty for a chartless sheet.
CHART_FIELDS = ("charts", "attention_items")


@pytest.fixture(scope="module")
def body(monkeypatch_module):
    # The upload overview is a template, but keep the check independent of any key.
    monkeypatch_module.delenv("ANTHROPIC_API_KEY", raising=False)
    spec = importlib.util.spec_from_file_location("api.index", ROOT / "api" / "index.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    client = TestClient(module.app)
    response = client.post("/api/upload",
                           files={"file": ("sales_demo.xlsx", DEMO.read_bytes(), XLSX)})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture(scope="module")
def monkeypatch_module():
    with pytest.MonkeyPatch.context() as patch:
        yield patch


@pytest.fixture(scope="module")
def golden():
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


def test_chart_fields_are_empty_for_a_workbook_without_charts(body):
    for field in CHART_FIELDS:
        assert body.get(field, []) == [], f"{field} should be empty for the chartless demo"


def test_demo_upload_matches_the_golden_snapshot(body, golden):
    current = {k: v for k, v in body.items() if k not in CHART_FIELDS}
    assert current.keys() == golden.keys()
    for key in golden:
        if key != "cells":
            assert current[key] == golden[key], f"{key} changed"


def test_every_cell_matches_the_golden_snapshot(body, golden):
    # Cell by cell, so a failure names the cell that moved.
    assert [c["ref"] for c in body["cells"]] == [c["ref"] for c in golden["cells"]]
    for now, then in zip(body["cells"], golden["cells"]):
        assert now == then, f"cell {then['ref']} changed"
