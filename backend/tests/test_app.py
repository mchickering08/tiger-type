"""Backend tests. LanguageTool is faked so these run without Java or Docker.

    cd backend && pytest -q
"""
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def lt_match(offset, length, cat, replacements=(), msg="msg"):
    return {
        "message": msg, "shortMessage": "", "offset": offset, "length": length,
        "replacements": [{"value": r} for r in replacements],
        "rule": {"id": f"{cat}_RULE", "category": {"id": cat, "name": cat.title()}},
    }


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("SETTINGS_PATH", str(tmp_path / "settings.json"))
    monkeypatch.setenv("ADMIN_PASSWORD", "pw")
    import importlib
    import app as app_module
    importlib.reload(app_module)

    seen = {}

    def handler(request: httpx.Request):
        form = dict(httpx.QueryParams(request.content.decode()))
        seen["form"] = form
        text = form["text"]
        matches = []
        i = text.find("teh")
        if i >= 0:
            matches.append(lt_match(len(text[:i].encode("utf-16-le")) // 2, 3, "TYPOS", ["the"]))
        i = text.find("Greenwhich")
        if i >= 0:
            matches.append(lt_match(len(text[:i].encode("utf-16-le")) // 2, 10, "TYPOS", ["Greenwich"]))
        i = text.find("He go")
        if i >= 0:
            matches.append(lt_match(i, 5, "GRAMMAR", ["He goes"]))
        i = text.find("very unique")
        if i >= 0:
            matches.append(lt_match(i, 11, "STYLE", ["unique"]))
        return httpx.Response(200, json={"matches": matches})

    app_module.app.dependency_overrides[app_module.get_http_client] = (
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )
    from fastapi.testclient import TestClient
    return app_module, TestClient(app_module.app), seen


def test_basic_check(env):
    _, client, _ = env
    r = client.post("/check", json={"text": "I saw teh dog. He go home."})
    data = r.json()
    assert data["enabled"] is True
    kinds = {(m["text"], m["kind"]) for m in data["matches"]}
    assert ("teh", "spelling") in kinds
    assert ("He go", "grammar") in kinds


def test_emoji_offsets_use_utf16(env):
    _, client, _ = env
    r = client.post("/check", json={"text": "😀😀 teh"})
    m = r.json()["matches"][0]
    assert m["offset"] == 5  # two emoji = 4 UTF-16 units, plus a space
    assert m["text"] == "teh"


def test_disabled_category_hidden_and_sent_to_lt(env):
    mod, client, seen = env
    mod.save_settings({**mod.DEFAULT_SETTINGS, "disabled_categories": ["STYLE"]})
    r = client.post("/check", json={"text": "It is very unique."})
    assert r.json()["matches"] == []
    assert seen["form"]["disabledCategories"] == "STYLE"


def test_custom_words(env):
    mod, client, _ = env
    mod.save_settings({**mod.DEFAULT_SETTINGS, "custom_words": ["greenwhich"]})
    r = client.post("/check", json={"text": "Greenwhich and teh"})
    matches = r.json()["matches"]
    assert [m["text"] for m in matches] == ["teh"]
    assert matches[0]["message"] == "This word looks misspelled."


def test_global_off(env):
    mod, client, seen = env
    mod.save_settings({**mod.DEFAULT_SETTINGS, "enabled": False})
    r = client.post("/check", json={"text": "teh"})
    assert r.json() == {"enabled": False, "matches": []}
    assert "form" not in seen  # never even sent to LanguageTool


def test_text_too_long_rejected(env):
    mod, client, _ = env
    r = client.post("/check", json={"text": "a" * (mod.MAX_CHARS + 1)})
    assert r.status_code == 422


def test_admin_requires_password(env):
    _, client, _ = env
    assert client.get("/admin").status_code == 401
    assert client.get("/admin", auth=("admin", "wrong")).status_code == 401
    assert client.get("/admin", auth=("admin", "pw")).status_code == 200


def test_admin_save_and_policy(env):
    mod, client, _ = env
    r = client.post("/admin", auth=("admin", "pw"), follow_redirects=False, data={
        # enabled unchecked -> off
        "cat_TYPOS": "on", "cat_GRAMMAR": "on",
        "custom_words": "GCDS\nGreenwhich\n\nGCDS",
        "blocked_sites": "Quizlet.com\n",
    })
    assert r.status_code == 303
    s = json.loads(Path(mod.SETTINGS_PATH).read_text())
    assert s["enabled"] is False
    assert "TYPOS" not in s["disabled_categories"] and "STYLE" in s["disabled_categories"]
    assert s["custom_words"] == ["GCDS", "Greenwhich"]
    p = client.get("/policy").json()
    assert p == {"enabled": False, "blocked_sites": ["quizlet.com"]}


def test_admin_page_escapes_html(env):
    mod, client, _ = env
    mod.save_settings({**mod.DEFAULT_SETTINGS, "custom_words": ['</textarea><script>alert(1)</script>']})
    html = client.get("/admin", auth=("admin", "pw")).text
    assert "<script>alert(1)" not in html
