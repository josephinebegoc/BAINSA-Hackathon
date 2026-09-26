"""ORIENT: the spoken overview of a sheet.

What it is allowed to say: how big the sheet is, what it is called, what its numbers
measure if the sheet says so, roughly what they run between, and how many cells are
flagged. What it must not say: whether that is good, bad, rising, worrying or worth
worrying about. The user decides all of that.

"Overall, values rise" was in the original plan and is deliberately not here: it is
a conclusion. Two typical values and the column they sit under are the same
information without the verdict attached.

Template first, always. The LLM only rephrases, and any failure falls back here.
"""

import statistics

from . import attention
from .models import OverviewFacts, SheetModel

CUE_NAMES = {
    "visual": "author visual cue",
    "anomaly": "statistical cue",
    "trend": "pattern cue",
    "error": "functional cue",
}
CUE_ORDER = ("visual", "anomaly", "trend", "error")


def _typical(model: SheetModel, col: int) -> str:
    """The median value in one column, as it is displayed. "" if there is none."""
    values = [(c.value, c.display) for c in model.cells
              if c.col == col and c.row != model.header_row
              and isinstance(c.value, (int, float)) and not isinstance(c.value, bool)]
    if not values:
        return ""
    median = statistics.median(v for v, _ in values)
    # Show the real cell nearest the median, so the units and formatting are the
    # sheet's own rather than something we invented.
    return min(values, key=lambda pair: abs(pair[0] - median))[1]


def _main_series_columns(model: SheetModel) -> list[int]:
    """The biggest group of columns holding the same kind of quantity.

    The overview must not report a range that runs from euros to a growth ratio, so
    it uses the same like-with-like grouping the attention engine does.
    """
    body = [c for c in model.cells
            if c.row != model.header_row and c.col != model.label_col]
    groups = attention.comparable_axes(body, "col")
    if not groups:
        return [c for c in range(1, model.n_cols + 1) if c != model.label_col]
    return sorted(max(groups, key=len))


def facts_for(model: SheetModel) -> OverviewFacts:
    """Measure the sheet. No opinions."""
    series = [c for c in _main_series_columns(model) if _typical(model, c)]
    first_col = series[0] if series else None
    last_col = series[-1] if len(series) > 1 else None

    counts: dict[str, int] = {}
    for cell in model.cells:
        for signal in cell.signals:
            counts[signal.type] = counts.get(signal.type, 0) + 1

    return OverviewFacts(
        title=model.title,
        value_label=model.value_label,
        n_data_rows=len(model.row_labels),
        n_cols=model.n_cols,
        first_col_header=model.col_headers[0] if model.col_headers else "",
        last_col_header=model.col_headers[-1] if model.col_headers else "",
        first_value=_typical(model, first_col) if first_col else "",
        first_value_header=model.col_headers[first_col - 1] if first_col else "",
        last_value=_typical(model, last_col) if last_col else "",
        last_value_header=model.col_headers[last_col - 1] if last_col else "",
        signal_counts=counts,
    )


def _listed(items: list[str]) -> str:
    if len(items) == 1:
        return items[0]
    return ", ".join(items[:-1]) + " and " + items[-1]


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def template(facts: OverviewFacts) -> str:
    """The overview we always have, with or without an LLM or a network."""
    parts = [f"{facts.title}."]

    if facts.value_label:
        parts.append(f"{facts.value_label.capitalize()}.")

    shape = f"{_plural(facts.n_data_rows, 'row')} by {_plural(facts.n_cols, 'column')}"
    if facts.first_col_header and facts.last_col_header:
        shape += f", from {facts.first_col_header} to {facts.last_col_header}"
    parts.append(shape + ".")

    if facts.first_value and facts.last_value:
        parts.append(f"Typical values are {facts.first_value} under "
                     f"{facts.first_value_header} and {facts.last_value} under "
                     f"{facts.last_value_header}.")

    total = sum(facts.signal_counts.values())
    if not total:
        parts.append("No cells are flagged.")
    else:
        named = [_plural(facts.signal_counts[k], CUE_NAMES[k])
                 for k in CUE_ORDER if facts.signal_counts.get(k)]
        parts.append(f"{_plural(total, 'cell')} flagged: {_listed(named)}.")
        parts.append("Press N to go to the first.")

    return " ".join(parts)


def overview_for(model: SheetModel) -> str:
    return template(facts_for(model))
