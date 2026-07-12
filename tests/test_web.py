import json
import os
import time

import fakeredis
import pytest
from fastapi.testclient import TestClient
from rq import Queue

from fitpdf.gs import gs_available
from fitpdf.web import store
from fitpdf.web.app import create_app, sweep_expired
from fitpdf.web.config import Settings

requires_gs = pytest.mark.skipif(not gs_available(), reason="ghostscript not installed")


@pytest.fixture()
def web(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", ttl_seconds=1800, gs_timeout=120)
    r = fakeredis.FakeRedis()
    q = Queue(settings.queue_name, connection=r, is_async=False)
    app = create_app(settings=settings, redis_conn=r, queue=q)
    with TestClient(app) as client:
        yield client, r, settings


def _upload(client, pdf_path, name="test.pdf"):
    with open(pdf_path, "rb") as f:
        return client.post(
            "/api/upload", files={"file": (name, f.read(), "application/pdf")}
        )


def test_upload_returns_job(web, image_pdf):
    client, _, _ = web
    res = _upload(client, image_pdf)
    assert res.status_code == 200
    body = res.json()
    assert body["pages"] == 3
    assert body["size_bytes"] == image_pdf.stat().st_size
    assert body["expires_in"] == 1800
    assert body["job_id"]


def test_upload_rejects_non_pdf(web, tmp_path):
    client, _, settings = web
    junk = tmp_path / "junk.pdf"
    junk.write_bytes(b"this is not a pdf at all" * 100)
    res = _upload(client, junk)
    assert res.status_code == 422
    # nothing left on disk
    assert not any(settings.data_dir.iterdir())


def test_upload_rejects_oversize(tmp_path, image_pdf):
    settings = Settings(data_dir=tmp_path / "data", max_upload_bytes=1024)
    r = fakeredis.FakeRedis()
    q = Queue(settings.queue_name, connection=r, is_async=False)
    app = create_app(settings=settings, redis_conn=r, queue=q)
    with TestClient(app) as client:
        res = _upload(client, image_pdf)
    assert res.status_code == 413
    assert not any(settings.data_dir.iterdir())


def test_job_state_and_404(web, image_pdf):
    client, _, _ = web
    job_id = _upload(client, image_pdf).json()["job_id"]
    state = client.get(f"/api/jobs/{job_id}").json()
    assert state["status"] == "uploaded"
    assert 0 < state["expires_in"] <= 1800
    assert client.get("/api/jobs/nope").status_code == 404


@requires_gs
def test_analyze_returns_floor(web, image_pdf):
    client, _, _ = web
    job_id = _upload(client, image_pdf).json()["job_id"]
    res = client.post(f"/api/jobs/{job_id}/analyze")
    assert res.status_code == 200
    body = res.json()
    assert 0 < body["floor_estimate"] < body["original_bytes"]


@requires_gs
def test_compress_hits_target_and_downloads(web, image_pdf):
    client, r, _ = web
    job_id = _upload(client, image_pdf).json()["job_id"]
    target = int(image_pdf.stat().st_size * 0.5)

    res = client.post(f"/api/jobs/{job_id}/compress", json={"target_bytes": target})
    assert res.status_code == 202

    state = client.get(f"/api/jobs/{job_id}").json()
    assert state["status"] == "done"
    assert state["hit_target"] is True
    assert state["final_bytes"] <= target

    events = store.get_events(r, job_id)
    stages = [e["stage"] for e in events]
    assert stages[0] == "start"
    assert stages[-1] == "done"
    assert "rung_start" in stages

    dl = client.get(f"/api/jobs/{job_id}/download")
    assert dl.status_code == 200
    assert dl.headers["content-type"] == "application/pdf"
    assert len(dl.content) == state["final_bytes"]
    assert "test.fit.pdf" in dl.headers["content-disposition"]


@requires_gs
def test_compress_impossible_target_reports_floor(web, image_pdf):
    client, _, _ = web
    job_id = _upload(client, image_pdf).json()["job_id"]
    client.post(f"/api/jobs/{job_id}/compress", json={"target_bytes": 2000})
    state = client.get(f"/api/jobs/{job_id}").json()
    assert state["status"] == "done"
    assert state["hit_target"] is False
    assert state["method"] == "floor"
    assert state["final_bytes"] > 2000


@requires_gs
def test_sse_replays_events_to_done(web, image_pdf):
    client, _, _ = web
    job_id = _upload(client, image_pdf).json()["job_id"]
    target = int(image_pdf.stat().st_size * 0.5)
    client.post(f"/api/jobs/{job_id}/compress", json={"target_bytes": target})

    with client.stream("GET", f"/api/jobs/{job_id}/events") as res:
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("text/event-stream")
        data_events = []
        saw_state = False
        for line in res.iter_lines():
            if line.startswith("event: state"):
                saw_state = True
            if line.startswith("data: "):
                payload = json.loads(line[len("data: "):])
                if "stage" in payload:
                    data_events.append(payload)
        assert saw_state
        assert data_events[-1]["stage"] == "done"


def test_compress_missing_job_404(web):
    client, _, _ = web
    res = client.post("/api/jobs/nope/compress", json={"target_bytes": 1000})
    assert res.status_code == 404


def test_download_before_compress_404(web, image_pdf):
    client, _, _ = web
    job_id = _upload(client, image_pdf).json()["job_id"]
    assert client.get(f"/api/jobs/{job_id}/download").status_code == 404


def test_delete_removes_everything(web, image_pdf):
    client, r, settings = web
    job_id = _upload(client, image_pdf).json()["job_id"]
    res = client.delete(f"/api/jobs/{job_id}")
    assert res.status_code == 200
    assert client.get(f"/api/jobs/{job_id}").status_code == 404
    assert not (settings.data_dir / job_id).exists()
    assert store.get_job(r, job_id) is None


def test_sweeper_deletes_expired_files(web, image_pdf):
    client, r, settings = web
    job_id = _upload(client, image_pdf).json()["job_id"]
    job_path = settings.data_dir / job_id
    assert job_path.exists()

    # fresh file survives a sweep
    assert sweep_expired(settings.data_dir, settings.ttl_seconds, r) == 0
    assert job_path.exists()

    # backdate the upload past the TTL and sweep again
    old = time.time() - settings.ttl_seconds - 60
    os.utime(job_path / "input.pdf", (old, old))
    assert sweep_expired(settings.data_dir, settings.ttl_seconds, r) == 1
    assert not job_path.exists()
    assert store.get_job(r, job_id) is None


def test_index_served(web):
    client, _, _ = web
    res = client.get("/")
    assert res.status_code == 200
    assert "FitPDF" in res.text
