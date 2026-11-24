# Chrome Web Store listing

Paste from here into the developer dashboard. Upload `dist/fitfilesize-extension-<version>.zip` (build it with `npm run pack` in `extension/`). The same zip and text work for Edge Add-ons.

## Store listing tab

**Name** (comes from the zip): FitFileSize: Resize Photo and PDF to KB Limit

**Summary** (comes from the zip, 132 characters max): When an upload form states a limit like "20 KB to 50 KB" and your file breaks it, offers to fit it in one click.

**Category:** Productivity, then Tools (or the closest "Tools" category the dashboard offers)

**Language:** English

**Description:**

```
Fits your photo or PDF to the limit the form itself states, right inside the upload box. No separate tool, no download, no second upload.

Application forms, job sites and visa portals often say "Photograph: 20 KB to 50 KB, 200 x 230 pixels" or "CV (PDF), max 2 MB", and your photo straight from the phone is 3 MB. FitFileSize reads that limit from the form and fits your file to it.

Your file is sent to fitfilesize.com only when you click "Fit it", and is deleted from the server as soon as the fitted file is back.

How it works
1. Pick a file in an upload box, as usual.
2. If the text next to the box states a limit and your file breaks it, a small box says so: "This file is 563 KB. The form asks for 20 KB to 50 KB, 200 x 230 pixels." with a "Fit it" button.
3. Click "Fit it". A few seconds later the fitted file is in the upload box in place of yours. Submit the form as usual.

Nothing is sent until you click "Fit it". If the file cannot get that small, you are told how small it can get, and your file stays as it was.

What it handles
- Photos (JPG, PNG, WebP, GIF, HEIC) and PDFs, up to 30 MB
- Size ranges ("20 KB to 50 KB", "10-20 kb"), maximums ("max 2 MB", "should not exceed 500 KB") and minimums
- Exact pixel sizes ("200 x 230 pixels")
- Keeps the format: a PNG stays a PNG unless the form asks for JPG. HEIC photos are saved as JPEG.

Where it checks
On any site you turn on: click the toolbar button while on the site and turn on "Check forms on this site". Government, exam and university websites are checked from the start, and "Also on all other sites" turns it on everywhere.

For a drag-and-drop box, or a limit written somewhere else on the page, use "Fit a file by hand" from the toolbar button: type the limit, then download the fitted file.

Your files
Files are fitted on fitfilesize.com's server and deleted as soon as the fitted file is back. No account, no sign-up. Privacy policy: https://fitfilesize.com/privacy.html

Free to use.
```

**Screenshots** (1280x800, in this order):
1. `1-prompt.png`: the offer on an upload form
2. `2-done.png`: the fitted photo in the form
3. `3-by-hand.png`: fitting a file by hand
4. `4-welcome.png`: the welcome page
5. `5-popup.png`: the toolbar popup (on/off, this site, all sites, fitting by hand)

**Store icon** (128x128, 96x96 artwork with transparent padding): `store-icon-128.png`

**Small promo tile** (440x280): `promo-tile-440x280.png`

**Marquee promo image** (1400x560, optional; used only if Google features the extension): `marquee-1400x560.png`

**Homepage URL:** https://fitfilesize.com

**Support URL:** https://github.com/Gautamstar/fitfilesize/issues

## Privacy practices tab

**Single purpose:**

```
Fit a file chosen in a web form's upload box to the file size (and, when stated, the exact pixel size) that the form states next to the box.
```

**Permission justifications:**

The dashboard has one **Host permission justification** box for all of them (the API, the content script sites and the optional all-sites permission). Paste this there:

```
api.fitfilesize.com is the extension's own server, which fits the file. A file is sent there only when the user clicks "Fit it", and is deleted as soon as the fitted file is back.

The content script runs on gov.in, nic.in, ac.in, edu.in, ibps.in, digialm.com, sbi.co.in and bank.sbi: the government, exam, bank and university sites whose application forms state upload size limits. When the user picks a file, it reads the text next to that upload box to find the stated limit. It reads nothing else and sends nothing about the page anywhere.

Other sites are optional and off by default (optional host permission <all_urls>). The popup requests one site at a time when the user turns on "Check forms on this site", or every site when the user turns on "Also on all other sites". activeTab lets the popup read the current tab's address, only when the user opens it, to offer that one site.
```

The separate texts below say the same thing per permission:

- `storage`:
  ```
  Saves one setting: whether the extension checks the files the user picks.
  ```
- `scripting`:
  ```
  Used only for sites the user turns on from the popup: it registers the same file checker on those sites after the user grants the permission (and adds it to pages already open there), and removes it when the permission is withdrawn.
  ```
- `activeTab`:
  ```
  When the user opens the popup, it reads the current tab's address to offer "Check forms on this site" for that one site. Nothing is read until the popup is opened.
  ```
- Host permission `https://api.fitfilesize.com/*`:
  ```
  The extension's own server, which fits the file. A file is sent there only when the user clicks "Fit it", and is deleted as soon as the fitted file is back.
  ```
- Content scripts on gov.in, nic.in, ac.in, edu.in, ibps.in, digialm.com, sbi.co.in, bank.sbi:
  ```
  These are the government, exam, bank and university sites whose application forms state upload size limits. The script reads the text next to an upload box when the user picks a file, to find a stated limit. It reads nothing else and sends nothing about the page anywhere.
  ```
- Optional host permission `<all_urls>`:
  ```
  Requested one site at a time when the user turns on "Check forms on this site" in the popup, or for every site when the user turns on "Also on all other sites". Off by default.
  ```

**Remote code** (if the form asks): No, I am not using remote code.

**Data usage:** Google asks for anything the extension handles, even in the browser only or briefly, so tick:
- **Personally identifiable information**: a photo, signature or certificate the user chooses to fit can show their face, name or ID numbers, and it is sent to the server.
- **Location**: the server keeps the visitor's IP address for up to an hour to count the hourly limit (the privacy policy says so).
- **Website content**: the extension reads the text next to an upload box (in the browser only), and the file itself is an image or document.

Leave the rest unticked: it records no browsing history, clicks or keystrokes, and handles no health, payment, password or message data.

Then tick all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://fitfilesize.com/privacy.html

## Test instructions (for the reviewer)

```
No account is needed. After installing, a welcome page opens with a demo upload field (JPG, 200 x 230 pixels, 20 KB to 50 KB). Click "Use a sample photo", then "Fit it" in the box at the bottom right: the field then holds a 200 x 230 JPEG of about 21 KB. On any other site, open the toolbar popup and turn on "Check forms on this site" (Chrome asks for that site only). The popup's "Fit a file by hand" fits any file to a typed limit.
```

## Distribution tab

- **Visibility:** Public
- **Regions:** All regions
- **Pricing:** Free
