"""Process one PDF in a child process with only stdin and stdout as inputs/outputs."""

import json
import sys

from .pdf import MAX_INPUT_BYTES, PdfError, parse_pdf


def _limit_resources():
    # Windows has no resource module. The caller's timeout and the worker's
    # input limit apply on all platforms.
    try:
        import resource
    except ImportError:
        return

    for name, ceiling in (("RLIMIT_AS", 512 * 1024 * 1024), ("RLIMIT_CPU", 20)):
        if not hasattr(resource, name):
            continue
        kind = getattr(resource, name)
        try:
            soft, hard = resource.getrlimit(kind)
            bounds = [ceiling] + [limit for limit in (soft, hard) if limit != resource.RLIM_INFINITY]
            resource.setrlimit(kind, (min(bounds), min(bounds)))
        except (OSError, ValueError):
            # Some operating systems expose a limit without implementing it.
            continue


def main():
    _limit_resources()
    try:
        if len(sys.argv) != 2:
            raise PdfError("Indique el máximo de páginas del PDF.")
        try:
            max_pages = int(sys.argv[1])
        except ValueError as error:
            raise PdfError("El límite de páginas no es válido.") from error
        data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        result = parse_pdf(data, max_pages=max_pages)
    except PdfError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True))
        return 1
    except MemoryError:
        print(json.dumps({"error": "El procesamiento del PDF superó el límite de memoria."}, ensure_ascii=True))
        return 1

    print(json.dumps(result, ensure_ascii=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
