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

import json
import os
import statistics

from . import attention
from .chart_attention import KIND_NAMES
from .explain import JUDGEMENT_WORDS, _acceptable, model_kwargs, spoken_header
from .models import OverviewFacts, SheetModel, TextResponse

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


def facts_for(model: SheetModel) -> OverviewFacts:
    """Measure the sheet. No opinions."""
    columns = model.series_cols or attention.main_series_columns(
        model.cells, model.header_row, model.label_col)
    series = [c for c in columns if _typical(model, c)]
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
        charts=[_chart_sentence(chart) for chart in model.charts],
        chart_cues=_chart_cues(model),
    )


# --- charts ------------------------------------------------------------------------
# Only ever present when the sheet has a chart; otherwise the overview is unchanged.

CHART_KIND_WORDS = {"line": "line chart"}


def _chart_sentence(chart) -> str:
    """"There is one line chart, Italy: Monthly Sales 2026, showing Italy from
    January to December." Title, type, series and categories, as the chart has them."""
    kind = CHART_KIND_WORDS.get(chart.kind, "chart")
    title = f", {chart.title}," if chart.title else ", without a title,"
    names = [s.name for s in chart.series if s.name]
    showing = (f" showing {_listed(names)}" if names
               else f" with {_plural(len(chart.series), 'line')}")
    points = chart.series[0].points if chart.series else []
    span = (f" from {spoken_header(points[0].category)} to {spoken_header(points[-1].category)}"
            if len(points) > 1 else "")
    return f"There is one {kind}{title}{showing}{span}."


def _chart_cues(model: SheetModel) -> str:
    """Where the chart's events are, one phrase per place, left to right.

    "On the chart: the largest rise is in March; the highest point is in July; the
    lowest point and largest fall are in August, where the cell is also flagged."
    """
    events = {e.id: e for chart in model.charts for e in chart.events}
    places = [item for item in model.attention_items if item.events]
    places.sort(key=lambda item: (item.chart or "", item.series or 0, item.point or 0))
    phrases = []
    for item in places:
        kinds = [events[i].kind for i in item.events if i in events]
        if not kinds:
            continue
        names = _listed([KIND_NAMES[k] for k in kinds])
        verb = "is" if len(kinds) == 1 else "are"
        when = spoken_header(events[item.events[0]].category)
        phrase = f"the {names} {verb} in {when}"
        if item.kind == "cell":
            phrase += ", where the cell is also flagged"
        phrases.append(phrase)
    return f"On the chart: {'; '.join(phrases)}." if phrases else ""


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

    # Charts are not described here: Chart mode (4, then R or C) and G for the
    # workbook's own charts give their facts when the listener asks for them.

    total = sum(facts.signal_counts.values())
    if not total:
        parts.append("No cells are flagged.")
    else:
        named = [_plural(facts.signal_counts[k], CUE_NAMES[k])
                 for k in CUE_ORDER if facts.signal_counts.get(k)]
        parts.append(f"{_plural(total, 'cell')} flagged: {_listed(named)}.")
    if total:
        parts.append("Press N to go to the first.")
    elif facts.chart_cues:
        # No flagged cells, but the chart has marked points in the N order.
        parts.append("Press N to go through the chart's marked points.")

    return " ".join(parts)


def overview_for(model: SheetModel) -> str:
    return template(facts_for(model))


SYSTEM = """You rewrite a spreadsheet's measurements as a short spoken orientation \
for someone about to explore it by ear.

Rules, all of them absolute:
- Use only the facts you are given. Never state a number that is not in the input.
- Say what the sheet contains. Never say whether the numbers are good, bad, rising, \
falling, healthy or worth attention, and never suggest what to look at or do.
- Plain spoken English. No markdown, no bullet points, no headings.
- Two sentences at most."""


def polish_overview(facts: OverviewFacts, timeout: float = 5.0) -> TextResponse:
    """The template, rephrased. Any failure at all returns the template."""
    fallback = TextResponse(text=template(facts), source="template")

    if not os.environ.get("ANTHROPIC_API_KEY"):
        return fallback

    payload = facts.model_dump_json()
    try:
        import anthropic

        model = os.environ.get("ANTHROPIC_MODEL", "claude-opus-5")
        client = anthropic.Anthropic()
        response = client.with_options(timeout=timeout).messages.create(
            model=model,
            max_tokens=256,
            system=SYSTEM,
            messages=[{"role": "user", "content": payload}],
            **model_kwargs(model),
        )
        text = "".join(b.text for b in response.content if b.type == "text").strip()
    except Exception:
        return fallback

    if not _acceptable(text, payload + " " + fallback.text):
        return fallback
    return TextResponse(text=text, source="llm")
