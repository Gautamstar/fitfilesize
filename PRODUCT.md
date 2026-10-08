# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Three groups, served equally:

- **Form uploaders.** People blocked by an upload limit on a portal: Indian exam and government forms (CUET, GATE, SSC and similar), visa and immigration documents (IRCC), job portals. Many need an exact pixel size as well as a size limit (for example 200 x 230 pixels and under 50 KB). Often on a phone, close to a deadline.
- **GIF and chat users.** People fitting a GIF into a Discord emoji, profile banner or message upload limit, and wanting it to stay animated.
- **General shrinkers.** People who just need a smaller PDF or image, for email or any other upload.

The job in every case: get this file under this limit, then upload it.

## Product Purpose

FitFileSize compresses a PDF or image to fit under a size limit the visitor picks, with the best quality that fits. Success is a file that is under the limit and still looks right, downloaded and uploaded without a second attempt.

## Positioning

- **Exact limit, best quality.** The visitor picks the limit; the engine searches for the gentlest settings that fit it, rather than applying one fixed compression level. If the limit can't be reached, it returns the smallest file it could make and says so plainly.
- **Same format back.** A PNG comes back as a PNG, a PDF as a PDF, and a GIF as an animated GIF. The exceptions: HEIC is saved as JPEG, and a non-GIF image given an exact pixel size (the form presets) comes back as JPEG, because those forms require JPEG. Both are stated before Compress. The site is not a converter and never offers conversion.
- **Free, no sign-up.** No account and no paywall. Optional tips support it.

## Operating Context

- The flow on every page: drop a file, see how small it can go, pick a limit (chips for common limits, or a slider), optionally set an exact pixel size for an image, compress, watch progress, download.
- The result screen explains what was done ("How we found it") and notes crops, borders, enlargements or dropped GIF frames.
- About 55 landing pages are generated from `frontend/src/lib/landing-pages.json`. Each one presets a limit and sometimes a pixel size for a specific form or use (exam forms, IRCC, Discord, "compress GIF to 1 MB", and so on). Pages with an official source cite it with a checked date.
- The pages are pre-rendered for search engines, and an MCP server exposes the same form presets to AI tools.

## Capabilities and Constraints

- Accepts PDF, JPEG, PNG, WebP, TIFF, BMP, GIF (kept animated) and HEIC (saved as JPEG).
- For images, an exact pixel size can be set: cropped to fill, or padded with a white border (a see-through border for GIFs).
- Uploads and results are deleted minutes after the run.
- GIFs over 200 million pixels across all frames are refused.
- Frontend: React and Vite on Vercel, pre-rendered. Backend: FastAPI with an RQ worker on a VPS.

## Brand Commitments

- Name: FitFileSize. The Python package and CLI keep the original name, `fitpdf`.
- Voice: plain and factual. Messages state facts ("HEIC photos are saved as JPEG.") and make no sweeping claims or hype.
- Light and dark themes both stay, with the visitor able to switch between them.
- Keep the current look: calm, trustworthy, blue accent, plain product UI. Ten alternative visual worlds were reviewed on 2026-10-08 and the owner preferred the existing design. Improve it in place; no themed metaphors (rulers, tags, stamps, boards, forms-as-paper).

## Evidence on Hand

- Official sources (form instructions, Discord help pages) cited on the landing pages, with checked dates.
- No testimonials, customer logos, user counts or press. None may be invented.

## Product Principles

1. The limit is the visitor's, and it is met exactly or the shortfall is stated.
2. The file comes back in the format it went in.
3. Every message is a fact the visitor can check.
4. A stressed visitor on a phone gets through in one pass, without an account.
5. Each form page gives the specific facts for that form, not generic filler.
