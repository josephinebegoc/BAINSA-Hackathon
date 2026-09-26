"""Chart attention: what a sighted reader sees on a line at a glance.

Four rules, all deterministic, one pass over each series:

    highest           the peak of the line
    lowest            its lowest point
    largest_increase  the steepest rise between two neighbouring points
    largest_decrease  the steepest fall between two neighbouring points

"Steepest" means the biggest move in the chart's own units, because that is the
segment that looks steepest on screen. The percentage is reported alongside it.

Same rules as the cell engine's wording: state the facts, never a verdict. "Italy
fell from €154,000 in July to €62,000 in August, a 60% fall" -- not "a worrying
collapse". The user decides what it means.

Pure functions, no I/O. Nothing here may raise into the upload: a chart we cannot
analyse keeps its points and simply has no events.
"""

from .explain import spoken_header
from .models import Chart, ChartEvent, ChartPoint, ChartSeries, Signal

MIN_POINTS = 3        # fewer numbers than this and "highest" or "steepest" says nothing

# Events on the same point are listed in this order.
_KIND_ORDER = {"highest": 0, "lowest": 1, "largest_increase": 2, "largest_decrease": 3}


def apply_chart_events(charts: list[Chart], step_word: str | None = None) -> None:
    """Attach events to every chart. A chart that fails keeps no events."""
    for chart in charts:
        try:
            chart.events = chart_events(chart, step_word)
        except Exception:
            chart.events = []


def chart_events(chart: Chart, step_word: str | None = None) -> list[ChartEvent]:
    """All events on one chart, series by series, left to right."""
    events: list[ChartEvent] = []
    for index, series in enumerate(chart.series, start=1):
        events.extend(series_events(series, f"{chart.id}/s{index}", step_word,
                                    fallback_name=chart.title))
    return events


def series_events(series: ChartSeries, prefix: str, step_word: str | None = None,
                  fallback_name: str | None = None) -> list[ChartEvent]:
    """The four events on one line, ordered by where they sit on it."""
    numbered = [(i, p) for i, p in enumerate(series.points) if p.value is not None]
    if len(numbered) < MIN_POINTS:
        return []

    name = series.name or fallback_name
    found: list[ChartEvent] = []

    values = [p.value for _, p in numbered]
    if max(values) != min(values):          # a flat line has no peak and no trough
        found.append(_extreme("highest", max(values), numbered, name, series.name, prefix))
        found.append(_extreme("lowest", min(values), numbered, name, series.name, prefix))

    # Only neighbouring points: a blank between two values is a gap in the line,
    # and a sighted reader sees no segment across it.
    moves = [(i, a, i + 1, b) for (i, a), (j, b) in zip(numbered, numbered[1:]) if j == i + 1]
    rises = [m for m in moves if m[3].value > m[1].value]
    falls = [m for m in moves if m[3].value < m[1].value]
    if rises:
        found.append(_move("largest_increase", rises, name, series.name, prefix, step_word))
    if falls:
        found.append(_move("largest_decrease", falls, name, series.name, prefix, step_word))

    found.sort(key=lambda e: (e.point, _KIND_ORDER[e.kind]))
    return found


# --- the rules -----------------------------------------------------------------------

def _extreme(kind: str, target: float, numbered: list[tuple[int, ChartPoint]],
             name: str | None, series: str | None, prefix: str) -> ChartEvent:
    hits = [(i, p) for i, p in numbered if p.value == target]
    index, point = hits[0]                  # the first one, reading left to right
    tied = [p.category for _, p in hits[1:]]
    word = "highest" if kind == "highest" else "lowest"

    sentence = f"{_whose(name)} {word} value on this chart is {point.display}, in {_when(point.category)}."
    if tied:
        sentence += f" It is the same in {_listed([_when(c) for c in tied])}."

    return ChartEvent(
        id=f"{prefix}/{kind}", kind=kind, series=series,
        point=index, ref=point.ref, category=point.category,
        value=point.value, display=point.display,
        tied_with=tied,
        signal=Signal(type="trend", severity="low",
                      detail=f"{word.capitalize()} point: {_when(point.category)}"),
        explanation=sentence,
    )


def _move(kind: str, moves: list[tuple[int, ChartPoint, int, ChartPoint]],
          name: str | None, series: str | None, prefix: str,
          step_word: str | None) -> ChartEvent:
    rising = kind == "largest_increase"
    size = (lambda m: m[3].value - m[1].value) if rising else (lambda m: m[1].value - m[3].value)
    biggest = max(size(m) for m in moves)
    hits = [m for m in moves if size(m) == biggest]
    i, before, j, after = hits[0]           # the first one, reading left to right

    change = after.value - before.value
    pct = change / abs(before.value) if before.value else None
    noun, verb = ("rise", "rose") if rising else ("fall", "fell")

    sentence = (f"{name or 'The line'} {verb} from {before.display} in {_when(before.category)} "
                f"to {after.display} in {_when(after.category)}")
    if pct is not None:
        percent = round(abs(pct) * 100)
        sentence += f", a {percent}% {noun}." if percent else f", a {noun} of less than 1%."
    else:
        sentence += "."
    between = f"consecutive {step_word}s" if step_word else "neighbouring points"
    sentence += f" It is the largest {noun} between {between} on this chart."
    for _, b, _, a in hits[1:]:
        sentence += (f" The {noun} from {_when(b.category)} to {_when(a.category)} "
                     f"is the same size.")

    return ChartEvent(
        id=f"{prefix}/{kind}", kind=kind, series=series,
        point=j, ref=after.ref, category=after.category,
        value=after.value, display=after.display,
        from_point=i, from_category=before.category,
        from_value=before.value, from_display=before.display,
        change=change, pct_change=pct,
        tied_with=[a.category for _, _, _, a in hits[1:]],
        signal=Signal(type="trend", severity="low",
                      detail=f"Largest {noun}: {_when(after.category)}"),
        explanation=sentence,
    )


# --- words -----------------------------------------------------------------------------

def _when(category: str) -> str:
    """A category as it should be heard: "Aug" -> "August"."""
    return spoken_header(category) or category


def _whose(name: str | None) -> str:
    if not name:
        return "The"
    return f"{name}'" if name.endswith("s") else f"{name}'s"


def _listed(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]
