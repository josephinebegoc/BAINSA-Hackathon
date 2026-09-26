"""The four chart rules: highest, lowest, largest increase, largest decrease."""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

from _lib import chart_attention  # noqa: E402
from _lib.extract import extract  # noqa: E402
from _lib.models import Chart, ChartPoint, ChartSeries  # noqa: E402

CHART_DEMO = ROOT / "public" / "demo" / "sales_chart_demo.xlsx"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def series(values, name="Italy", categories=MONTHS):
    points = [ChartPoint(category=categories[i], value=v,
                         display="" if v is None else f"€{v:,.0f}", ref=f"X{i}")
              for i, v in enumerate(values)]
    return ChartSeries(name=name, points=points)


def events(values, step_word="month", **kwargs):
    return {e.kind: e for e in chart_attention.series_events(
        series(values, **kwargs), "chart1/s1", step_word)}


# --- the chart demo ------------------------------------------------------------

@pytest.fixture(scope="module")
def demo_events():
    model, step_word = extract(CHART_DEMO)
    return chart_attention.chart_events(model.charts[0], step_word)


def test_the_demo_has_the_four_events_in_reading_order(demo_events):
    assert [(e.kind, e.category) for e in demo_events] == [
        ("largest_increase", "Mar"),
        ("highest", "Jul"),
        ("lowest", "Aug"),
        ("largest_decrease", "Aug"),
    ]


def test_the_demo_fall_carries_every_number_its_sentence_uses(demo_events):
    fall = next(e for e in demo_events if e.kind == "largest_decrease")
    assert (fall.from_category, fall.from_value, fall.from_display) == ("Jul", 154000, "€154,000")
    assert (fall.category, fall.value, fall.display, fall.ref) == ("Aug", 62000, "€62,000", "I2")
    assert fall.change == -92000
    assert fall.pct_change == pytest.approx(-92000 / 154000)
    assert fall.explanation == ("Italy fell from €154,000 in July to €62,000 in August, "
                                "a 60% fall. It is the largest fall between consecutive "
                                "months on this chart.")


def test_the_demo_rise_mentions_the_equally_large_one(demo_events):
    rise = next(e for e in demo_events if e.kind == "largest_increase")
    assert (rise.from_category, rise.category, rise.change) == ("Feb", "Mar", 11000)
    assert rise.tied_with == ["Apr"]
    assert rise.explanation.endswith("The rise from March to April is the same size.")


def test_the_demo_extremes_name_the_value_and_month(demo_events):
    by_kind = {e.kind: e for e in demo_events}
    assert by_kind["highest"].explanation == "Italy's highest value on this chart is €154,000, in July."
    assert by_kind["lowest"].explanation == "Italy's lowest value on this chart is €62,000, in August."


def test_every_event_is_a_low_severity_pattern_cue(demo_events):
    for event in demo_events:
        assert event.signal.type == "trend"
        assert event.signal.severity == "low"
        assert event.id.startswith("chart1/s1/")


def test_event_ids_are_unique(demo_events):
    assert len({e.id for e in demo_events}) == len(demo_events)


# --- the rules --------------------------------------------------------------------

def test_highest_and_lowest():
    found = events([5, 9, 2, 7])
    assert (found["highest"].category, found["highest"].value) == ("Feb", 9)
    assert (found["lowest"].category, found["lowest"].value) == ("Mar", 2)


def test_ties_go_to_the_first_point_and_name_the_others():
    found = events([9, 3, 9, 3, 9])
    assert found["highest"].category == "Jan"
    assert found["highest"].tied_with == ["Mar", "May"]
    assert found["highest"].explanation.endswith("It is the same in March and May.")


def test_largest_increase_and_decrease_use_the_biggest_move():
    found = events([100, 110, 150, 140, 90])
    rise, fall = found["largest_increase"], found["largest_decrease"]
    assert (rise.from_category, rise.category, rise.change) == ("Feb", "Mar", 40)
    assert rise.pct_change == pytest.approx(40 / 110)
    assert (fall.from_category, fall.category, fall.change) == ("Apr", "May", -50)


def test_the_steepest_segment_wins_even_with_a_smaller_percentage():
    # 200 -> 260 is +60 but only +30%; 10 -> 20 is +100% but only +10.
    # The gap keeps the two segments apart.
    found = events([200, 260, None, 10, 20])
    assert found["largest_increase"].category == "Feb"


def test_a_line_that_only_rises_has_no_largest_decrease():
    found = events([1, 2, 3, 4])
    assert "largest_decrease" not in found
    assert "largest_increase" in found


def test_a_flat_line_has_no_events():
    assert events([5, 5, 5, 5]) == {}


def test_too_few_points_have_no_events():
    assert events([1, 9]) == {}
    assert events([1, None, None, 9]) == {}


def test_no_move_is_measured_across_a_gap():
    # 100 -> (blank) -> 10 is not a segment on the chart, so it is not a fall.
    found = events([100, 110, None, 10, 12])
    assert "largest_decrease" not in found
    assert found["lowest"].category == "Apr"


def test_a_move_from_zero_has_no_percentage():
    found = events([0, 50, 60], name="Units")
    rise = found["largest_increase"]
    assert rise.pct_change is None
    assert rise.explanation.startswith("Units rose from €0 in January to €50 in February.")


def test_a_tiny_move_says_less_than_one_percent():
    found = events([10000, 10001, 10000.5], step_word=None)
    assert "a rise of less than 1%" in found["largest_increase"].explanation
    assert found["largest_increase"].explanation.endswith("between neighbouring points on this chart.")


def test_the_sentences_state_facts_not_verdicts(demo_events):
    from _lib.explain import JUDGEMENT_WORDS
    for event in demo_events:
        words = {w.strip(".,").lower() for w in event.explanation.split()}
        assert not words & JUDGEMENT_WORDS, event.explanation


def test_a_series_without_a_name_uses_the_chart_title():
    chart = Chart(id="chart1", kind="line", title="Revenue",
                  series=[series([1, 5, 2], name=None)])
    rise = next(e for e in chart_attention.chart_events(chart) if e.kind == "largest_increase")
    assert rise.explanation.startswith("Revenue rose")
    assert rise.series is None


def test_a_broken_chart_gets_no_events_instead_of_an_error(monkeypatch):
    chart = Chart(id="chart1", kind="line", series=[series([1, 5, 2])])

    def explode(*args, **kwargs):
        raise RuntimeError("bad chart")

    monkeypatch.setattr(chart_attention, "chart_events", explode)
    chart_attention.apply_chart_events([chart])
    assert chart.events == []
