import json
import os
import time

import fakeredis
import pytest
from fastapi.testclient import TestClient
from rq import Queue

from fitpdf.gs import gs_available
from fitpdf.web import app as web_app
from fitpdf.web import store
from fitpdf.web.app import create_app, sweep_expired
from fitpdf.web.config import Settings
from fitpdf.web.jobs import run_compress

requires_gs = pytest.mark.skipif(not gs_available(), reason="ghostscript not installed")


@pytest.fixture()
def web(tmp_path):
    settings = Settings(
        data_dir=tmp_path / "data",
        ttl_seconds=600,
        pending_ttl_seconds=1800,
        input_grace_seconds=300,
        gs_timeout=120,
    )
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


def test_upload_image_reports_dimensions(web, photo_jpg):
    client, _, _ = web
    body = _upload(client, photo_jpg, name="photo.jpg").json()
    assert body["kind"] == "image"
    assert (body["width"], body["height"]) == (3000, 2000)
    assert body["pages"] == 1


def test_upload_rejects_unsupported_type(web, tmp_path):
    client, _, settings = web
    doc = tmp_path / "notes.docx"
    doc.write_bytes(b"PK\x03\x04 not really a docx")
    assert _upload(client, doc, name="notes.docx").status_code == 415
    assert not any(settings.data_dir.iterdir())


def test_image_round_trip_downloads_jpeg(web, photo_jpg):
    """Images need no Ghostscript, so this runs everywhere the suite does."""
    client, _, _ = web
    job_id = _upload(client, photo_jpg, name="photo.jpg").json()["job_id"]

    floor = client.post(f"/api/jobs/{job_id}/analyze").json()["floor_estimate"]
    assert 0 < floor < photo_jpg.stat().st_size

    target = int(photo_jpg.stat().st_size * 0.25)
    assert client.post(
        f"/api/jobs/{job_id}/compress", json={"target_bytes": target}
    ).status_code == 202

    state = client.get(f"/api/jobs/{job_id}").json()
    assert state["status"] == "done"
    assert state["kind"] == "image"
    assert state["hit_target"] is True
    assert state["final_bytes"] <= target

    dl = client.get(f"/api/jobs/{job_id}/download")
    assert dl.status_code == 200
    assert dl.headers["content-type"] == "image/jpeg"
    assert "photo.fit.jpg" in dl.headers["content-disposition"]


def test_png_upload_downloads_as_jpeg(web, transparent_png):
    """A PNG in becomes a JPEG out, and the download name has to follow."""
    client, _, _ = web
    job_id = _upload(client, transparent_png, name="logo.png").json()["job_id"]
    client.post(f"/api/jobs/{job_id}/analyze")
    client.post(f"/api/jobs/{job_id}/compress", json={"target_bytes": 4000})

    dl = client.get(f"/api/jobs/{job_id}/download")
    assert dl.status_code == 200
    assert dl.headers["content-type"] == "image/jpeg"
    assert "logo.fit.jpg" in dl.headers["content-disposition"]


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


def test_sweeper_holds_unfinished_job_until_pending_ttl(web, image_pdf):
    client, r, settings = web
    job_id = _upload(client, image_pdf).json()["job_id"]
    job_path = settings.data_dir / job_id
    assert job_path.exists()

    # fresh upload survives a sweep
    assert sweep_expired(settings.data_dir, settings, r) == 0
    assert job_path.exists()

    # an unfinished job is still held well past the (short) completion TTL,
    # because a long compression can legitimately still be running
    store.update_job(r, job_id, created_at=int(time.time()) - settings.ttl_seconds - 60)
    assert sweep_expired(settings.data_dir, settings, r) == 0
    assert job_path.exists()

    # only the pending ceiling removes it
    store.update_job(r, job_id, created_at=int(time.time()) - settings.pending_ttl_seconds - 60)
    assert sweep_expired(settings.data_dir, settings, r) == 1
    assert not job_path.exists()
    assert store.get_job(r, job_id) is None


def test_sweeper_measures_finished_jobs_from_completion(web, image_pdf):
    client, r, settings = web
    job_id = _upload(client, image_pdf).json()["job_id"]
    job_path = settings.data_dir / job_id

    # A slow job: uploaded long ago, finished just now. The download window
    # starts at completion, so it must survive.
    store.update_job(r, job_id, created_at=int(time.time()) - settings.pending_ttl_seconds - 60)
    store.mark_completed(r, job_id, settings.ttl_seconds)
    assert sweep_expired(settings.data_dir, settings, r) == 0
    assert job_path.exists()

    # and it goes once the completion window elapses
    store.update_job(r, job_id, completed_at=int(time.time()) - settings.ttl_seconds - 60)
    assert sweep_expired(settings.data_dir, settings, r) == 1
    assert not job_path.exists()
    assert store.get_job(r, job_id) is None


def test_sweeper_deletes_input_before_output(web, image_pdf):
    client, r, settings = web
    job_id = _upload(client, image_pdf).json()["job_id"]
    job_path = settings.data_dir / job_id
    (job_path / "output.pdf").write_bytes(b"%PDF-1.4 pretend output")

    store.mark_completed(r, job_id, settings.ttl_seconds)

    # inside the grace window both halves survive, so "try another size" works
    assert sweep_expired(settings.data_dir, settings, r) == 0
    assert (job_path / "input.pdf").exists()

    # past the grace window the original upload is unlinked, but the compressed
    # output stays downloadable for the rest of the completion TTL
    store.update_job(
        r, job_id, completed_at=int(time.time()) - settings.input_grace_seconds - 60
    )
    assert sweep_expired(settings.data_dir, settings, r) == 0
    assert not (job_path / "input.pdf").exists()
    assert (job_path / "output.pdf").exists()


def test_sweeper_removes_orphan_dirs(web, tmp_path):
    _, r, settings = web
    orphan = settings.data_dir / "deadbeef"
    orphan.mkdir(parents=True)
    (orphan / "input.pdf").write_bytes(b"%PDF-1.4 orphan")

    # no Redis record, so the filesystem clock applies
    assert sweep_expired(settings.data_dir, settings, r) == 0
    assert orphan.exists()

    old = time.time() - settings.pending_ttl_seconds - 60
    os.utime(orphan / "input.pdf", (old, old))
    assert sweep_expired(settings.data_dir, settings, r) == 1
    assert not orphan.exists()


def test_expires_in_restarts_at_completion(web, image_pdf):
    client, r, settings = web
    job_id = _upload(client, image_pdf).json()["job_id"]

    # an old, unfinished job is near the end of its pending window
    store.update_job(r, job_id, created_at=int(time.time()) - settings.pending_ttl_seconds + 30)
    assert client.get(f"/api/jobs/{job_id}").json()["expires_in"] <= 30

    # finishing it resets the clock to the full completion TTL
    store.mark_completed(r, job_id, settings.ttl_seconds)
    expires_in = client.get(f"/api/jobs/{job_id}").json()["expires_in"]
    assert settings.ttl_seconds - 5 <= expires_in <= settings.ttl_seconds


def test_sse_pings_a_quiet_stream(tmp_path, image_pdf, monkeypatch):
    # Shrink the clock so the test runs in about a second. ttl_seconds=1 bounds
    # the stream, so it ends on its own instead of needing a disconnect.
    monkeypatch.setattr(web_app, "EVENT_POLL_INTERVAL", 0.02)
    monkeypatch.setattr(web_app, "PING_INTERVAL", 0.2)
    settings = Settings(data_dir=tmp_path / "data", ttl_seconds=1)
    r = fakeredis.FakeRedis()
    q = Queue(settings.queue_name, connection=r, is_async=False)
    app = create_app(settings=settings, redis_conn=r, queue=q)
    with TestClient(app) as client:
        # Uploaded but never compressed: no events, so the stream is idle.
        job_id = _upload(client, image_pdf).json()["job_id"]
        with client.stream("GET", f"/api/jobs/{job_id}/events") as res:
            pings = sum(1 for line in res.iter_lines() if line == ": ping")
    # About 1s of silence at a 0.2s interval: several pings, not zero.
    assert pings >= 3


def test_health(web):
    client, _, _ = web
    assert client.get("/health").json() == {"ok": True}
    # Uptime monitors probe with HEAD; a 405 would page as an outage.
    assert client.head("/health").status_code == 200


def test_cors_for_separate_frontend(tmp_path, monkeypatch):
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://fitpdf.vercel.app, http://localhost:5173")
    settings = Settings.from_env()
    assert settings.allowed_origins == ("https://fitpdf.vercel.app", "http://localhost:5173")

    settings = Settings(
        data_dir=tmp_path / "data", allowed_origins=("https://fitpdf.vercel.app",)
    )
    r = fakeredis.FakeRedis()
    q = Queue(settings.queue_name, connection=r, is_async=False)
    app = create_app(settings=settings, redis_conn=r, queue=q)
    with TestClient(app) as client:
        res = client.get("/health", headers={"Origin": "https://fitpdf.vercel.app"})
        assert res.headers["access-control-allow-origin"] == "https://fitpdf.vercel.app"


def _limited_app(tmp_path, **overrides):
    settings = Settings(data_dir=tmp_path / "data", **overrides)
    r = fakeredis.FakeRedis()
    q = Queue(settings.queue_name, connection=r, is_async=False)
    return create_app(settings=settings, redis_conn=r, queue=q), settings


def test_upload_limit_refuses_before_storing_anything(tmp_path, photo_jpg):
    app, settings = _limited_app(tmp_path, uploads_per_hour=2)
    with TestClient(app) as client:
        ok = [_upload(client, photo_jpg, "a.jpg") for _ in range(2)]
        assert [res.status_code for res in ok] == [200, 200]
        assert ok[-1].headers["X-RateLimit-Remaining"] == "0"

        refused = _upload(client, photo_jpg, "a.jpg")
        assert refused.status_code == 429
        assert "limit of 2 files an hour" in refused.json()["detail"]
        assert int(refused.headers["Retry-After"]) > 0
        # Only the two accepted uploads made job directories.
        assert len(list(settings.data_dir.iterdir())) == 2


def test_limits_are_per_visitor(tmp_path, photo_jpg):
    app, _ = _limited_app(tmp_path, uploads_per_hour=1)
    with TestClient(app) as client:

        def upload_as(headers):
            with open(photo_jpg, "rb") as f:
                return client.post(
                    "/api/upload",
                    files={"file": ("a.jpg", f.read(), "image/jpeg")},
                    headers=headers,
                ).status_code

        assert upload_as({"CF-Connecting-IP": "203.0.113.1"}) == 200
        assert upload_as({"CF-Connecting-IP": "203.0.113.1"}) == 429
        assert upload_as({"CF-Connecting-IP": "203.0.113.2"}) == 200
        # X-Forwarded-For puts the original client first.
        assert upload_as({"X-Forwarded-For": "198.51.100.7, 10.0.0.1"}) == 200
        assert upload_as({"X-Forwarded-For": "198.51.100.7, 10.0.0.2"}) == 429
        # One IPv6 /64 is one visitor, however many addresses it rotates through.
        assert upload_as({"CF-Connecting-IP": "2001:db8:1:2::1"}) == 200
        assert upload_as({"CF-Connecting-IP": "2001:db8:1:2:ffff::9"}) == 429


def test_untrusted_headers_are_ignored(tmp_path, photo_jpg):
    # With no trusted headers every request is keyed by the socket peer, so
    # a forged header cannot buy a fresh budget.
    app, _ = _limited_app(tmp_path, uploads_per_hour=1, client_ip_headers=())
    with TestClient(app) as client:
        assert _upload(client, photo_jpg, "a.jpg").status_code == 200
        with open(photo_jpg, "rb") as f:
            res = client.post(
                "/api/upload",
                files={"file": ("a.jpg", f.read(), "image/jpeg")},
                headers={"CF-Connecting-IP": "203.0.113.99"},
            )
        assert res.status_code == 429


def test_runs_limit_covers_analyze_and_compress(tmp_path, photo_jpg):
    app, _ = _limited_app(tmp_path, runs_per_hour=2)
    with TestClient(app) as client:
        job_id = _upload(client, photo_jpg, "a.jpg").json()["job_id"]
        assert client.post(f"/api/jobs/{job_id}/analyze").status_code == 200
        target = int(photo_jpg.stat().st_size * 0.5)
        assert (
            client.post(f"/api/jobs/{job_id}/compress", json={"target_bytes": target}).status_code
            == 202
        )
        res = client.post(f"/api/jobs/{job_id}/compress", json={"target_bytes": target})
        assert res.status_code == 429
        assert "compressions an hour" in res.json()["detail"]


def test_limits_endpoint_reports_without_spending(tmp_path, photo_jpg):
    app, _ = _limited_app(tmp_path, uploads_per_hour=5)
    with TestClient(app) as client:
        assert client.get("/api/limits").json()["uploads"]["remaining"] == 5
        _upload(client, photo_jpg, "a.jpg")
        for _ in range(3):
            assert client.get("/api/limits").json()["uploads"]["remaining"] == 4


def test_limit_refusal_is_readable_cross_origin(tmp_path, photo_jpg):
    # Without CORS headers the browser hides the 429 body and the visitor sees
    # a generic network error instead of "try again in N minutes".
    app, _ = _limited_app(
        tmp_path, uploads_per_hour=1, allowed_origins=("https://fitfilesize.com",)
    )
    with TestClient(app) as client:
        origin = {"Origin": "https://fitfilesize.com"}
        with open(photo_jpg, "rb") as f:
            body = f.read()
        for expected in (200, 429):
            res = client.post(
                "/api/upload", files={"file": ("a.jpg", body, "image/jpeg")}, headers=origin
            )
            assert res.status_code == expected
            assert res.headers["access-control-allow-origin"] == "https://fitfilesize.com"


def test_zero_disables_limits(tmp_path, photo_jpg):
    app, _ = _limited_app(tmp_path, uploads_per_hour=0)
    with TestClient(app) as client:
        assert all(_upload(client, photo_jpg, "a.jpg").status_code == 200 for _ in range(3))
        assert "uploads" not in client.get("/api/limits").json()


def _simulate_restart_with_empty_disk(settings):
    """What a Render deploy does: Redis survives, the data directory does not."""
    for d in settings.data_dir.iterdir():
        web_app.remove_tree(d)


def test_restart_fails_waiting_jobs_whose_upload_vanished(web, photo_jpg):
    client, r, settings = web
    job_id = _upload(client, photo_jpg, "a.jpg").json()["job_id"]
    _simulate_restart_with_empty_disk(settings)

    assert web_app.recover_interrupted(settings.data_dir, settings, r) == 1

    state = client.get(f"/api/jobs/{job_id}").json()
    assert state["status"] == "error"
    assert state["error"] == store.RESTARTED_MESSAGE
    # The watching page is told through the same channel as any failure.
    assert store.get_events(r, job_id)[-1] == {
        "stage": "error",
        "message": store.RESTARTED_MESSAGE,
    }
    # A retry from the size picker explains itself instead of "deleted after the run".
    res = client.post(f"/api/jobs/{job_id}/compress", json={"target_bytes": 1000})
    assert res.status_code == 410
    assert res.json()["detail"] == store.RESTARTED_MESSAGE


def test_restart_fails_dead_runs_but_not_slow_ones(web, photo_jpg):
    client, r, settings = web
    dead = _upload(client, photo_jpg, "a.jpg").json()["job_id"]
    slow = _upload(client, photo_jpg, "b.jpg").json()["job_id"]
    now = int(time.time())
    quiet_too_long = now - web_app.stale_after(settings) - 5
    store.update_job(r, dead, status="compressing", progress_at=quiet_too_long)
    store.update_job(r, slow, status="compressing", progress_at=now - 30)

    assert web_app.recover_interrupted(settings.data_dir, settings, r) == 1
    assert store.get_job(r, dead)["status"] == "error"
    assert store.get_job(r, slow)["status"] == "compressing"


def test_recovery_leaves_healthy_and_finished_jobs_alone(web, photo_jpg):
    client, r, settings = web
    waiting = _upload(client, photo_jpg, "a.jpg").json()["job_id"]
    finished = _upload(client, photo_jpg, "b.jpg").json()["job_id"]
    target = int(photo_jpg.stat().st_size * 0.5)
    client.post(f"/api/jobs/{finished}/compress", json={"target_bytes": target})
    assert store.get_job(r, finished)["status"] == "done"
    # A finished job's original is deleted on schedule; that is not a restart.
    for src in (settings.data_dir / finished).glob("input.*"):
        src.unlink()

    assert web_app.recover_interrupted(settings.data_dir, settings, r) == 0
    assert store.get_job(r, waiting)["status"] == "uploaded"
    assert store.get_job(r, finished)["status"] == "done"


def test_worker_explains_a_queued_job_that_lost_its_upload(web, photo_jpg):
    # Queued before a restart, picked up after it: the job is in Redis, the
    # file is not on this server's disk.
    client, r, settings = web
    job_id = _upload(client, photo_jpg, "a.jpg").json()["job_id"]
    src = next((settings.data_dir / job_id).glob("input.*"))
    src.unlink()
    q = Queue(settings.queue_name, connection=r, is_async=False)
    q.enqueue(
        run_compress,
        job_id,
        str(src),
        str(settings.data_dir / job_id / "output"),
        1000,
        settings.ttl_seconds,
        settings.pending_ttl_seconds,
        settings.gs_timeout,
    )
    state = store.get_job(r, job_id)
    assert state["status"] == "error"
    assert state["error"] == store.RESTARTED_MESSAGE


def test_progress_is_stamped_while_a_run_is_alive(web, photo_jpg):
    client, r, _ = web
    job_id = _upload(client, photo_jpg, "a.jpg").json()["job_id"]
    target = int(photo_jpg.stat().st_size * 0.5)
    client.post(f"/api/jobs/{job_id}/compress", json={"target_bytes": target})
    assert int(store.get_job(r, job_id)["progress_at"]) >= int(time.time()) - 60
