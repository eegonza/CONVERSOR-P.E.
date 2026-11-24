import { loadPyodide } from "../runtime/pyodide.mjs";

const runtime = new URL("../runtime/", import.meta.url);

self.addEventListener("message", async ({ data }) => {
  if (!data || !["extract", "xlsx"].includes(data.action)) return;
  const extraction = data.action === "extract";
  try {
    self.postMessage({ stage: "loading" });
    const [python, modules] = await Promise.all([
      loadPyodide({ indexURL: runtime.href }),
      fetch(new URL("conversor.zip", runtime)).then((response) => {
        if (!response.ok) throw new Error("No se pudieron cargar las herramientas del conversor.");
        return response.arrayBuffer();
      }),
    ]);
    python.FS.writeFile("/conversor.zip", new Uint8Array(modules));
    python.runPython(`
import sys
sys.path.insert(0, "/conversor.zip")
`);
    self.postMessage({ stage: extraction ? "reading" : "writing" });
    if (extraction) {
      python.FS.writeFile("/documento.pdf", new Uint8Array(data.payload));
      const result = python.runPython(`
import json
from conversor.pdf import PdfError, parse_pdf
try:
    with open("/documento.pdf", "rb") as source:
        result = {"value": parse_pdf(source.read())}
except PdfError as error:
    result = {"error": str(error)}
json.dumps(result, ensure_ascii=False)
`);
      self.postMessage(JSON.parse(result));
    } else {
      python.FS.writeFile("/aprobado.json", new TextEncoder().encode(JSON.stringify(data.payload)));
      const error = python.runPython(`
import json
from conversor.export import ReviewError, write_excel
message = None
try:
    with open("/aprobado.json", encoding="utf-8") as source:
        workbook = write_excel(json.load(source))
    with open("/salida.xlsx", "wb") as output:
        output.write(workbook)
except ReviewError as error:
    message = str(error)
message
`);
      if (error) self.postMessage({ error });
      else {
        const bytes = python.FS.readFile("/salida.xlsx").slice().buffer;
        self.postMessage({ value: bytes }, [bytes]);
      }
    }
  } catch {
    self.postMessage({ error: extraction
      ? "No se pudo iniciar el lector o interpretar el PDF en este navegador."
      : "No se pudo generar el archivo Excel en este navegador." });
  }
}, { once: true });
