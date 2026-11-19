# Chrome Web Store listing

Paste from here into the developer dashboard. Upload `dist/fitfilesize-extension-<version>.zip` (build it with `npm run pack` in `extension/`). The same zip and text work for Edge Add-ons.

## Store listing tab

**Name** (comes from the zip): FitFileSize: Resize Photo and PDF to KB Limit

**Summary** (comes from the zip, 132 characters max): When an upload form states a limit like "20 KB to 50 KB" and your file breaks it, offers to fit it in one click.

**Category:** Productivity, then Tools (or the closest "Tools" category the dashboard offers)

**Language:** English

**Description:**

```
Application forms often say "Photograph: 20 KB to 50 KB, 200 x 230 pixels" or "PDF, max 100 KB", and your photo straight from the phone is 3 MB. FitFileSize fixes that inside the form.

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
On government, exam and university sites (gov.in, nic.in, ac.in, IBPS, SBI, TCS iON). Turn on "Also on all other sites" from the toolbar button to have it check forms everywhere.

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

**Small promo tile** (440x280): `promo-tile-440x280.png`

**Homepage URL:** https://fitfilesize.com

**Support URL:** https://github.com/Gautamstar/fitfilesize/issues

## Privacy practices tab

**Single purpose:**

```
Fit a file chosen in a web form's upload box to the file size (and, when stated, the exact pixel size) that the form states next to the box.
```

**Permission justifications:**

- `storage`:
  ```
  Saves one setting: whether the extension checks the files the user picks.
  ```
- `scripting`:
  ```
  Used only when the user turns on "Also on all other sites": it registers the same file checker on other sites after the user grants that permission, and removes it when the permission is withdrawn.
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
  Requested only if the user turns on "Also on all other sites" in the popup, so the same check works on forms on any site. Off by default.
  ```

**Remote code:** No, I am not using remote code.

**Data usage:** tick **Personally identifiable information** (a photo, signature or certificate the user chooses to fit can contain it). Leave every other type unticked: the page text is read only in the browser and never collected.

Then tick all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://fitfilesize.com/privacy.html

## Test instructions (for the reviewer)

```
No account is needed. After installing, a welcome page opens with a demo upload field ("JPG only, 200 x 230 pixels, size 20 KB to 50 KB"). Click "Use a sample photo": a box appears at the bottom right saying the file breaks the limit. Click "Fit it"; within a few seconds the field holds a 200 x 230 pixel JPEG of about 21 KB. The toolbar button's popup has "Fit a file by hand", which opens a page where any file can be fitted to a typed limit.
```

## Distribution tab

- **Visibility:** Public
- **Regions:** All regions
- **Pricing:** Free
