"""Q.3 number/unit normalization: equal values match, near-misses never do."""

import pytest
from app.agent_runtime.numeric import number_found, units, value


@pytest.mark.parametrize(
    "token,page",
    [
        ("8,849", "Elevation 8849 m"),
        ("8849", "Elevation 8,849 m"),
        ("8849", "Elevation 8\u00a0849 m"),  # no-break space separator
        ("8849", "Elevation 8\u202f849 m"),  # narrow no-break space separator
        ("100", "boils at 100.0 degrees"),
        ("1,538", "melts at 1538 C"),
        ("299,792,458", "exactly 299792458 m/s"),
        ("78.37", "boils at 78.37 \u00b0C"),
    ],
)
def test_equal_values_match(token, page):
    assert number_found(token, page) is True


@pytest.mark.parametrize(
    "token,page",
    [
        ("849", "Elevation 8,849 m"),  # digit run inside a bigger number
        ("8,848", "Elevation 8,848.86 m"),  # no rounding
        ("8849", "Elevation 8,848 m"),  # off by one
        ("78.5", "boils at 78.37 \u00b0C"),  # rounded
        ("1500", "handles 1200 vessels"),
        ("2019", "chaired since 2024"),
        ("100", "1000 metres"),
        ("8,49", "8,849"),  # malformed grouping is not a number token
    ],
)
def test_near_misses_never_match(token, page):
    assert number_found(token, page) in (False, None)


def test_non_number_tokens_are_not_numbers():
    assert value("12/05/2020") is None and value("3:45") is None and value("K2") is None
    assert number_found("12/05", "12/05") is None  # caller falls back to literal matching


@pytest.mark.parametrize(
    "text",
    [
        "100 \u00b0C",
        "100\u00b0C",
        "100 degC",
        "100 deg C",
        "100 degrees Celsius",
        "100 C",
        "100 \u2103",
    ],
)
def test_celsius_spellings_unify(text):
    assert units(text).lower().split() == ["100", "degrees", "celsius"]


def test_fahrenheit_is_not_celsius():
    assert "celsius" not in units("212 \u00b0F").lower()


def test_unit_rewrite_needs_a_number_before_it():
    assert units("Section C of the report") == "Section C of the report"
    assert units("C. S. Lewis wrote in 1950") == "C. S. Lewis wrote in 1950"
