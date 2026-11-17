# Tiger Type: Chrome Web Store listing kit

Everything the Chrome Web Store asks for, ready to paste. Files are in this folder.

## Before you start (one-time)

1. **Give the school a heads-up.** The listing names GCDS, so check with IT or your advisor before it goes live.
2. **Turn on the privacy policy page.** On GitHub, go to the tiger-type repo → **Settings** → **Pages**. Under "Build and deployment," set Source to **Deploy from a branch**, Branch to **main**, folder to **/docs**, then click **Save**. After a minute, this should load:
   `https://mchickering08.github.io/tiger-type/privacy.html`
   (If your GitHub Pages uses a custom domain, GitHub redirects to it. Use whatever address the Pages screen shows.)
3. **Make a developer account** at https://chrome.google.com/webstore/devconsole. There's a one-time registration fee. Google suggests a dedicated email you check often, since it can't be changed later. The account owner has to agree to Google's developer terms and pay the fee. If that can't be you, an adult (advisor or parent) can own the account.

## Upload

Dashboard → **New item** → upload **TigerType-Extension-v1.0.0.zip**.

## Store listing tab

**Description** (the short summary comes from the extension itself: "Spelling and grammar checking for GCDS students, by Mary Chickering. Rule-based, no AI.")

```
Tiger Type is a spelling and grammar checker made by Mary Chickering for Greenwich Country Day School students.

It underlines mistakes as you type in almost any text box: email, discussion posts, forms, and more. Hover over an underline to see what's wrong, and click a suggestion to fix it.

• Orange: spelling
• Blue: grammar
• Gray, dotted: style

NO AI
Tiger Type uses LanguageTool's open-source, hand-written grammar rules. It points out mistakes. It never writes or rewrites anything for you.

YOUR WRITING STAYS PRIVATE
Text is checked by a Tiger Type server run by your school, then forgotten. Nothing is stored, sold, or shared, and there are no ads or tracking.

GOOGLE DOCS
In a Google Doc, click the Tiger Type icon and choose "Check this doc" to see every issue in a side panel. With the Tiger Type Docs add-on, it checks while you write, highlights mistakes, and fixes them in one click.

FOR SCHOOLS
Admins can turn Tiger Type off for everyone, choose which kinds of mistakes are checked, add school words like names and places to a dictionary, and block sites. IT can set the server address and lock settings through the Google Admin console.

Tiger Type needs a Tiger Type server to check writing. Your school's IT team sets this up.

By Mary Chickering
```

**Category:** Education
**Language:** English (United States)
**Store icon:** `store-icon-128.png`
**Screenshots** (1280x800, upload in order):
1. `1-typing.png`
2. `2-docs.png`
3. `3-popup.png`
4. `4-admin.png`

**Small promo tile** (440x280): `promo-small.png`
**Marquee promo tile** (1400x560, optional): `promo-marquee.png`
**Homepage URL:** `https://mchickering08.github.io/tiger-type/`
**Support URL:** `https://github.com/mchickering08/tiger-type/issues`

## Privacy tab

**Single purpose description:**
```
Tiger Type checks the spelling and grammar of text the user writes on web pages and in Google Docs, and lets them apply corrections.
```

**Permission justifications:**

- **storage**
  ```
  Saves the user's settings (the Tiger Type server address and the sites where they turned checking off) and reads settings set by school IT through managed storage. Also keeps per-tab issue counts in session storage for the popup.
  ```
- **sidePanel**
  ```
  Shows the "Check this doc" panel for Google Docs, which lists spelling and grammar issues in the open document. Docs doesn't allow underlines inside the page, so the side panel is how issues are shown there.
  ```
- **Host permission (all sites)**
  ```
  Students write in text boxes on many different sites (email, learning management systems, forms, discussion boards), so the content script has to run on any site to find the text box being typed in and draw underlines over it. Host access is also needed to send text to the school's Tiger Type server, whose address is set by the school, and to download the open Google Doc as plain text when the user clicks "Check this doc." Schools and users can turn Tiger Type off on specific sites.
  ```

**Are you using remote code?** No.

**Data usage:** Check **Website content** only. That covers the text the user types and the Google Doc text when they ask for a check. Don't check anything else.

Check all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** `https://mchickering08.github.io/tiger-type/privacy.html`

## Distribution tab

- **Payments:** Free
- **Visibility:** **Unlisted** (recommended for now). Only people with the link can install it, and IT can still force-install it by ID. If IT publishes it from the school's account instead, they can choose **Private** for the GCDS domain.
- **Regions:** All regions

## Notes for the reviewer

If the dashboard has a test instructions / notes for reviewers box, paste this:

```
Tiger Type sends text to a spelling and grammar server that the school hosts (open source: https://github.com/mchickering08/tiger-type). Without a server, the popup shows "OFFLINE" and text boxes show a gray "!" badge. That's expected.

To test with a server:
1. Download TigerTypeSetup.exe (Windows) from https://github.com/mchickering08/tiger-type/releases/tag/latest and run it. It installs and starts a local server at http://localhost:8000, the extension's default address. Or on Mac/Linux, clone the repo and run "ADMIN_PASSWORD=test docker compose up -d".
2. Type "I will recieve teh package. He go home." in any text box and wait a second. Mistakes are underlined. Hover an underline and click a suggestion to fix it.
3. Admin page: http://localhost:8000/admin (username admin, password shown in the server window).
```

## After it's approved

1. Copy the **extension ID** from the dashboard (32 letters, like `abcdefghijklmnopabcdefghijklmnop`).
2. Send it to GCDS IT so they can force-install it and set the server address in the Google Admin console (policy JSON is in the README).
3. Submit Google's Docs form with the ID:
   https://docs.google.com/forms/d/e/1FAIpQLScFxMgvXlq2KMsp0UIM66pvThTF1hpojiXQTqyq9txW79OWag/viewform
