"""Bundle the exact pure-Python dependencies used by the local converter."""
import hashlib
import io
import shutil
import sys
import tomllib
from pathlib import Path, PurePosixPath
from urllib.request import urlopen
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = (
    "pyodide.mjs",
    "pyodide.asm.mjs",
    "pyodide.asm.wasm",
    "pyodide-lock.json",
    "python_stdlib.zip",
)
LIBRARIES = ("pypdf", "openpyxl", "et-xmlfile")


def locked_wheel(package):
    wheel = next(
        entry for entry in package["wheels"] if entry["url"].endswith("-none-any.whl")
    )
    with urlopen(wheel["url"], timeout=30) as response:
        data = response.read(8 * 1024 * 1024 + 1)
    maximum = 8 * 1024 * 1024
    if len(data) > maximum or "sha256:" + hashlib.sha256(data).hexdigest() != wheel["hash"]:
        raise ValueError("El hash o el tamaño de la dependencia no coincide con uv.lock.")
    return ZipFile(io.BytesIO(data))


def build(output):
    lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    packages = {package["name"]: package for package in lock["package"]}
    runtime = ROOT / "web" / "node_modules" / "pyodide"
    output.mkdir(parents=True, exist_ok=True)
    for filename in RUNTIME:
        shutil.copyfile(runtime / filename, output / filename)

    with ZipFile(output / "conversor.zip", mode="w", compression=ZIP_DEFLATED) as bundle:
        for name in ("__init__.py", "pdf.py", "export.py"):
            bundle.write(ROOT / "conversor" / name, "conversor/" + name)
        for library in LIBRARIES:
            with locked_wheel(packages[library]) as wheel:
                for member in wheel.infolist():
                    path = PurePosixPath(member.filename)
                    if not member.is_dir() and not path.is_absolute() and ".." not in path.parts:
                        bundle.writestr(member.filename, wheel.read(member))


if __name__ == "__main__":
    build(Path(sys.argv[1]))
