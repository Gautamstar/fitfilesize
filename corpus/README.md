# Test corpus

Drop real-world PDFs here for manual testing. Everything in this folder except this
file is gitignored, so bank statements and scans never end up in the repo.

Aim for variety:

- phone-camera scans (image-heavy, big wins)
- born-digital text PDFs (small floors, honest "can't shrink" cases)
- PDFs with form fields (AcroForm warning path)
- one already-compressed file (should report a floor quickly)
- one very large file (timeout behavior)

Run against the whole corpus:

```
for f in corpus/*.pdf; do fitpdf "$f" -t 4mb; done
```
