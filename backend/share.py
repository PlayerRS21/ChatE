"""Start ChatE locally and expose it through a temporary Cloudflare Quick Tunnel.

Usage:
    python share.py
    python share.py --port 8010
    python share.py --protocol http2 --edge-ip-version 4

Requirements:
    - Install Python requirements first.
    - Install cloudflared: sudo pacman -S --needed cloudflared

This script is intentionally defensive. Cloudflare error 1033 means the edge URL
exists but Cloudflare cannot reach a healthy origin/connector. A script that
prints the URL immediately after cloudflared mentions it is still brittle because
Quick Tunnel DNS/route propagation can lag behind connector registration. This
version waits for the local backend health check, starts cloudflared using a
firewall-friendly protocol by default, waits for connector registration, then
probes the public tunnel /api/health before announcing the URL.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path
from typing import Iterable, NamedTuple

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
HEALTH_TIMEOUT_SECONDS = 45
TUNNEL_READY_TIMEOUT_SECONDS = 90
PUBLIC_HEALTH_TIMEOUT_SECONDS = 120
TUNNEL_RE = re.compile(r"https://[-a-zA-Z0-9.]+\.trycloudflare\.com")
READY_RE = re.compile(r"(Registered tunnel connection|Connection registered|INF .*registered)", re.I)
PROPAGATING_RE = re.compile(r"Route propagating|propagat", re.I)
ORIGIN_ERROR_RE = re.compile(
    r"(unable to reach the origin|origin service.*(failed|error)|connection refused|connect: connection refused|error proxying request|bad gateway|1033)",
    re.I,
)

_running: list[subprocess.Popen[str]] = []
_stop_event = threading.Event()


class ProbeResult(NamedTuple):
    ok: bool
    detail: str


def _share_env(public_base_url: str | None = None) -> dict[str, str]:
    env = os.environ.copy()
    # Runtime-only override for Cloudflare Quick Tunnel hostnames.
    # This prevents "Invalid host header" without modifying .env.
    env["CHATE_TRUSTED_HOSTS"] = "*"
    env.setdefault("CHATE_CORS_ORIGINS", "*")
    env.setdefault("CHATE_ENV", "development")
    if public_base_url:
        env["CHATE_PUBLIC_BASE_URL"] = public_base_url.rstrip("/")
    return env


def _port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex((host, port)) != 0


def _pick_port(host: str, preferred_port: int) -> int:
    if _port_is_free(host, preferred_port):
        return preferred_port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def _stream_process(
    name: str,
    proc: subprocess.Popen[str],
    lines: deque[str],
    events: queue.Queue[tuple[str, str]],
) -> None:
    assert proc.stdout is not None
    for line in proc.stdout:
        clean = line.rstrip()
        lines.append(clean)
        print(line, end="")
        if name == "cloudflared":
            match = TUNNEL_RE.search(line)
            if match:
                events.put(("url", match.group(0)))
            if READY_RE.search(line):
                events.put(("ready", clean))
            if PROPAGATING_RE.search(line):
                events.put(("propagating", clean))
            if ORIGIN_ERROR_RE.search(line):
                events.put(("origin_error", clean))
    events.put((f"{name}_exit", str(proc.returncode)))


def _http_probe(url: str, timeout: float = 3.0) -> ProbeResult:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "ChatE-share-probe/1.0",
            "Accept": "application/json,text/plain,*/*",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(8192)
            body = raw.decode("utf-8", "replace")
            if not (200 <= response.status < 300):
                return ProbeResult(False, f"HTTP {response.status}: {body[:180]}")
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                payload = {}
            if payload.get("status") == "ok":
                return ProbeResult(True, f"HTTP {response.status}: health OK")
            if "Error 1033" in body or "Argo Tunnel error" in body:
                return ProbeResult(False, "Cloudflare 1033: tunnel route is not reaching this origin yet")
            return ProbeResult(False, f"HTTP {response.status} but health payload was unexpected: {body[:180]}")
    except urllib.error.HTTPError as exc:
        body = exc.read(4096).decode("utf-8", "replace")
        if "Error 1033" in body or "Argo Tunnel error" in body:
            return ProbeResult(False, "Cloudflare 1033: tunnel route is not reaching this origin yet")
        return ProbeResult(False, f"HTTP {exc.code}: {body[:180]}")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return ProbeResult(False, str(exc))


def _wait_for_health(local_url: str, proc: subprocess.Popen[str], timeout: int = HEALTH_TIMEOUT_SECONDS) -> bool:
    deadline = time.monotonic() + timeout
    health_url = f"{local_url}/api/health"
    last_error = ""
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            print(f"ChatE server exited early with code {proc.returncode}.", file=sys.stderr)
            return False
        result = _http_probe(health_url, timeout=1.5)
        if result.ok:
            return True
        last_error = result.detail
        time.sleep(0.5)
    print(f"ChatE server did not become healthy at {health_url}: {last_error}", file=sys.stderr)
    return False


def _wait_for_tunnel_metadata(
    proc: subprocess.Popen[str],
    events: queue.Queue[tuple[str, str]],
    timeout: int = TUNNEL_READY_TIMEOUT_SECONDS,
) -> tuple[str | None, bool, bool]:
    tunnel_url: str | None = None
    connector_ready = False
    origin_error = False
    route_propagating = False
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return tunnel_url, connector_ready, True
        try:
            event, payload = events.get(timeout=0.5)
        except queue.Empty:
            continue
        if event == "url":
            tunnel_url = payload.rstrip("/")
        elif event == "ready":
            connector_ready = True
        elif event == "origin_error":
            origin_error = True
        elif event == "propagating":
            route_propagating = True
            print("Cloudflare route is still propagating; waiting for real public health check...")
        if tunnel_url and connector_ready and not route_propagating:
            # Continue to the public health probe. We do not print the URL here;
            # connector registration is not enough to prove the URL works.
            return tunnel_url, connector_ready, origin_error
        if tunnel_url and connector_ready and route_propagating:
            # Route propagation logs are informational. Give Cloudflare a moment,
            # then allow the public probe to become the source of truth.
            time.sleep(2)
            return tunnel_url, connector_ready, origin_error
    return tunnel_url, connector_ready, origin_error


def _wait_for_public_health(tunnel_url: str, proc: subprocess.Popen[str], timeout: int = PUBLIC_HEALTH_TIMEOUT_SECONDS) -> ProbeResult:
    health_url = f"{tunnel_url}/api/health"
    deadline = time.monotonic() + timeout
    last = ProbeResult(False, "not checked yet")
    consecutive_ok = 0
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return ProbeResult(False, f"cloudflared exited with code {proc.returncode}")
        last = _http_probe(health_url, timeout=5.0)
        if last.ok:
            consecutive_ok += 1
            if consecutive_ok >= 2:
                return ProbeResult(True, f"public health OK: {health_url}")
        else:
            consecutive_ok = 0
            print(f"Public tunnel not ready yet: {last.detail}")
        time.sleep(2.0)
    return ProbeResult(False, f"public health never became ready at {health_url}; last error: {last.detail}")


def _terminate_processes(processes: Iterable[subprocess.Popen[str]]) -> None:
    for proc in processes:
        if proc.poll() is None:
            proc.terminate()
    time.sleep(0.8)
    for proc in processes:
        if proc.poll() is None:
            proc.kill()


def _print_cloudflared_help(last_lines: deque[str], local_url: str, last_probe: str | None = None) -> None:
    print("\nCloudflare tunnel failed or never became publicly reachable.", file=sys.stderr)
    print("This is the exact situation that commonly shows Cloudflare Error 1033 or 'site can't be reached'.", file=sys.stderr)
    print("Fix checklist:", file=sys.stderr)
    print(f"  1. Confirm local app works: open {local_url}/api/health", file=sys.stderr)
    print("  2. Update cloudflared: sudo pacman -Syu cloudflared", file=sys.stderr)
    print("  3. Restart share.py and use the newly printed URL only.", file=sys.stderr)
    print("  4. Do not reuse an old trycloudflare.com URL after stopping the script.", file=sys.stderr)
    print("  5. If your network blocks QUIC/UDP, keep the default --protocol http2 or run with --edge-ip-version 4.", file=sys.stderr)
    if last_probe:
        print(f"\nLast public probe: {last_probe}", file=sys.stderr)
    if last_lines:
        print("\nLast cloudflared lines:", file=sys.stderr)
        for line in list(last_lines)[-12:]:
            print(f"  {line}", file=sys.stderr)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run ChatE and expose it through Cloudflare Quick Tunnel.")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Local bind host. Default: 127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Preferred local port. Default: 8000")
    parser.add_argument(
        "--strict-port",
        action="store_true",
        help="Fail instead of choosing another free port when the requested port is busy.",
    )
    parser.add_argument(
        "--protocol",
        choices=("http2", "quic", "auto"),
        default="http2",
        help="cloudflared edge protocol. Default: http2 because it survives more home/mobile networks than QUIC.",
    )
    parser.add_argument(
        "--edge-ip-version",
        choices=("auto", "4", "6"),
        default="auto",
        help="cloudflared edge IP version. Use 4 if your ISP/router has broken IPv6.",
    )
    parser.add_argument(
        "--tunnel-retries",
        type=int,
        default=3,
        help="How many fresh Quick Tunnel attempts to try before failing. Default: 3.",
    )
    parser.add_argument(
        "--public-timeout",
        type=int,
        default=PUBLIC_HEALTH_TIMEOUT_SECONDS,
        help="Seconds to wait for the public trycloudflare URL to pass /api/health. Default: 120.",
    )
    return parser.parse_args()


def _cloudflared_command(cloudflared: str, local_url: str, protocol: str, edge_ip_version: str) -> list[str]:
    command = [cloudflared, "tunnel", "--no-autoupdate"]
    if protocol != "auto":
        command += ["--protocol", protocol]
    if edge_ip_version != "auto":
        command += ["--edge-ip-version", edge_ip_version]
    command += ["--url", local_url]
    return command


def main() -> int:
    args = _parse_args()
    cloudflared = shutil.which("cloudflared")
    if not cloudflared:
        print("cloudflared is not installed.", file=sys.stderr)
        print("On Arch Linux, run: sudo pacman -S --needed cloudflared", file=sys.stderr)
        print("Then run this again: python share.py", file=sys.stderr)
        return 1

    backend_dir = Path(__file__).resolve().parent
    port = int(args.port)
    if not _port_is_free(args.host, port):
        if args.strict_port:
            print(f"Port {port} is already in use. Stop the old server or pick --port.", file=sys.stderr)
            return 1
        new_port = _pick_port(args.host, port)
        print(f"Port {port} is busy; using free port {new_port} instead.")
        port = new_port

    local_url = f"http://{args.host}:{port}"
    env = _share_env(local_url)

    print(f"Starting ChatE on {local_url} ...")
    print("Share mode: allowing Cloudflare tunnel hostnames for this run only.")
    uvicorn_lines: deque[str] = deque(maxlen=80)
    events: queue.Queue[tuple[str, str]] = queue.Queue()
    uvicorn_proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            args.host,
            "--port",
            str(port),
            "--proxy-headers",
            "--forwarded-allow-ips",
            "*",
        ],
        cwd=backend_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    _running.append(uvicorn_proc)
    threading.Thread(target=_stream_process, args=("uvicorn", uvicorn_proc, uvicorn_lines, events), daemon=True).start()

    def stop(*_: object) -> None:
        _stop_event.set()
        _terminate_processes(_running)

    signal.signal(signal.SIGINT, lambda *_: (stop(), sys.exit(0)))
    signal.signal(signal.SIGTERM, lambda *_: (stop(), sys.exit(0)))

    if not _wait_for_health(local_url, uvicorn_proc):
        print("\nLast Uvicorn lines:", file=sys.stderr)
        for line in list(uvicorn_lines)[-12:]:
            print(f"  {line}", file=sys.stderr)
        stop()
        return uvicorn_proc.returncode or 1

    print(f"ChatE local health OK: {local_url}/api/health")
    print("Starting Cloudflare Quick Tunnel...")
    print("Do not share an old tunnel URL. Use only the fresh URL printed by this run.")

    last_probe_detail: str | None = None
    tunnel_proc: subprocess.Popen[str] | None = None
    tunnel_lines: deque[str] = deque(maxlen=160)
    for attempt in range(1, max(1, int(args.tunnel_retries)) + 1):
        print(f"\nCloudflare tunnel attempt {attempt}/{max(1, int(args.tunnel_retries))}...")
        tunnel_lines.clear()
        tunnel_events: queue.Queue[tuple[str, str]] = queue.Queue()
        tunnel_proc = subprocess.Popen(
            _cloudflared_command(cloudflared, local_url, args.protocol, args.edge_ip_version),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
        )
        _running.append(tunnel_proc)
        threading.Thread(target=_stream_process, args=("cloudflared", tunnel_proc, tunnel_lines, tunnel_events), daemon=True).start()

        tunnel_url, connector_ready, origin_error = _wait_for_tunnel_metadata(tunnel_proc, tunnel_events)
        if not tunnel_url or not connector_ready or origin_error:
            last_probe_detail = "cloudflared did not produce a stable URL/registered connector"
            _print_cloudflared_help(tunnel_lines, local_url, last_probe_detail)
            if tunnel_proc.poll() is None:
                tunnel_proc.terminate()
                time.sleep(1)
            continue

        print(f"Fresh tunnel URL detected: {tunnel_url}")
        print("Verifying the public URL before showing it as usable...")
        probe = _wait_for_public_health(tunnel_url, tunnel_proc, timeout=max(15, int(args.public_timeout)))
        last_probe_detail = probe.detail
        if probe.ok:
            print("\nChatE tunnel is ready and publicly reachable:")
            print(f"  {tunnel_url}")
            print("\nKeep this terminal open. Closing it destroys the tunnel.")
            print("If your browser later shows 1033, the tunnel died; restart share.py and use the new URL.\n")
            try:
                return tunnel_proc.wait()
            finally:
                stop()

        print(f"Tunnel attempt {attempt} failed public health check: {probe.detail}", file=sys.stderr)
        if tunnel_proc.poll() is None:
            tunnel_proc.terminate()
            time.sleep(1.2)
            if tunnel_proc.poll() is None:
                tunnel_proc.kill()

    _print_cloudflared_help(tunnel_lines, local_url, last_probe_detail)
    stop()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
