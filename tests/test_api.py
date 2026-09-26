"""The upload endpoint.

The demo dies if this ever returns a stack trace, so most of these tests are about
failing politely: every error must be a sentence the browser can read aloud.
"""

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

DEMO = ROOT / "public" / "demo" / "sales_demo.xlsx"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@pytest.fixture(scope="module")
def client():
    spec = importlib.util.spec_from_file_location("api.index", ROOT / "api" / "index.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return TestClient(module.app)


def upload(client, name="sales_demo.xlsx", data=None):
    payload = data if data is not None else DEMO.read_bytes()
    return client.post("/api/upload", files={"file": (name, payload, XLSX)})


def test_health_reports_whether_a_key_is_configured(client):
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert isinstance(body["llm"], bool)


def test_upload_returns_a_usable_sheet_model(client):
    body = upload(client).json()
    assert body["title"] == "European Sales 2026"
    assert body["n_rows"] == 9 and body["n_cols"] == 14
    assert len(body["cells"]) == body["n_rows"] * body["n_cols"]
    assert len(body["row_labels"]) == 8


def test_upload_finds_the_planted_cues(client):
    """The author's own Team Guide says F5, I2 and N6 (D4 is the statistical cue)."""
    body = upload(client).json()
    assert set(body["attention_order"]) == {"F5", "I2", "N6"}
    kinds = {c["ref"]: {s["type"] for s in c["signals"]}
             for c in body["cells"] if c["signals"]}
    assert kinds["F5"] == {"visual"}
    assert kinds["I2"] == {"trend"}
    assert kinds["N6"] == {"error"}


def test_upload_speaks_an_overview_without_an_llm(client):
    body = upload(client).json()
    assert body["overview"].startswith("European Sales 2026.")
    assert "3 cells flagged" in body["overview"]


def test_upload_reads_the_value_label_from_the_sheet(client):
    assert upload(client).json()["value_label"] == "sales"


def test_the_payload_stays_small_enough_to_be_quick(client):
    assert len(upload(client).content) < 500_000


# --- failing politely --------------------------------------------------------

@pytest.mark.parametrize("name,data,words", [
    ("notes.txt", b"hello", "not an Excel workbook"),
    ("empty.xlsx", b"", "empty"),
    ("broken.xlsx", b"this is not a zip file", "could not open"),
])
def test_bad_uploads_answer_in_a_speakable_sentence(client, name, data, words):
    response = upload(client, name, data)
    body = response.json()
    assert response.status_code >= 400
    assert words in body["error"]
    assert body["error"].endswith(".")          # a sentence, not a code


def test_an_oversized_file_says_so_in_megabytes(client):
    response = upload(client, "big.xlsx", b"x" * 4_500_000)
    assert response.status_code == 413
    assert "too large" in response.json()["error"]


def test_a_get_by_hand_explains_itself(client):
    assert client.get("/api/upload").status_code == 405
