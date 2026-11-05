# Tiger Type

A spelling and grammar checker for GCDS, by Student Government 2026-2027. No AI: it uses LanguageTool's hand-written grammar rules, running on a server the school controls, with an admin page for on/off, categories, a school dictionary, and blocked sites.

```
student's Chrome                     one server (Windows PC or school server)
┌──────────────────┐   text    ┌──────────────────┐   text   ┌──────────────┐
│ Tiger Type       │ ────────▶ │ Tiger Type       │ ───────▶ │ LanguageTool │
│ extension        │ ◀──────── │ server + admin   │ ◀─────── │ (rules only) │
└──────────────────┘  issues   └──────────────────┘  issues  └──────────────┘
```

## Get it (Windows)

Everything is on this repo's **Releases** page, under **Tiger Type (latest build)**. GitHub rebuilds it automatically every time code is pushed.

**1. Install the server:** download `TigerTypeSetup.exe` and double-click it.
- Windows may show "Windows protected your PC," since the installer isn't signed. Click **More info**, then **Run anyway**.
- No admin rights are needed. Java and the grammar engine come bundled, so there's nothing else to install.
- When it starts, a black window opens with your admin password and the admin page opens in your browser. **Keep that window open** while you use Tiger Type. Closing it stops the server.

**2. Install the extension:** download `TigerType-Extension.zip` and unzip it.
1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick the unzipped folder
4. Type `I will recieve teh package` in any text box and wait a second

The extension talks to `http://localhost:8000` by default, which is where the installer runs the server. To point it somewhere else, right-click the Tiger Type icon, then **Options**.

**Admin login:** username `admin`. The password is shown in the server window and saved in `%LOCALAPPDATA%\TigerType\admin-password.txt`. Delete that file and restart to get a new one.

## What's in here

| Folder | What it is |
|---|---|
| `backend/` | Python server (FastAPI). Talks to LanguageTool, applies admin settings, serves the admin page at `/admin`. |
| `extension/` | Chrome extension. Underlines mistakes in text boxes with fix-it cards, plus a popup with issue counts. |
| `docs-addon/` | Google Docs add-on (for later, needs a public server). Sidebar that checks the whole doc. |
| `windows/` | The Windows launcher and installer script. |
| `.github/workflows/` | Builds the installer on GitHub's Windows machines and posts it to Releases. |
| `docker-compose.yml` | Alternative: run everything on a Linux/Mac server with Docker. |

## Admin controls

**Admin page (`http://localhost:8000/admin`):**
- Turn Tiger Type on/off for everyone
- Pick which categories get checked (spelling, grammar, punctuation, style, and more)
- School dictionary: words never flagged (names, "GCDS", local places)
- Blocked sites

**Google Admin console** (when IT rolls it out to managed Chrome browsers), in the extension's policy:
```json
{
  "serverUrl": { "Value": "https://tigertype.yourschool.org" },
  "lockSettings": { "Value": true },
  "blockedSites": { "Value": ["quizlet.com"] }
}
```

## Rolling it out to the whole school

The installer runs the server on one Windows computer, which is perfect for testing and demos. For every student to use it:

1. **The server needs to live somewhere always-on** that every student's Chrome can reach, ideally with HTTPS. IT decides this: a school server running the Windows installer or `docker compose up -d`.
   - To let other computers reach a Windows install, set the environment variable `TIGERTYPE_SHARE=1` before starting it, and allow it through Windows Firewall.
2. **Publish the extension** on the Chrome Web Store as **Private** (only GCDS Google accounts can see it). Upload `TigerType-Extension.zip`. One-time $5 developer fee.
3. **IT force-installs it** from the Google Admin console (Devices > Chrome > Apps & extensions > add by ID > Force install) and sets the policy above.
4. **Docs add-on:** at [script.google.com](https://script.google.com), make a project, paste in the files from `docs-addon/`, set the script property `TIGERTYPE_SERVER` to the server's public https address, and update `urlFetchWhitelist` in `appsscript.json`. IT can publish it privately to the school's domain.

## Privacy

- Student text goes from their browser to the Tiger Type server, then to LanguageTool on that same machine. Nothing goes to a third party.
- The server never logs or saves the text it checks. Only the admin settings are saved.

## Known limits

- **Google Docs gets a side panel, not inline underlines.** Docs draws text on a canvas that extensions can't read. In a Doc, click the Tiger Type icon, then **Check this doc**. The panel lists every issue with its paragraph. Click a suggestion to copy it.
- **Rule-based means fewer catches than Grammarly.** Good at spelling, agreement, punctuation, and commonly confused words. Weak on clarity and tone. That's the price of no AI.
- **Some fancy editors won't line up perfectly.** Fields marked `spellcheck="false"` (usually code boxes) are skipped.
- **Max 20,000 characters per check.**
- **`/check` has no login.** Fine on one computer. On a shared server, limit it to the school network.

## For developers

```bash
cd backend
pip install -r requirements.txt pytest
pytest -q                      # tests fake LanguageTool, so no Java needed
LT_URL=http://localhost:8010 ADMIN_PASSWORD=pw uvicorn app:app --reload
```
You need LanguageTool on port 8010 for real checks: `docker run -p 8010:8010 erikvl87/languagetool`.
