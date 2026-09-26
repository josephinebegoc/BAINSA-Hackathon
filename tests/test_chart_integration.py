"""Charts in the upload: events, the overview, and one N order across cells and charts."""

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

from _lib import chart_attention, overview  # noqa: E402
from _lib.models import Cell, Chart, ChartPoint, ChartSeries, SheetModel, Signal  # noqa: E402

CHART_DEMO = ROOT / "public" / "demo" / "sales_chart_demo.xlsx"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

DEMO_OVERVIEW = (
    "European Sales 2026. Sales. 8 rows by 14 columns, from Country to Growth vs Jan. "
    "Typical values are €97,000 under Jan and 177,000 under Dec. "
    "6 cells flagged: 3 author visual cues, 1 statistical cue, 1 pattern cue and "
    "1 functional cue. Press N to go to the first."
)  # Charts are described on request (Chart mode, or G), not in the overview.


@pytest.fixture(scope="module")
def api():
    spec = importlib.util.spec_from_file_location("api.index", ROOT / "api" / "index.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def upload(api, path=CHART_DEMO):
    response = TestClient(api.app).post(
        "/api/upload", files={"file": (path.name, path.read_bytes(), XLSX)})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture(scope="module")
def body(api):
    return upload(api)


# --- the chart demo, end to end ------------------------------------------------------

def test_the_upload_carries_the_four_chart_events(body):
    kinds = [e["kind"] for e in body["charts"][0]["events"]]
    assert kinds == ["largest_increase", "highest", "lowest", "largest_decrease"]


def test_the_cell_order_is_unchanged(body):
    assert body["attention_order"] == ["J1", "F5", "N6", "K1", "I2", "D4"]


def test_the_combined_order_is_cells_first_then_chart_points(body):
    stops = [(i["kind"], i["ref"]) for i in body["attention_items"]]
    assert stops == [
        ("cell", "J1"), ("cell", "F5"), ("cell", "N6"), ("cell", "K1"),
        ("cell", "I2"), ("cell", "D4"),
        ("chart", "D2"), ("chart", "H2"),
    ]


def test_one_stop_per_place(body):
    places = [i["ref"] for i in body["attention_items"]]
    assert len(places) == len(set(places))


def test_august_is_one_stop_carrying_the_cell_and_the_chart(body):
    [august] = [i for i in body["attention_items"] if i["ref"] == "I2"]
    assert august["kind"] == "cell"
    assert (august["chart"], august["series"], august["point"]) == ("chart1", 0, 7)
    assert august["events"] == ["chart1/s1/lowest", "chart1/s1/largest_decrease"]
    assert august["labels"] == ["Lowest point: August", "Largest fall: August"]
    assert august["severity"] == "medium"          # the cell's own severity
    assert august["explanation"] == (
        "On the chart, Italy: Monthly Sales 2026, the same point is the lowest point "
        "and largest fall. Italy's lowest value on this chart is €62,000, in August. "
        "Italy fell from €154,000 in July to €62,000 in August, a 60% fall. It is the "
        "largest fall between consecutive months on this chart."
    )


def test_chart_only_stops_carry_their_explanation(body):
    march, july = body["attention_items"][-2:]
    assert (march["events"], march["severity"]) == (["chart1/s1/largest_increase"], "low")
    assert march["explanation"].startswith("Italy rose from €110,000 in February")
    assert july["explanation"] == "Italy's highest value on this chart is €154,000, in July."


def test_the_overview_leaves_the_chart_to_chart_mode(body):
    assert body["overview"] == DEMO_OVERVIEW


def test_a_chart_failure_leaves_the_cells_as_they_were(api, monkeypatch):
    def explode(*args, **kwargs):
        raise RuntimeError("bad chart")

    monkeypatch.setattr(api.chart_attention, "apply_chart_events", explode)
    broken = upload(api)
    assert broken["attention_items"] == []
    assert broken["attention_order"] == ["J1", "F5", "N6", "K1", "I2", "D4"]


# --- the merging rules, on hand-built sheets -------------------------------------------

def sheet(values, cell_signals=None):
    """One row of monthly values with a line chart over it, cues already applied."""
    months = ["Jan", "Feb", "Mar", "Apr", "May"][:len(values)]
    cells = [Cell(ref=f"{chr(66 + i)}2", row=2, col=i + 2, value=v, display=str(v),
                  row_label="Italy", col_header=months[i],
                  signals=(cell_signals or {}).get(f"{chr(66 + i)}2", []))
             for i, v in enumerate(values)]
    chart = Chart(id="chart1", kind="line", title="Italy", series=[ChartSeries(
        name="Italy",
        points=[ChartPoint(category=m, value=v, display=str(v), ref=c.ref)
                for m, v, c in zip(months, values, cells)])])
    chart.events = chart_attention.chart_events(chart, "month")
    order = [c.ref for c in cells if c.signals]
    return SheetModel(id="t", title="T", n_rows=2, n_cols=len(values) + 1,
                      header_row=1, label_col=1, col_headers=["Country"] + months,
                      row_labels=["Italy"], overview="", cells=cells,
                      attention_order=order, charts=[chart])


def test_events_on_the_same_unflagged_point_share_one_chart_stop():
    model = sheet([10, 20, 30, 5])            # Apr is both the lowest and the largest fall
    stops = chart_attention.attention_items(model)
    [april] = [s for s in stops if s.ref == "E2"]
    assert april.kind == "chart"
    assert [e.split("/")[-1] for e in april.events] == ["lowest", "largest_decrease"]
    assert april.explanation.startswith("Italy's lowest value on this chart is 5, in April.")


def test_a_cell_flagged_for_something_else_keeps_its_own_stop():
    red = Signal(type="visual", severity="high", detail="Author highlighted this cell in red")
    model = sheet([10, 20, 30, 5], {"E2": [red]})
    stops = [(s.kind, s.ref) for s in chart_attention.attention_items(model)]
    assert ("cell", "E2") in stops and ("chart", "E2") in stops


def test_a_cell_with_a_pattern_cue_absorbs_the_chart_stop():
    fall = Signal(type="trend", severity="medium", detail="Falls 83% after 2 months of rises")
    model = sheet([10, 20, 30, 5], {"E2": [fall]})
    stops = chart_attention.attention_items(model)
    assert [(s.kind, s.ref) for s in stops if s.ref == "E2"] == [("cell", "E2")]
    assert stops[0].events and "the same point is the lowest point and largest fall" in stops[0].explanation


def test_no_chart_events_means_no_combined_order():
    model = sheet([5, 5, 5, 5])                # a flat line has no events
    assert chart_attention.attention_items(model) == []


def test_charts_stay_out_of_the_overview_but_n_still_reaches_their_points():
    # Charts are described on request (Chart mode, or G), not in the summary.
    model = sheet([10, 20, 30, 5])
    model.attention_items = chart_attention.attention_items(model)
    text = overview.overview_for(model)
    assert "chart" not in text.split("No cells are flagged.")[0].lower()
    assert "On the chart:" not in text
    assert text.endswith("No cells are flagged. Press N to go through the chart's marked points.")


def test_a_sheet_without_a_chart_gets_the_same_overview_as_before():
    model = sheet([10, 20, 30, 5])
    model.charts = []
    assert overview.overview_for(model).endswith("No cells are flagged.")
