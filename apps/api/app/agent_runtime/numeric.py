"""Number and unit normalization for the grounding check (Q.3). Pure functions.

Exact-equality semantics: two numbers match only if their VALUES are equal after removing
formatting. "8,849" == "8849" == "8 849" (narrow/no-break space); "100" == "100.0"; but
"8,848" != "8,848.86" and "849" != "8,849" (no rounding, no partial digit runs).
Units are unified before matching: 100 C == 100 degC == 100 degrees Celsius.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

# thousands separators accepted: comma, no-break space, narrow no-break space, thin space
_SEP = ",\u00a0\u202f\u2009"
NUMBER = re.compile(rf"(?<![\d.,])(?:\d{{1,3}}(?:[{_SEP}]\d{{3}})+|\d+)(?:\.\d+)?(?![\d])")
_PLAIN_NUMBER = re.compile(rf"^(?:\d{{1,3}}(?:[{_SEP}]\d{{3}})+|\d+)(?:\.\d+)?$")

# unit spellings -> one canonical form (applied to page text AND to the claim)
_UNITS = [
    (
        re.compile(r"(?<=\d)\s*(?:\u00b0|\u00ba|\u2103|deg\.?\s*|degrees?\s+)c(?:elsius)?\b", re.I),
        " degrees celsius",
    ),
    (
        re.compile(
            r"(?<=\d)\s*(?:\u00b0|\u00ba|\u2109|deg\.?\s*|degrees?\s+)f(?:ahrenheit)?\b", re.I
        ),
        " degrees fahrenheit",
    ),
    (re.compile(r"\u2103", re.I), " degrees celsius"),
    (re.compile(r"\u2109", re.I), " degrees fahrenheit"),
    (re.compile(r"(?<=\d)\s*c\b(?!\.)", re.I), " degrees celsius"),  # "100 C" after a number
]


def units(text: str) -> str:
    for pat, rep in _UNITS:
        text = pat.sub(rep, text)
    return text


def value(token: str) -> Decimal | None:
    """Decimal value of a plain number token ("8,849", "8 849", "100.0"); None otherwise."""
    if not _PLAIN_NUMBER.match(token):
        return None
    try:
        return Decimal(re.sub(rf"[{_SEP}]", "", token))
    except InvalidOperation:
        return None


def values_in(text: str) -> set[Decimal]:
    out: set[Decimal] = set()
    for m in NUMBER.finditer(text):
        v = value(m.group(0))
        if v is not None:
            out.add(v)
    return out


def number_found(token: str, haystack: str) -> bool | None:
    """True/False for a plain number token (value equality); None if `token` is not one."""
    v = value(token)
    if v is None:
        return None
    return v in values_in(haystack)
