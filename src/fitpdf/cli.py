import argparse
import sys
from pathlib import Path

import pikepdf

from .engine import compress_to_target, lossless_pass
from .gs import GhostscriptError
from .units import human_size, parse_size


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="fitpdf", description="Compress a PDF to fit under a target file size."
    )
    parser.add_argument("input", help="input PDF")
    parser.add_argument(
        "-t", "--target", help='target size, e.g. "4mb" or "500kb" (omit for lossless-only)'
    )
    parser.add_argument("-o", "--output", help="output path (default: <input>.fit.pdf)")
    parser.add_argument(
        "--keep-metadata", action="store_true", help="keep XMP metadata and document info"
    )
    parser.add_argument("--timeout", type=int, default=120, help="per-attempt timeout in seconds")
    args = parser.parse_args(argv)

    src = Path(args.input)
    if not src.is_file():
        print(f"error: no such file: {src}", file=sys.stderr)
        return 1
    dst = Path(args.output) if args.output else src.with_name(src.stem + ".fit.pdf")

    try:
        if args.target is None:
            original = src.stat().st_size
            final = lossless_pass(src, dst, strip_metadata=not args.keep_metadata)
            pct = 100.0 * (1 - final / original) if original else 0.0
            print(f"{human_size(original)} -> {human_size(final)}  ({pct:.0f}% smaller, lossless)")
            print(f"wrote {dst}")
            return 0

        target = parse_size(args.target)
        result = compress_to_target(
            src, dst, target, timeout=args.timeout, strip_metadata=not args.keep_metadata
        )
    except pikepdf.PasswordError:
        print("error: this PDF is encrypted; decrypt it first", file=sys.stderr)
        return 1
    except (GhostscriptError, ValueError, pikepdf.PdfError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    status = "under target" if result.hit_target else "TARGET NOT REACHED (floor)"
    print(
        f"{human_size(result.original_bytes)} -> {human_size(result.final_bytes)}  "
        f"({result.saved_pct:.0f}% smaller, target {human_size(result.target_bytes)}: {status})"
    )
    print(f"method: {result.method}, attempts: {result.rungs_tried}")
    for w in result.warnings:
        print(f"note: {w}")
    print(f"wrote {result.output}")
    return 0 if result.hit_target else 2


if __name__ == "__main__":
    sys.exit(main())
