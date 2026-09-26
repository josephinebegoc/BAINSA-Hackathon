"""Unit tests for the attention engine.

These build cells by hand rather than reading a spreadsheet: the engine is pure,
and the point is to pin down the rules -- including the cases where a rule must
stay quiet, which is what stops the demo drowning in false positives.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from _lib import attention  # noqa: E402
from _lib.models import Cell  # noqa: E402


def row(values, r=2, label="Italy", unit="€", start_col=2, **kw):
    """One row of numeric cells, formatted with a unit so they group together."""
    cells = []
    for i, v in enumerate(values):
        c = start_col + i
        cells.append(Cell(
            ref=f"{chr(64 + c)}{r}", row=r, col=c, value=v,
            display=f"{unit}{v:,}" if v is not None else "",
            row_label=label, col_header=f"M{i + 1}", **kw,
        ))
    return cells


# --- anomaly -----------------------------------------------------------------

def test_anomaly_flags_a_collapse():
    cells = row([80_000, 82_000, 79_000, 31_000, 83_000, 81_000])
    found = attention.anomaly_signals(cells, "Italy")
    assert list(found) == ["E2"]
    assert found["E2"].type == "anomaly"
    assert "below Italy's median" in found["E2"].detail
    assert "61%" in found["E2"].detail          # median 80,500 -> 31,000 is 61% below


def test_anomaly_stays_quiet_on_tight_noise():
    """The z-score alone would fire here: MAD is tiny, so a 13% gap looks extreme.

    This is the regression test for the Z_MIN_PCT floor.
    """
    cells = row([41_000, 41_200, 41_100, 40_900, 41_050, 46_400])
    assert attention.anomaly_signals(cells, "Belgium") == {}


def test_anomaly_needs_enough_numbers():
    cells = row([80_000, 10, 81_000])
    assert attention.anomaly_signals(cells, "Italy") == {}


def test_anomaly_survives_a_zero_median():
    cells = row([0, 0, 0, 0, 5_000])
    attention.anomaly_signals(cells, "Odd")     # must not divide by zero


def test_anomaly_handles_negatives():
    cells = row([-100, -102, -98, -101, -1_000])
    found = attention.anomaly_signals(cells, "Loss")
    assert "F2" in found and "below" in found["F2"].detail


# --- trend -------------------------------------------------------------------

def test_trend_reports_the_shape_not_a_verdict():
    """Facts only: the size of the move and the run before it, never a judgement."""
    cells = row([100, 110, 120, 135, 145, 80])
    found = attention.trend_signals(cells)
    assert list(found) == ["G2"]
    assert found["G2"].detail == "Falls 45% after 4 rises"


def test_trend_uses_the_callers_word_for_a_step():
    cells = row([100, 110, 120, 135, 145, 80])
    found = attention.trend_signals(cells, step_word="month")
    assert found["G2"].detail == "Falls 45% after 4 months of rises"


def test_trend_ignores_a_short_run():
    cells = row([100, 110, 120, 60])          # only two rises before the drop
    assert attention.trend_signals(cells) == {}


def test_trend_ignores_a_small_dip():
    cells = row([100, 110, 120, 135, 145, 140])
    assert attention.trend_signals(cells) == {}


def test_trend_catches_a_downward_run_reversing_up():
    cells = row([200, 180, 160, 140, 130, 400])
    found = attention.trend_signals(cells)
    assert found and "after 4 falls" in next(iter(found.values())).detail
    with_word = attention.trend_signals(cells, step_word="month")
    assert "after 4 months of falls" in next(iter(with_word.values())).detail


# --- visual ------------------------------------------------------------------

def test_visual_fill_is_named_in_words():
    cells = row([1, 2, 3, 4])
    cells[1].fill = "FFFF0000"
    signal = attention.visual_signal(cells[1], cells)
    assert signal.detail == "Author highlighted this cell in red"
    assert signal.severity == "high"


def test_visual_fill_without_a_resolvable_colour():
    cells = row([1, 2, 3, 4])
    cells[0].fill = "unknown-non-default"
    assert attention.visual_signal(cells[0], cells).detail == "Author highlighted this cell"


def test_visual_red_font():
    cells = row([1, 2, 3, 4])
    cells[2].font_color = "FFFF0000"
    assert attention.visual_signal(cells[2], cells).detail == "Author coloured the text red"


def test_visual_ignores_a_blue_font():
    cells = row([1, 2, 3, 4])
    cells[2].font_color = "FF0070C0"
    assert attention.visual_signal(cells[2], cells) is None


def test_visual_bold_singles_a_cell_out():
    cells = row([1, 2, 3, 4])
    cells[0].bold = True
    assert attention.visual_signal(cells[0], cells).detail == "Author made this cell bold"


def test_visual_ignores_an_entirely_bold_row():
    cells = row([1, 2, 3, 4], bold=True)
    assert all(attention.visual_signal(c, cells) is None for c in cells)


# --- error -------------------------------------------------------------------

@pytest.mark.parametrize("code,words", [
    ("#DIV/0!", "division by zero"),
    ("#N/A", "not available"),
    ("#REF!", "gone"),
])
def test_error_is_spoken_in_plain_words(code, words):
    cell = Cell(ref="N8", row=8, col=14, error=code, display=code)
    signal = attention.error_signal(cell)
    assert signal.severity == "high"
    assert words in signal.detail
    assert code not in signal.detail.replace(f"Formula error: {code}", "")


def test_unknown_error_code_still_produces_a_signal():
    cell = Cell(ref="A1", row=1, col=1, error="#WHAT?")
    assert attention.error_signal(cell) is not None


# --- comparing like with like -----------------------------------------------

def sheet_with_growth_column(growth_display):
    """Four rows of revenue plus a growth column, however it happens to be formatted."""
    cells = []
    for i, r in enumerate(range(2, 6)):
        cells += row([80_000 + i * 900, 82_000, 79_000, 81_000], r=r, label=f"C{r}")
        g = 0.04 + i / 100
        cells.append(Cell(ref=f"F{r}", row=r, col=6, value=g,
                          display=growth_display(g), row_label=f"C{r}",
                          col_header="Growth"))
    return cells


def test_a_percentage_column_is_not_compared_against_revenue():
    """0.04 is not an anomaly next to 80,000, whatever the formatting says."""
    cells = sheet_with_growth_column(lambda g: f"{g * 100:.1f}%")
    groups = attention.comparable_axes(cells, "col")
    assert len(groups) == 1
    assert groups[0] == {2, 3, 4, 5}          # the revenue columns, not column 6


def test_scale_splits_columns_even_when_nothing_is_formatted():
    """The real demo file is formatted General: no % sign to key off, only scale.

    Without this, every growth figure reads as an extreme anomaly against revenue.
    """
    cells = sheet_with_growth_column(lambda g: f"{g}")
    groups = attention.comparable_axes(cells, "col")
    assert len(groups) == 1
    assert 6 not in groups[0]


def test_an_outlier_stays_inside_its_own_column_group():
    """A spike must not be bucketed away on its own, or it can never be detected."""
    cells = []
    for r in range(2, 7):
        cells += row([112_000, 118_000, 390_000 if r == 4 else 120_000, 129_000], r=r,
                     label=f"C{r}")
    groups = attention.comparable_axes(cells, "col")
    assert groups and {2, 3, 4, 5} <= groups[0]


def test_cells_holding_errors_are_left_out_of_series():
    cells = row([80_000, 82_000, 79_000, 81_000])
    cells.append(Cell(ref="F2", row=2, col=6, error="#DIV/0!", display="#DIV/0!"))
    assert all(c.error is None for c in attention.series_groups(cells)[0])


def test_series_groups_respects_the_columns_it_is_given():
    cells = row([80_000, 82_000, 79_000, 81_000, 0.5])
    assert [c.ref for c in attention.series_groups(cells, keep={2, 3, 4, 5})[0]] == \
        ["B2", "C2", "D2", "E2"]


def test_text_and_dates_are_not_treated_as_quantities():
    import datetime
    cells = row([1, 2, 3, 4])
    cells.append(Cell(ref="F2", row=2, col=6, value="n/a", display="n/a"))
    cells.append(Cell(ref="G2", row=2, col=7, value=datetime.date(2026, 1, 1), display="2026-01-01"))
    assert len(attention.series_groups(cells)[0]) == 4


# --- severity and ordering ---------------------------------------------------

def test_anomaly_plus_trend_becomes_high():
    found = {"E2": [
        attention.Signal(type="anomaly", severity="medium", detail="x"),
        attention.Signal(type="trend", severity="medium", detail="y"),
    ]}
    attention._escalate(found)
    assert all(s.severity == "high" for s in found["E2"])


def test_attention_order_is_severity_then_reading_order():
    def flagged(ref, r, c, severity):
        return Cell(ref=ref, row=r, col=c,
                    signals=[attention.Signal(type="anomaly", severity=severity, detail="d")])
    cells = [
        flagged("Z9", 9, 26, "medium"),
        flagged("B2", 2, 2, "medium"),
        flagged("Y8", 8, 25, "high"),
        Cell(ref="A1", row=1, col=1),
    ]
    assert attention.attention_order(cells) == ["Y8", "B2", "Z9"]


# --- whole-sheet behaviour ---------------------------------------------------

def test_find_signals_skips_headers_and_labels():
    header = [Cell(ref=f"{chr(65 + i)}1", row=1, col=i + 1, value=f"H{i}", bold=True)
              for i in range(5)]
    label = Cell(ref="A2", row=2, col=1, value="Italy", display="Italy")
    found = attention.find_signals(header + [label] + row([1, 2, 3, 4]))
    assert not any(ref in found for ref in ["A1", "B1", "A2"])


def test_find_signals_survives_an_empty_sheet():
    assert attention.find_signals([]) == {}


def test_find_signals_survives_a_single_cell():
    assert attention.find_signals([Cell(ref="B2", row=2, col=2, value=1)]) == {}


def test_apply_signals_attaches_and_orders():
    cells = row([80_000, 82_000, 79_000, 31_000, 83_000, 81_000])
    cells[1].fill = "FFFF0000"
    order = attention.apply_signals(cells)
    assert order == ["C2"]                        # the author's highlight
    assert not cells[3].signals                   # statistical cue is off by default


def test_the_statistical_cue_is_off_by_default():
    """We report what is there. "61% below the median" is us judging a value.

    The rule is kept and still tested; it is simply not announced. Reversing the
    decision is this one flag.
    """
    cells = row([80_000, 82_000, 79_000, 31_000, 83_000, 81_000])
    assert attention.find_signals(cells) == {}
    louder = attention.find_signals(cells, include_statistical=True)
    assert "E2" in louder and louder["E2"][0].type == "anomaly"
