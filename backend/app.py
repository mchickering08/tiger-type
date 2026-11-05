"""
Tiger Type backend.

Sits between the Chrome extension / Docs add-on and a self-hosted LanguageTool
server. Applies the admin's settings (on/off, disabled categories, custom words,
blocked sites) before anything reaches students.

Student text is never written to disk or logged.

Run locally:
    LT_URL=http://localhost:8010 ADMIN_PASSWORD=changeme uvicorn app:app --reload --port 8000
"""

import json
import os
import secrets
import threading
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, Form, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel, Field

LT_URL = os.environ.get("LT_URL", "http://localhost:8010").rstrip("/")
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
SETTINGS_PATH = Path(os.environ.get("SETTINGS_PATH", Path(__file__).parent / "settings.json"))
MAX_CHARS = int(os.environ.get("MAX_CHARS", "20000"))

# LanguageTool category IDs an admin can switch off. Labels are what the admin sees.
CATEGORIES = {
    "TYPOS": "Spelling",
    "GRAMMAR": "Grammar",
    "PUNCTUATION": "Punctuation",
    "CASING": "Capitalization",
    "CONFUSED_WORDS": "Commonly confused words",
    "REDUNDANCY": "Redundant phrases",
    "STYLE": "Style",
    "TYPOGRAPHY": "Typography",
    "SEMANTICS": "Logic and meaning",
    "COLLOCATIONS": "Word combinations",
    "MISC": "Miscellaneous",
}

DEFAULT_SETTINGS = {
    "enabled": True,
    "language": "en-US",
    "disabled_categories": ["TYPOGRAPHY"],
    "custom_words": [],
    "blocked_sites": [],
}

_lock = threading.Lock()


# ---------- settings storage ----------

def load_settings() -> dict:
    if SETTINGS_PATH.exists():
        try:
            data = json.loads(SETTINGS_PATH.read_text())
            return {**DEFAULT_SETTINGS, **data}
        except (json.JSONDecodeError, OSError):
            pass
    return dict(DEFAULT_SETTINGS)


def save_settings(data: dict) -> None:
    with _lock:
        tmp = SETTINGS_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(SETTINGS_PATH)


# ---------- app ----------

app = FastAPI(title="Tiger Type", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
security = HTTPBasic()


def get_http_client() -> httpx.AsyncClient:
    # Swapped out in tests.
    return httpx.AsyncClient(timeout=15)


def require_admin(creds: HTTPBasicCredentials = Depends(security)) -> None:
    if not ADMIN_PASSWORD:
        raise HTTPException(503, "ADMIN_PASSWORD is not set on the server.")
    ok_user = secrets.compare_digest(creds.username.encode(), ADMIN_USER.encode())
    ok_pass = secrets.compare_digest(creds.password.encode(), ADMIN_PASSWORD.encode())
    if not (ok_user and ok_pass):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Wrong username or password",
            headers={"WWW-Authenticate": "Basic"},
        )


class CheckRequest(BaseModel):
    text: str = Field(..., max_length=MAX_CHARS)


def utf16_slice(text: str, offset: int, length: int) -> str:
    """LanguageTool offsets count UTF-16 units (same as JavaScript). Python
    strings count code points, so emoji would throw plain slicing off."""
    raw = text.encode("utf-16-le")
    return raw[offset * 2:(offset + length) * 2].decode("utf-16-le", errors="ignore")


def simplify(match: dict, text: str) -> dict:
    rule = match.get("rule", {})
    category = rule.get("category", {})
    message = match.get("message", "")
    if category.get("id") == "TYPOS":
        message = "This word looks misspelled."
    return {
        "offset": match["offset"],
        "length": match["length"],
        "text": utf16_slice(text, match["offset"], match["length"]),
        "message": message,
        "short": match.get("shortMessage") or category.get("name", ""),
        "replacements": [r["value"] for r in match.get("replacements", [])[:5]],
        "category": category.get("id", "MISC"),
        "rule": rule.get("id", ""),
        "kind": "spelling" if category.get("id") == "TYPOS" else
                "style" if category.get("id") in ("STYLE", "REDUNDANCY", "TYPOGRAPHY") else
                "grammar",
    }


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/policy")
async def policy():
    """Public settings the extension needs. Nothing secret in here."""
    s = load_settings()
    return {
        "enabled": s["enabled"],
        "blocked_sites": s["blocked_sites"],
    }


@app.post("/check")
async def check(req: CheckRequest, client: httpx.AsyncClient = Depends(get_http_client)):
    s = load_settings()
    if not s["enabled"]:
        return {"enabled": False, "matches": []}
    if not req.text.strip():
        return {"enabled": True, "matches": []}

    form = {"text": req.text, "language": s["language"]}
    if s["disabled_categories"]:
        form["disabledCategories"] = ",".join(s["disabled_categories"])

    try:
        async with client:
            r = await client.post(f"{LT_URL}/v2/check", data=form)
        r.raise_for_status()
    except httpx.HTTPError:
        raise HTTPException(502, "Grammar server is unreachable.")

    custom = {w.lower() for w in s["custom_words"]}
    disabled = set(s["disabled_categories"])
    out = []
    for m in r.json().get("matches", []):
        item = simplify(m, req.text)
        if item["category"] in disabled:
            continue
        if item["category"] == "TYPOS" and item["text"].lower() in custom:
            continue
        out.append(item)
    return {"enabled": True, "matches": out}


# ---------- admin dashboard ----------

def _esc(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace('"', "&quot;"))


@app.get("/admin", response_class=HTMLResponse, dependencies=[Depends(require_admin)])
async def admin_page(saved: int = 0):
    s = load_settings()
    cats = "".join(
        f'<label class="check"><input type="checkbox" name="cat_{cid}" '
        f'{"" if cid in s["disabled_categories"] else "checked"}> {label}</label>'
        for cid, label in CATEGORIES.items()
    )
    from urllib.parse import quote
    banner = '<div class="saved">Saved.</div>' if saved else ""
    return ADMIN_HTML.format(
        logo=LOGO_SVG,
        logo_url=quote(LOGO_SVG.replace(' width="34" height="34"', "")),
        banner=banner,
        enabled_checked="checked" if s["enabled"] else "",
        status_word="on" if s["enabled"] else "off",
        cats=cats,
        words=_esc("\n".join(s["custom_words"])),
        sites=_esc("\n".join(s["blocked_sites"])),
    )


@app.post("/admin", dependencies=[Depends(require_admin)])
async def admin_save(request: Request):
    form = await request.form()

    def lines(key):
        return sorted({ln.strip() for ln in str(form.get(key, "")).splitlines() if ln.strip()})

    s = load_settings()
    s["enabled"] = form.get("enabled") == "on"
    s["disabled_categories"] = [c for c in CATEGORIES if form.get(f"cat_{c}") != "on"]
    s["custom_words"] = lines("custom_words")
    s["blocked_sites"] = [x.lower() for x in lines("blocked_sites")]
    save_settings(s)
    return RedirectResponse("/admin?saved=1", status_code=303)


ADMIN_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tiger Type Admin</title>
<link rel="icon" href="data:image/svg+xml,{logo_url}">
<style>
  :root {{ --ink:#111111; --muted:#5C5C5C; --line:#E7E5E2; --accent:#F26B1D; --bg:#F6F5F3; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:var(--ink); background:var(--bg); }}
  header {{ background:#fff; border-bottom:1px solid var(--line); }}
  .bar {{ max-width:800px; margin:0 auto; padding:14px 16px; display:flex; align-items:center; gap:12px; }}
  .brand {{ font-size:18px; font-weight:800; }} .brand span {{ font-weight:500; color:var(--muted); }}
  main {{ max-width:800px; margin:0 auto; padding:40px 16px 64px; display:flex; flex-direction:column; gap:16px; }}
  h1 {{ margin:0 0 8px; font-size:30px; font-weight:800; letter-spacing:-0.02em; }}
  section {{ background:#fff; border:1px solid var(--line); border-radius:16px; padding:22px 24px; display:flex; flex-direction:column; gap:12px; }}
  h2, .h2 {{ margin:0; font-size:17px; font-weight:800; }}
  .hint {{ margin:0; font-size:14px; color:var(--muted); }}
  .status {{ background:var(--ink); color:#fff; border:0; flex-direction:row; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:16px; }}
  .status h2 {{ font-size:18px; }} .status .hint {{ color:#C8C8C8; }} .status em {{ font-style:normal; color:var(--accent); }}
  .switch {{ position:relative; width:60px; height:34px; flex-shrink:0; }}
  .switch input {{ position:absolute; inset:0; opacity:0; margin:0; cursor:pointer; z-index:1; }}
  .switch span {{ position:absolute; inset:0; border-radius:17px; background:#5C5C5C; transition:background .15s; }}
  .switch span::after {{ content:""; position:absolute; top:4px; left:4px; width:26px; height:26px; border-radius:50%; background:#fff; transition:transform .15s; }}
  .switch input:checked + span {{ background:var(--accent); }}
  .switch input:checked + span::after {{ transform:translateX(26px); }}
  .switch input:focus-visible + span {{ outline:2px solid #fff; outline-offset:2px; }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:4px 16px; }}
  .check {{ display:flex; align-items:center; gap:10px; min-height:40px; font-size:15px; cursor:pointer; }}
  .check input {{ width:18px; height:18px; accent-color:var(--ink); }}
  .two {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px; }}
  textarea {{ width:100%; min-height:140px; padding:10px 12px; border:1px solid #D6D3CF; border-radius:10px; font:inherit; resize:vertical; }}
  .actions {{ display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:16px; margin-top:8px; }}
  .actions span {{ font-size:14px; color:var(--muted); }}
  button {{ border:0; border-radius:12px; min-height:48px; padding:12px 26px; background:var(--accent); color:var(--ink); font:inherit; font-size:16px; font-weight:800; cursor:pointer; }}
  button:hover {{ filter:brightness(.95); }}
  .saved {{ background:#fff; border:1px solid var(--line); border-radius:12px; padding:12px 16px; font-weight:600; }}
</style></head>
<body>
<header><div class="bar">{logo}<div class="brand">Tiger Type <span>Admin</span></div></div></header>
<main>
<h1>Settings</h1>
{banner}
<form method="post">
<div style="display:flex;flex-direction:column;gap:16px">
<section class="status">
  <div><h2>Tiger Type is <em>{status_word}</em> for everyone</h2>
  <p class="hint">Turn it off for the whole school.</p></div>
  <label class="switch"><input type="checkbox" name="enabled" aria-label="Tiger Type on for everyone" {enabled_checked}><span></span></label>
</section>
<section>
  <div><h2>What gets checked</h2><p class="hint">Unchecked categories are hidden from students.</p></div>
  <div class="grid">{cats}</div>
</section>
<div class="two">
<section>
  <div><label class="h2" for="dict">School dictionary</label><p class="hint">One word per line. Never flagged as misspelled.</p></div>
  <textarea id="dict" name="custom_words">{words}</textarea>
</section>
<section>
  <div><label class="h2" for="sites">Blocked sites</label><p class="hint">One domain per line. Tiger Type won't run there.</p></div>
  <textarea id="sites" name="blocked_sites">{sites}</textarea>
</section>
</div>
<div class="actions"><span>Student writing is never stored.</span><button type="submit">Save changes</button></div>
</div>
</form>
</main></body></html>"""

LOGO_SVG = (
    '<svg width="34" height="34" viewBox="0 0 100 100" aria-hidden="true">'
    '<circle cx="25" cy="27" r="12" fill="#F26B1D"/><circle cx="75" cy="27" r="12" fill="#F26B1D"/>'
    '<circle cx="25" cy="27" r="5" fill="#111"/><circle cx="75" cy="27" r="5" fill="#111"/>'
    '<rect x="12" y="22" width="76" height="66" rx="32" fill="#F26B1D"/>'
    '<path d="M43 22 Q50 37 57 22 Z" fill="#111"/><path d="M33 25 Q37 32 41 24 Z" fill="#111"/>'
    '<path d="M59 24 Q63 32 67 25 Z" fill="#111"/>'
    '<path d="M12 52 Q22 52 28 59 Q20 60 12 58 Z" fill="#111"/><path d="M88 52 Q78 52 72 59 Q80 60 88 58 Z" fill="#111"/>'
    '<circle cx="37" cy="51" r="5" fill="#111"/><circle cx="63" cy="51" r="5" fill="#111"/>'
    '<ellipse cx="50" cy="71" rx="17" ry="12" fill="#fff"/><path d="M44.5 63 L55.5 63 L50 69.5 Z" fill="#111"/>'
    '</svg>'
)
