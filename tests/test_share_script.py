from __future__ import annotations

import importlib.util
import os
import socket
from pathlib import Path


SHARE_PATH = Path(__file__).resolve().parents[1] / "backend" / "share.py"
spec = importlib.util.spec_from_file_location("chate_share_script", SHARE_PATH)
share = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(share)  # type: ignore[union-attr]


def test_share_env_allows_tunnel_hosts_without_touching_parent_env(monkeypatch):
    monkeypatch.delenv("CHATE_TRUSTED_HOSTS", raising=False)
    monkeypatch.delenv("CHATE_CORS_ORIGINS", raising=False)
    before_public_base = os.environ.get("CHATE_PUBLIC_BASE_URL")
    env = share._share_env("http://127.0.0.1:8123")
    assert env["CHATE_TRUSTED_HOSTS"] == "*"
    assert env["CHATE_CORS_ORIGINS"] == "*"
    assert env["CHATE_PUBLIC_BASE_URL"] == "http://127.0.0.1:8123"
    assert os.environ.get("CHATE_PUBLIC_BASE_URL") == before_public_base


def test_share_script_picks_a_free_fallback_port_when_preferred_is_busy():
    host = "127.0.0.1"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        sock.listen(1)
        busy_port = sock.getsockname()[1]
        assert share._port_is_free(host, busy_port) is False
        picked = share._pick_port(host, busy_port)
        assert picked != busy_port
        assert share._port_is_free(host, picked) is True


def test_cloudflared_command_uses_reliable_http2_mode_by_default():
    cmd = share._cloudflared_command("cloudflared", "http://127.0.0.1:8000", "http2", "4")
    assert cmd[:3] == ["cloudflared", "tunnel", "--no-autoupdate"]
    assert "--protocol" in cmd
    assert "http2" in cmd
    assert "--edge-ip-version" in cmd
    assert "4" in cmd
    assert cmd[-2:] == ["--url", "http://127.0.0.1:8000"]


def test_cloudflared_command_can_leave_protocol_and_ip_auto():
    cmd = share._cloudflared_command("cloudflared", "http://127.0.0.1:8000", "auto", "auto")
    assert "--protocol" not in cmd
    assert "--edge-ip-version" not in cmd
    assert cmd[-2:] == ["--url", "http://127.0.0.1:8000"]


def test_http_probe_accepts_health_json_and_rejects_1033_page():
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path == "/api/health":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"status":"ok","version":"v73"}')
            else:
                self.send_response(530)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<title>Error 1033</title>Argo Tunnel error")

        def log_message(self, *_args):
            return

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_port}"
        ok = share._http_probe(f"{base}/api/health")
        bad = share._http_probe(f"{base}/broken")
        assert ok.ok is True
        assert bad.ok is False
        assert "1033" in bad.detail
    finally:
        server.shutdown()
