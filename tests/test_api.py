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
    """All four the author's own Team Guide lists: F5, D4, I2 and N6."""
    body = upload(client).json()
    kinds = {c["ref"]: {s["type"] for s in c["signals"]}
             for c in body["cells"] if c["signals"]}
    assert {"F5", "D4", "I2", "N6"} <= set(body["attention_order"])
    assert kinds["F5"] == {"visual"}
    assert kinds["D4"] == {"anomaly"}
    assert kinds["I2"] == {"trend"}
    assert kinds["N6"] == {"error"}


def test_upload_flags_the_oddly_formatted_columns(client):
    """Sep renders as 6,900,000.0% next to €112,000. A sighted reader sees that."""
    body = upload(client).json()
    by_ref = {c["ref"]: c for c in body["cells"]}
    sep = by_ref["J1"]["signals"]
    assert sep and sep[0]["type"] == "visual" and sep[0]["severity"] == "high"
    assert "percentage" in sep[0]["detail"]
    assert "6,900,000.0%" in sep[0]["detail"]


def test_neighbouring_columns_with_the_same_oddity_are_one_cue(client):
    """Oct, Nov and Dec share a problem. Saying it three times buries everything."""
    body = upload(client).json()
    by_ref = {c["ref"]: c for c in body["cells"]}
    assert "Oct to Dec" in by_ref["K1"]["signals"][0]["detail"]
    assert not by_ref["L1"]["signals"] and not by_ref["M1"]["signals"]


def test_upload_speaks_an_overview_without_an_llm(client):
    body = upload(client).json()
    assert body["overview"].startswith("European Sales 2026.")
    assert "6 cells flagged" in body["overview"]


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


# --- explain -----------------------------------------------------------------

def _cell_and_row(client, ref):
    sheet = upload(client).json()
    cell = next(c for c in sheet["cells"] if c["ref"] == ref)
    row = [c["value"] for c in sheet["cells"] if c["row"] == cell["row"] and c["col"] != 1]
    return {"cell": cell, "row_values": row, "signals": cell["signals"]}


@pytest.mark.parametrize("ref,words", [
    ("F5", "highlighted"),
    ("I2", "after 6 months of rises"),
    ("N6", "division by zero"),
])
def test_explain_states_the_fact(client, ref, words):
    body = client.post("/api/explain", json=_cell_and_row(client, ref)).json()
    assert words in body["text"]
    assert body["source"] in ("llm", "template")


def test_explain_row_context_stays_like_for_like(client):
    """The row holds a growth ratio as well as revenue. Saying the row runs from
    -0 to 154,000 would be worse than saying nothing."""
    body = client.post("/api/explain", json=_cell_and_row(client, "I2")).json()
    assert "run from \u20ac69,000 to \u20ac154,000" in body["text"]


def test_explain_never_editorialises(client):
    from _lib.explain import JUDGEMENT_WORDS
    for ref in ("F5", "I2", "N6"):
        text = client.post("/api/explain", json=_cell_and_row(client, ref)).json()["text"]
        assert not set(text.lower().split()) & JUDGEMENT_WORDS


def test_explain_handles_a_cell_with_no_cues(client):
    body = client.post("/api/explain", json=_cell_and_row(client, "B3")).json()
    assert "No cues" in body["text"]


def test_explain_survives_a_nearly_empty_request(client):
    body = client.post("/api/explain", json={"cell": {"ref": "A1", "row": 1, "col": 1}}).json()
    assert body["text"]


def test_the_llm_guard_rejects_opinions_and_invented_numbers():
    from _lib.explain import _acceptable
    facts = "Falls 60% after 6 months of rises 62000"
    assert _acceptable("Italy fell to 62,000 in August after six months of rises.", facts)
    assert not _acceptable("A concerning drop you should investigate.", facts)
    assert not _acceptable("It fell by 88 percent.", facts)
    assert not _acceptable("**Italy** fell in August.", facts)


def test_overview_endpoint_falls_back_to_the_template(client):
    sheet = upload(client).json()
    body = client.post("/api/overview", json={
        "title": sheet["title"], "value_label": sheet["value_label"],
        "n_data_rows": 8, "n_cols": 14,
        "first_col_header": "Country", "last_col_header": "Growth vs Jan",
        "first_value": "€97,000", "first_value_header": "Jan",
        "last_value": "177,000", "last_value_header": "Dec",
        "signal_counts": {"visual": 1, "trend": 1, "error": 1},
    }).json()
    assert body["text"].startswith("European Sales 2026.")


# --- how it sounds -----------------------------------------------------------

def test_month_abbreviations_are_spoken_in_full():
    """"Aug" is a noise in several voices. The grid still shows what the sheet wrote."""
    from _lib.explain import spoken_header
    assert spoken_header("Aug") == "August"
    assert spoken_header("sept.") == "September"
    assert spoken_header("Growth vs Jan") == "Growth vs Jan"   # not a bare month
    assert spoken_header(None) == ""


def test_the_row_label_is_not_said_twice():
    """"Germany, Mar. 148% above Germany's median" names Germany twice."""
    from _lib.explain import template
    from _lib.models import Cell, ExplainRequest, Signal
    request = ExplainRequest(
        cell=Cell(ref="D4", row=4, col=4, value=390000, display="€390,000",
                  row_label="Germany", col_header="Mar"),
        signals=[Signal(type="anomaly", severity="medium",
                        detail="148% above Germany's median")])
    text = template(request)
    assert text.lower().count("germany") == 1
    assert text.startswith("March.")


def test_the_prefix_survives_when_the_cue_does_not_name_the_row():
    from _lib.explain import template
    from _lib.models import Cell, ExplainRequest, Signal
    request = ExplainRequest(
        cell=Cell(ref="I2", row=2, col=9, value=62000, display="€62,000",
                  row_label="Italy", col_header="Aug"),
        signals=[Signal(type="trend", severity="medium",
                        detail="Falls 60% after 6 months of rises")])
    assert template(request).startswith("Italy, August.")
