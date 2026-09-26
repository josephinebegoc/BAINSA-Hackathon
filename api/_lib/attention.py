"""Decide which cells deserve attention.

Pure functions, no I/O, no state. Nothing here knows about countries, months or
revenue: it is handed cells and works on whatever is in them, so an arbitrary
uploaded spreadsheet gets the same treatment as our demo file.

Four kinds of signal, per CLAUDE.md:

    visual   the author drew attention to it by hand (fill, font colour, bold)
    anomaly  it sits far away from the rest of its series
    trend    it reverses a run of consecutive moves
    error    it holds an Excel error value

The thresholds are module constants rather than literals buried in the code, so
they can be seen, explained and tuned in one place.
"""

import math
import statistics
from collections import Counter, defaultdict

from .models import Cell, Severity, Signal

# --- thresholds ---------------------------------------------------------------

MIN_SERIES = 4          # fewer numbers than this and "unusual" means nothing
Z_THRESHOLD = 3.5       # robust z-score, median/MAD
Z_MIN_PCT = 0.15        # ...but also at least this far from the median (see below)
PCT_THRESHOLD = 0.40    # fallback when the spread is too degenerate for a z-score
TREND_MIN_RUN = 3       # consecutive moves one way before a reversal counts
TREND_REVERSAL = 0.25   # and the reversal must be at least this big
SCALE_SPREAD = 100      # columns within this factor of each other are comparable

# Why Z_MIN_PCT exists: a series with tight noise has a tiny MAD, which makes the
# robust z-score explode on trivial variation. Without a floor, a cell sitting 13%
# above its row median gets reported as unusual, which is noise, not attention.
#
# Why the distance-from-median rule is only a fallback: a row that changes regime
# partway through (climbs for seven months, then halves) has its median dragged into
# the gap between the two levels, so cells at BOTH ends read as far from it. On the
# real demo file that flagged an ordinary peak sitting at the top of a smooth climb.
# The z-score does not make that mistake, so it leads; distance only steps in when
# the spread is too small to compute a meaningful z-score at all.
MAD_DEGENERATE = 0.01   # MAD this small next to the median means "no real spread"

ERROR_WORDS = {
    "#DIV/0!": "Formula error: division by zero",
    "#N/A": "Formula error: value not available",
    "#VALUE!": "Formula error: wrong kind of value",
    "#REF!": "Formula error: the cell it refers to is gone",
    "#NAME?": "Formula error: unrecognised name",
    "#NULL!": "Formula error: empty intersection",
    "#NUM!": "Formula error: impossible number",
}

_SEVERITY_RANK: dict[Severity, int] = {"high": 0, "medium": 1, "low": 2}


# --- colours -----------------------------------------------------------------

def colour_name(rgb: str | None) -> str | None:
    """Plain word for a colour, by nearest hue. Never returns a hex code.

    Returns None when there is no colour or it cannot be resolved, so callers can
    fall back to saying "highlighted" without naming a colour.
    """
    if not rgb or not isinstance(rgb, str):
        return None
    h = rgb.strip().lstrip("#")
    if len(h) == 8:          # ARGB from openpyxl
        h = h[2:]
    if len(h) != 6:
        return None
    try:
        r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return None

    hi, lo = max(r, g, b), min(r, g, b)
    if hi - lo < 30:                      # barely saturated: grey scale
        return "white" if hi > 220 else "black" if hi < 40 else "grey"

    span = hi - lo
    if hi == r:
        hue = (60 * (g - b) / span) % 360
    elif hi == g:
        hue = 60 * (b - r) / span + 120
    else:
        hue = 60 * (r - g) / span + 240

    for upper, name in ((15, "red"), (45, "orange"), (70, "yellow"),
                        (170, "green"), (200, "teal"), (260, "blue"),
                        (290, "purple"), (345, "pink"), (360, "red")):
        if hue < upper:
            return name
    return None


# --- series: compare like with like ------------------------------------------

def unit_of(display: str | None) -> str:
    """The non-numeric part of a formatted value: "€82,400" -> "€", "4.2%" -> "%".

    Used to avoid comparing a growth percentage against revenue figures, which
    would make every percentage look like an extreme anomaly.
    """
    if not display:
        return ""
    return "".join(ch for ch in display if not (ch.isdigit() or ch in " ,._-+()")).lower()


def _numeric(cell: Cell) -> bool:
    # bool is an int in Python, and a date is not a quantity we can compare.
    return isinstance(cell.value, (int, float)) and not isinstance(cell.value, bool)


def comparable_axes(cells: list[Cell], axis: str = "col") -> list[set[int]]:
    """Which columns (or rows) hold quantities of the same kind.

    A "Growth vs Jan" column of 0.8 must never be compared against revenue figures
    of 130,000, or every growth figure reads as an extreme anomaly. Formatting is
    the obvious way to tell them apart, but real files are often formatted General
    with no % sign at all, so we go by scale instead: group by unit first, then keep
    together only the lines whose medians sit within SCALE_SPREAD of each other.

    Scale is judged per line, across the whole sheet, rather than per cell -- one
    outlier barely moves its own column's median, so it stays in its group and can
    still be detected. Bucketing individual values would hide it in a group of one.
    """
    index = (lambda c: c.col) if axis == "col" else (lambda c: c.row)

    values: dict[int, list[float]] = defaultdict(list)
    units: dict[int, list[str]] = defaultdict(list)
    for cell in cells:
        if _numeric(cell) and cell.error is None:
            values[index(cell)].append(abs(float(cell.value)))
            units[index(cell)].append(unit_of(cell.display))

    by_unit: dict[str, list[int]] = defaultdict(list)
    medians: dict[int, float] = {}
    for idx, vals in values.items():
        medians[idx] = statistics.median(vals)
        by_unit[Counter(units[idx]).most_common(1)[0][0]].append(idx)

    groups: list[set[int]] = []
    for lines in by_unit.values():
        scales = [medians[i] for i in lines if medians[i] > 0]
        if not scales:
            groups.append(set(lines))
            continue
        middle = statistics.median(scales)
        near = {i for i in lines if medians[i] <= 0
                or abs(math.log10(medians[i] / middle)) <= math.log10(SCALE_SPREAD)}
        far = set(lines) - near
        groups.append(near)
        if far:
            groups.append(far)
    return [g for g in groups if len(g) >= MIN_SERIES]


def series_groups(line: list[Cell], keep: set[int] | None = None,
                  axis: str = "col") -> list[list[Cell]]:
    """The comparable numeric cells of one row or column, in order."""
    index = (lambda c: c.col) if axis == "col" else (lambda c: c.row)
    series = [c for c in line
              if _numeric(c) and c.error is None and (keep is None or index(c) in keep)]
    series.sort(key=index)
    return [series] if len(series) >= MIN_SERIES else []


# --- the four rules ----------------------------------------------------------

def anomaly_signals(series: list[Cell], label: str | None) -> dict[str, Signal]:
    """Cells sitting far from their series median. Keyed by cell ref."""
    values = [float(c.value) for c in series]
    if len(values) < MIN_SERIES:
        return {}

    median = statistics.median(values)
    mad = statistics.median([abs(v - median) for v in values])
    denom = abs(median)
    whose = f"{label}'s" if label else "the"

    found: dict[str, Signal] = {}
    for cell in series:
        value = float(cell.value)
        gap = abs(value - median)
        pct = gap / denom if denom else 0.0
        z = 0.6745 * gap / mad if mad else 0.0

        spread_is_usable = mad > 0 and denom and (mad / denom) > MAD_DEGENERATE
        unusual = ((z > Z_THRESHOLD and pct > Z_MIN_PCT) if spread_is_usable
                   else pct > PCT_THRESHOLD)
        if unusual:
            side = "below" if value < median else "above"
            found[cell.ref] = Signal(
                type="anomaly",
                severity="medium",
                detail=f"{round(pct * 100)}% {side} {whose} median",
            )
    return found


def trend_signals(series: list[Cell], step_word: str | None = None) -> dict[str, Signal]:
    """Cells that reverse a run of consecutive moves. Keyed by cell ref.

    `step_word` names what one step along the series is ("month", "quarter"), so the
    spoken detail can read "Breaks a 4-month upward trend". The engine cannot know
    that on its own, so without it the wording stays neutral.
    """
    values = [float(c.value) for c in series]
    found: dict[str, Signal] = {}

    for i in range(1, len(values)):
        previous = values[i - 1]
        if previous == 0:
            continue
        move = (values[i] - previous) / abs(previous)

        if move < -TREND_REVERSAL:
            direction, word = 1, "upward"
        elif move > TREND_REVERSAL:
            direction, word = -1, "downward"
        else:
            continue

        run = 0
        j = i - 1
        while j >= 1:
            step = values[j] - values[j - 1]
            if step * direction > 0:
                run += 1
                j -= 1
            else:
                break

        if run >= TREND_MIN_RUN:
            # State the shape and the size of the reversal, and stop there. Calling
            # it a worrying drop would be us analysing on the user's behalf.
            verb = "Falls" if direction == 1 else "Rises"
            ran = "rises" if direction == 1 else "falls"
            span = f"{run} {step_word}s of" if step_word else f"{run}"
            detail = f"{verb} {round(abs(move) * 100)}% after {span} {ran}"
            found[series[i].ref] = Signal(type="trend", severity="medium", detail=detail)
    return found


def visual_signal(cell: Cell, line: list[Cell]) -> Signal | None:
    """The author drew attention to this cell by hand."""
    if cell.fill:
        name = colour_name(cell.fill)
        detail = (f"Author highlighted this cell in {name}" if name
                  else "Author highlighted this cell")
        return Signal(type="visual", severity="high", detail=detail)

    name = colour_name(cell.font_color)
    if name in ("red", "orange"):
        return Signal(type="visual", severity="high",
                      detail=f"Author coloured the text {name}")

    # Bold only counts if it singles the cell out; a bold header or total row
    # is formatting, not emphasis.
    if cell.bold:
        others = [c for c in line if c.ref != cell.ref and c.value is not None]
        if others and sum(c.bold for c in others) <= len(others) / 2:
            return Signal(type="visual", severity="high",
                          detail="Author made this cell bold")
    return None


def error_signal(cell: Cell) -> Signal | None:
    """The cell holds an Excel error value."""
    if not cell.error:
        return None
    detail = ERROR_WORDS.get(cell.error.strip().upper(), f"Formula error: {cell.error}")
    return Signal(type="error", severity="high", detail=detail)


# --- putting it together -----------------------------------------------------

def find_signals(
    cells: list[Cell],
    header_row: int = 1,
    label_col: int = 1,
    orientation: str = "row",
    step_word: str | None = None,
) -> dict[str, list[Signal]]:
    """All signals for a sheet, keyed by cell ref.

    `orientation` is "row" (default), "col", or "both". Use "col" when the sheet
    reads down the page -- when the row labels are the time periods.
    """
    body = [c for c in cells if c.row != header_row and c.col != label_col]
    found: dict[str, list[Signal]] = defaultdict(list)

    # Signals that depend only on the cell, or on its row's formatting.
    by_row: dict[int, list[Cell]] = defaultdict(list)
    for cell in body:
        by_row[cell.row].append(cell)
    for cell in body:
        for signal in (error_signal(cell), visual_signal(cell, by_row[cell.row])):
            if signal:
                found[cell.ref].append(signal)

    # Series signals. Which lines hold comparable quantities is decided once for the
    # whole sheet, then each row (or column) is read through that lens.
    plans: list[tuple[list[list[Cell]], str, list[set[int]]]] = []
    if orientation in ("row", "both"):
        rows = [sorted(by_row[r], key=lambda c: c.col) for r in sorted(by_row)]
        plans.append((rows, "col", comparable_axes(body, "col")))
    if orientation in ("col", "both"):
        by_col: dict[int, list[Cell]] = defaultdict(list)
        for cell in body:
            by_col[cell.col].append(cell)
        cols = [sorted(by_col[c], key=lambda c: c.row) for c in sorted(by_col)]
        plans.append((cols, "row", comparable_axes(body, "row")))

    for lines, axis, groups in plans:
        for line in lines:
            if not line:
                continue
            label = line[0].row_label if axis == "col" else line[0].col_header
            for keep in groups:
                for series in series_groups(line, keep, axis):
                    for ref, signal in anomaly_signals(series, label).items():
                        found[ref].append(signal)
                    for ref, signal in trend_signals(series, step_word).items():
                        found[ref].append(signal)

    _escalate(found)
    return dict(found)


def _escalate(found: dict[str, list[Signal]]) -> None:
    """A cell that is both unusual and a trend reversal is more than either alone."""
    for signals in found.values():
        kinds = {s.type for s in signals}
        if {"anomaly", "trend"} <= kinds:
            for signal in signals:
                if signal.type in ("anomaly", "trend"):
                    signal.severity = "high"


def attention_order(cells: list[Cell]) -> list[str]:
    """Flagged refs, most serious first, then in reading order."""
    flagged = [c for c in cells if c.signals]
    return [
        c.ref
        for c in sorted(
            flagged,
            key=lambda c: (min(_SEVERITY_RANK[s.severity] for s in c.signals), c.row, c.col),
        )
    ]


def apply_signals(cells: list[Cell], **kwargs) -> list[str]:
    """Convenience: attach signals to the cells and return the attention order."""
    found = find_signals(cells, **kwargs)
    for cell in cells:
        cell.signals = found.get(cell.ref, [])
    return attention_order(cells)
