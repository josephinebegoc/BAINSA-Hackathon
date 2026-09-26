"""UNDERSTAND: why a cell was flagged, in one or two spoken sentences.

The template is the product. The LLM only rephrases what the template already
says, and every failure -- no key, no network, a slow response, a model that
editorialises -- falls back to it. The demo must work on a train with no signal.

What this is allowed to say is narrow on purpose. The engine found facts; this
turns them into English. It does not decide whether a number is good, bad,
concerning or worth acting on. That is the user's judgement, and taking it from
them is the thing this whole product exists not to do.
"""

import json
import math
import os
import re
import statistics

from .attention import unit_of
from .models import ExplainRequest, TextResponse

# Words that turn a fact into an opinion. If the model reaches for one of these,
# it has stopped describing and started advising, and we use the template instead.
JUDGEMENT_WORDS = {
    "worrying", "worryingly", "concerning", "concerningly", "alarming", "alarmingly",
    "problem", "problematic", "issue", "worrying", "troubling", "poor", "poorly",
    "bad", "badly", "good", "great", "excellent", "healthy", "unhealthy",
    "disappointing", "impressive", "should", "must", "need", "needs", "recommend",
    "recommended", "suggest", "suggests", "investigate", "check", "review",
    "attention", "warning", "beware", "careful", "risk", "risky", "danger",
    "significant", "significantly", "notably", "surprisingly", "unfortunately",
    "likely", "probably", "suspicious", "suspect", "wrong", "error-prone",
}


# Which models accept output_config.effort. Haiku rejects it outright, and a
# rejected call falls back to the template -- silently, because that is what the
# fallback is for. Keep the list explicit rather than guessing from the model name.
EFFORT_PREFIXES = ("claude-opus-", "claude-sonnet-5", "claude-fable-", "claude-mythos-")


def model_kwargs(model: str) -> dict:
    """The per-model request options, so an unsupported one is never sent."""
    if model.startswith(EFFORT_PREFIXES):
        # A rephrasing job: keep the call inside its timeout.
        return {"output_config": {"effort": "low"}}
    return {}

SYSTEM = """You rewrite spreadsheet facts as one or two short spoken sentences for \
someone exploring a spreadsheet by ear.

Rules, all of them absolute:
- Use only the facts you are given. Never state a number that is not in the input.
- Describe what is there. Never say whether it is good, bad, concerning, a problem, \
or what the listener should do about it. No advice, no warnings, no speculation \
about causes.
- Plain spoken English. No markdown, no bullet points, no headings, no emphasis.
- Two sentences at most. Shorter is better.
- Do not begin with "This cell" or repeat the cell reference."""


SCALE_SPREAD = 100      # the same like-with-like rule the attention engine uses

# Spoken aloud, "Mar" and "Aug" come out as noises rather than months in several
# voices. The grid still shows whatever the sheet wrote; only the speech expands.
MONTH_NAMES = {
    "jan": "January", "feb": "February", "mar": "March", "apr": "April",
    "may": "May", "jun": "June", "jul": "July", "aug": "August",
    "sep": "September", "sept": "September", "oct": "October",
    "nov": "November", "dec": "December",
}


def spoken_header(header: str | None) -> str:
    """A column header as it should be heard, not as it is written."""
    if not header:
        return ""
    key = header.strip().rstrip(".").lower()
    return MONTH_NAMES.get(key, header)


def _comparable(values: list, anchor) -> list[float]:
    """The row's values that are the same kind of quantity as this cell's.

    The browser sends the whole row, which may mix revenue with a growth ratio.
    Saying a row "runs from -0 to 154,000" is worse than saying nothing, so the
    server filters rather than trusting what it was handed.
    """
    numbers = [float(v) for v in values
               if isinstance(v, (int, float)) and not isinstance(v, bool)]
    if not numbers:
        return []

    scale = abs(float(anchor)) if isinstance(anchor, (int, float)) and anchor else 0
    if not scale:
        sizes = [abs(n) for n in numbers if n]
        scale = statistics.median(sizes) if sizes else 0
    if not scale:
        return numbers

    limit = math.log10(SCALE_SPREAD)
    return [n for n in numbers
            if n == 0 or abs(math.log10(abs(n) / scale)) <= limit]


def _sentence(parts: list[str]) -> str:
    out = ". ".join(p.rstrip(". ") for p in parts if p)
    return out + "." if out else ""


def template(request: ExplainRequest) -> str:
    """The explanation we always have."""
    cell = request.cell
    label = request.row_label or cell.row_label
    header = spoken_header(request.col_header or cell.col_header)

    signals = request.signals or cell.signals
    details = [s.detail for s in signals]
    if not details:
        return _sentence([", ".join(p for p in (label, header) if p),
                          "No cues on this cell"])

    # "Germany, Mar. 148% above Germany's median" says Germany twice. When the
    # cue already names the row, the prefix does not need to.
    joined_details = " ".join(details)
    if label and label in joined_details:
        where = header
    else:
        where = ", ".join(p for p in (label, header) if p)

    joined = details[0]
    for extra in details[1:]:
        joined += ". " + extra

    parts = [where, joined]

    numbers = [n for n in _comparable(request.row_values, cell.value)
               if n != cell.value]
    if len(numbers) >= 3:
        # Speak the numbers the way the sheet shows them. "91,000" loses the euro
        # sign the listener can see on every other cell in the row.
        unit = unit_of(cell.display) if cell.display else ""
        symbol = unit if len(unit) == 1 and not unit.isalnum() else ""
        parts.append(f"Other values in this row run from {symbol}{min(numbers):,.0f} "
                     f"to {symbol}{max(numbers):,.0f}")
    return _sentence(parts)


def _digits(text: str) -> set[str]:
    """Digit runs, ignoring separators, so "62,000" and "62000" compare equal."""
    return set(re.findall(r"\d+", text.replace(",", "").replace(" ", "").replace(".", "")))


def _acceptable(text: str, facts: str) -> bool:
    """Reject anything that editorialises or invents a number."""
    if not text or len(text) > 400:
        return False
    if re.search(r"[*#`_\[\]]", text):          # markdown leaked through
        return False
    words = set(re.findall(r"[a-z']+", text.lower()))
    if words & JUDGEMENT_WORDS:
        return False
    return _digits(text) <= _digits(facts)      # no number we did not supply


def _facts_for(request: ExplainRequest) -> dict:
    cell = request.cell
    return {
        "row": request.row_label or cell.row_label,
        "column": request.col_header or cell.col_header,
        "value": cell.display or cell.value,
        "cues": [{"kind": s.type, "fact": s.detail}
                 for s in (request.signals or cell.signals)],
        "other_values_in_row": _comparable(request.row_values, cell.value)[:24],
    }


def explain(request: ExplainRequest, timeout: float = 5.0) -> TextResponse:
    """One or two sentences. Falls back to the template on any failure at all."""
    fallback = TextResponse(text=template(request), source="template")

    if not os.environ.get("ANTHROPIC_API_KEY"):
        return fallback

    facts = _facts_for(request)
    payload = json.dumps(facts, ensure_ascii=False, default=str)

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
