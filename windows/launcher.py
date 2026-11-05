"""
Tiger Type Server for Windows.

What this does when you double-click it:
  1. Starts LanguageTool (the grammar engine) using the Java bundled with the installer.
  2. Starts the Tiger Type Python server on http://localhost:8000.
  3. Opens the admin page in your browser.
Closing the window stops everything.

Settings and the admin password live in %LOCALAPPDATA%\\TigerType.
To reset the password, delete admin-password.txt there and restart.
"""

import ctypes
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

APP_PORT = int(os.environ.get("TIGERTYPE_PORT", "8000"))
LT_PORT = int(os.environ.get("TIGERTYPE_LT_PORT", "8010"))
# Set TIGERTYPE_SHARE=1 to let other computers on the network use this server.
HOST = "0.0.0.0" if os.environ.get("TIGERTYPE_SHARE") == "1" else "127.0.0.1"


def app_dir() -> Path:
    # Next to the .exe when installed; next to this file when run from source.
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def data_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    d = Path(base) / "TigerType"
    d.mkdir(parents=True, exist_ok=True)
    return d


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def lt_ready() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{LT_PORT}/v2/languages", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def kill_children_with_me(proc: subprocess.Popen) -> None:
    """Put the Java process in a Windows 'job' so it dies when this window closes."""
    if os.name != "nt":
        return
    try:
        k32 = ctypes.windll.kernel32
        job = k32.CreateJobObjectW(None, None)

        class LIMIT(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", ctypes.c_uint32),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", ctypes.c_uint32),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", ctypes.c_uint32),
                ("SchedulingClass", ctypes.c_uint32),
            ]

        class IO(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class EXT(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", LIMIT),
                ("IoInfo", IO),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        info = EXT()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))
        k32.AssignProcessToJobObject(job, ctypes.c_void_p(proc._handle))
        kill_children_with_me.job = job  # keep the handle alive
    except Exception:
        pass  # worst case Java keeps running; the next launch reuses it


def start_languagetool() -> subprocess.Popen | None:
    if lt_ready():
        print("  Grammar engine already running, reusing it.")
        return None
    root = app_dir()
    java = root / "jre" / "bin" / ("java.exe" if os.name == "nt" else "java")
    jar = root / "languagetool" / "languagetool-server.jar"
    if not java.exists() or not jar.exists():
        sys.exit(f"Missing files. Expected:\n  {java}\n  {jar}\nTry reinstalling Tiger Type.")
    cmd = [
        str(java), "-Xmx1g", "-cp", str(jar), "org.languagetool.server.HTTPServer",
        "--port", str(LT_PORT),
    ]
    flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    log = open(data_dir() / "languagetool.log", "w")
    proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
    kill_children_with_me(proc)
    return proc


def get_password() -> str:
    f = data_dir() / "admin-password.txt"
    if f.exists() and f.read_text().strip():
        return f.read_text().strip()
    pw = "-".join(secrets.token_hex(2) for _ in range(3))
    f.write_text(pw)
    return pw


def main() -> None:
    os.system("title Tiger Type Server" if os.name == "nt" else "")
    print()
    print("  Tiger Type Server")
    print("  -----------------")

    if port_in_use(APP_PORT):
        print(f"  Something is already using port {APP_PORT}. Tiger Type might already be running.")
        webbrowser.open(f"http://localhost:{APP_PORT}/admin")
        sys.exit(1)

    pw = get_password()
    os.environ["LT_URL"] = f"http://127.0.0.1:{LT_PORT}"
    os.environ["ADMIN_USER"] = "admin"
    os.environ["ADMIN_PASSWORD"] = pw
    os.environ["SETTINGS_PATH"] = str(data_dir() / "settings.json")

    print("  Starting the grammar engine (takes about 20 seconds)...")
    lt = start_languagetool()
    for _ in range(120):
        if lt_ready():
            break
        if lt is not None and lt.poll() is not None:
            sys.exit(f"  The grammar engine crashed. Details: {data_dir() / 'languagetool.log'}")
        time.sleep(1)
    else:
        sys.exit("  The grammar engine didn't start in time.")

    # Import after env vars are set, since app.py reads them at import time.
    sys.path.insert(0, str(app_dir()))
    sys.path.insert(1, str(app_dir().parent / "backend"))  # when run from source
    import uvicorn
    from app import app

    admin = f"http://localhost:{APP_PORT}/admin"
    print()
    print("  Running! Keep this window open. Close it to stop Tiger Type.")
    print()
    print(f"  Admin page:  {admin}")
    print("  Username:    admin")
    print(f"  Password:    {pw}")
    print()
    print(f"  Extension server address: http://localhost:{APP_PORT}")
    print()

    if os.environ.get("TIGERTYPE_NO_BROWSER") != "1":
        threading.Timer(1.5, lambda: webbrowser.open(admin)).start()
    try:
        uvicorn.run(app, host=HOST, port=APP_PORT, log_level="warning")
    finally:
        if lt is not None:
            lt.terminate()


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if e.code not in (0, None):
            if isinstance(e.code, str):
                print(e.code)
            if os.name == "nt":
                input("\n  Press Enter to close.")
            raise SystemExit(1)
        raise
