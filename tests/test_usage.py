"""Daily usage counts: what is counted, from where, and that nothing else is kept."""

import sqlite3
from datetime import date

import fakeredis
import pytest
from fastapi.testclient import TestClient
from rq import Queue

from fitpdf.web import usage
from fitpdf.web.app import create_app
from fitpdf.web.config import Settings

SITE = "https://fitfilesize.com"


@pytest.fixture()
def counted(tmp_path):
    settings = Settings(
        data_dir=tmp_path / "data",
        usage_db=tmp_path / "usage" / "usage.db",
        allowed_origins=(SITE,),
    )
    r = fakeredis.FakeRedis()
    q = Queue(settings.queue_name, connection=r, is_async=False)
    app = create_app(settings=settings, redis_conn=r, queue=q, background_sweep=False)
    with TestClient(app) as client:
        yield client, settings


def _counts(settings):
    return {
        row[1:6]: row[6] for row in usage.rows(settings.usage_db, 1, today=date.today())
    }


def test_the_site_counts_an_upload_and_one_download_per_job(counted, photo_jpg):
    client, settings = counted
    with open(photo_jpg, "rb") as f:
        up = client.post(
            "/api/upload",
            files={"file": ("my passport.jpg", f.read(), "image/jpeg")},
            data={"page": "neet-photo"},
            headers={"Origin": SITE},
        ).json()
    job = up["job_id"]
    client.post(f"/api/jobs/{job}/compress", json={"target_bytes": 10_000_000}, headers={"Origin": SITE})
    assert client.get(f"/api/jobs/{job}/download").status_code == 200
    assert client.get(f"/api/jobs/{job}/download").status_code == 200  # fetched twice

    assert _counts(settings) == {
        ("upload", "web", "image", "neet-photo", "-"): 1,
        ("download", "web", "image", "neet-photo", "fit"): 1,
    }


def test_the_mcp_package_and_other_api_callers_are_told_apart(counted, photo_jpg):
    client, settings = counted
    for agent in ("fitfilesize-mcp/0.2.0 (client: x)", "curl/8.7.1"):
        with open(photo_jpg, "rb") as f:
            body = client.post(
                "/api/fit",
                files={"file": ("a.jpg", f.read(), "image/jpeg")},
                data={"target": "10MB"},
                headers={"User-Agent": agent},
            ).json()
        client.get(f"/api/jobs/{body['job_id']}/download")

    counts = _counts(settings)
    assert counts[("upload", "mcp", "image", "-", "-")] == 1
    assert counts[("upload", "api", "image", "-", "-")] == 1
    assert counts[("download", "mcp", "image", "-", "fit")] == 1
    assert counts[("download", "api", "image", "-", "fit")] == 1


def test_a_result_over_the_limit_is_counted_as_over(counted, photo_jpg):
    client, settings = counted
    with open(photo_jpg, "rb") as f:
        body = client.post(
            "/api/fit", files={"file": ("a.jpg", f.read(), "image/jpeg")}, data={"target": "1KB"}
        ).json()
    assert body["fits"] is False
    client.get(f"/api/jobs/{body['job_id']}/download")
    assert _counts(settings)[("download", "api", "image", "-", "over")] == 1


def test_nothing_about_the_file_or_visitor_is_stored(counted, photo_jpg):
    client, settings = counted
    with open(photo_jpg, "rb") as f:
        client.post(
            "/api/upload",
            files={"file": ("Jane Doe passport.jpg", f.read(), "image/jpeg")},
            data={"page": "/../etc/passwd"},
            headers={"X-Forwarded-For": "203.0.113.9"},
        )
    dump = "\n".join(sqlite3.connect(settings.usage_db).iterdump())
    for secret in ("Jane", "passport", "203.0.113", "etc", str(photo_jpg.stat().st_size)):
        assert secret not in dump
    # An odd page value is dropped, not stored.
    assert _counts(settings) == {("upload", "api", "image", "-", "-"): 1}


def test_counting_is_off_without_a_database_and_never_breaks_a_request(tmp_path, photo_jpg):
    usage.record(None, "upload", "web", "image")  # no setting: nothing happens
    blocked = tmp_path / "file"
    blocked.write_text("not a directory")
    usage.record(blocked / "usage.db", "upload", "web", "image")  # cannot write: logged only


def test_clean_page_and_source():
    assert usage.clean_page(None) == "-"
    assert usage.clean_page("") == "home"
    assert usage.clean_page("/") == "home"
    assert usage.clean_page("gate-photo") == "gate-photo"
    assert usage.clean_page("<script>") == "-"
    assert usage.source_for("fitfilesize-mcp/0.2.0", None, ()) == "mcp"
    assert usage.source_for("Mozilla/5.0", SITE, (SITE,)) == "web"
    assert usage.source_for("Mozilla/5.0", "https://elsewhere.example", (SITE,)) == "api"


def test_report_sums_days_and_pages(tmp_path):
    db = tmp_path / "u.db"
    d = date(2026, 10, 8)
    for _ in range(3):
        usage.record(db, "upload", "web", "image", "neet-photo", today=d)
    usage.record(db, "download", "web", "image", "neet-photo", "fit", today=d)
    usage.record(db, "upload", "mcp", "pdf", today=d)
    text = usage.report(usage.rows(db, 7, today=d))
    assert "2026-10-08     4 (3/1/0)" in text
    assert "1 (1/0/0)" in text
    assert "neet-photo" in text
    assert usage.report([]) == "No uploads or downloads recorded in this period."
