import pytest

from fitpdf.units import human_size, parse_size


def test_parse_plain_bytes():
    assert parse_size("2000000") == 2_000_000
    assert parse_size(4096) == 4096


def test_parse_units():
    assert parse_size("4mb") == 4 * 1024**2
    assert parse_size("500 KB") == 500 * 1024
    assert parse_size("0.5MB") == 512 * 1024
    assert parse_size("1gb") == 1024**3
    assert parse_size("100b") == 100


@pytest.mark.parametrize("bad", ["", "abc", "-4mb", "0", "4tb", "mb"])
def test_parse_rejects_garbage(bad):
    with pytest.raises(ValueError):
        parse_size(bad)


def test_human_size_roundtrip():
    assert human_size(100) == "100 B"
    assert human_size(4 * 1024**2) == "4.0 MB"
    assert "KB" in human_size(900 * 1024)
