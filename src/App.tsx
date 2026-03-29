import { useState } from "react";
import {
  Brain,
  FileText,
  FolderOpen,
  LoaderCircle,
  MessageSquare,
  ScanSearch,
  ShieldCheck,
} from "lucide-react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import * as mammoth from "mammoth/mammoth.browser";
import {
  LLMFramework,
  ModelCategory,
  ModelManager,
  RunAnywhere,
  SDKEnvironment,
  type CompactModelDef,
} from "@runanywhere/web";
import { LlamaCPP, TextGeneration } from "@runanywhere/web-llamacpp";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type DocKind = "pdf" | "docx";
type ScanState = "queued" | "scanning" | "done" | "failed";

type IndexedDoc = {
  id: string;
  name: string;
  path: string;
  kind: DocKind;
  handle: FileSystemFileHandle;
  size: number;
  scanState: ScanState;
  text: string;
  error?: string;
};

const MODEL_ID = "lfm2-350m-q4_k_m";

const MODELS: CompactModelDef[] = [
  {
    id: MODEL_ID,
    name: "LFM2 350M Q4_K_M",
    repo: "LiquidAI/LFM2-350M-GGUF",
    files: ["LFM2-350M-Q4_K_M.gguf"],
    framework: LLMFramework.LlamaCpp,
    modality: ModelCategory.Language,
    memoryRequirement: 250_000_000,
  },
];

let sdkInitPromise: Promise<void> | null = null;
let modelLoadPromise: Promise<void> | null = null;

async function ensureSdk() {
  if (sdkInitPromise) {
    return sdkInitPromise;
  }

  sdkInitPromise = (async () => {
    await RunAnywhere.initialize({
      environment: SDKEnvironment.Development,
      debug: true,
    });
    await LlamaCPP.register();
    RunAnywhere.registerModels(MODELS);
  })();

  return sdkInitPromise;
}

async function ensureModel() {
  if (modelLoadPromise) {
    return modelLoadPromise;
  }

  modelLoadPromise = (async () => {
    await ensureSdk();
    const existing = ModelManager.getLoadedModel(ModelCategory.Language);
    if (existing?.id === MODEL_ID) {
      return;
    }

    await ModelManager.downloadModel(MODEL_ID);
    await ModelManager.loadModel(MODEL_ID);
  })();

  return modelLoadPromise;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function chunkText(input: string, maxChunkSize = 600) {
  const clean = input.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += maxChunkSize) {
    chunks.push(clean.slice(i, i + maxChunkSize));
  }
  return chunks;
}

function scoreChunk(chunk: string, query: string) {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((word) => word.length > 2);
  if (!words.length) return 0;

  const lowerChunk = chunk.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (lowerChunk.includes(word)) score += 1;
  }
  return score;
}

function buildContext(docs: IndexedDoc[], query: string) {
  const ranked = docs
    .flatMap((doc) =>
      chunkText(doc.text).map((chunk) => ({
        label: doc.path,
        chunk,
        score: scoreChunk(chunk, query),
      })),
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  return ranked
    .map((item, index) => `[Source ${index + 1}: ${item.label}]\n${item.chunk}`)
    .join("\n\n");
}

async function extractPdf(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocument({ data: bytes }).promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const text = await page.getTextContent();
    const pageText = text.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    pages.push(pageText);
  }

  return pages.join("\n");
}

async function extractDocx(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  const { value } = await mammoth.extractRawText({ arrayBuffer });
  return value;
}

async function collectDocs(
  directoryHandle: FileSystemDirectoryHandle,
  prefix = "",
): Promise<IndexedDoc[]> {
  const docs: IndexedDoc[] = [];

  for await (const entry of directoryHandle.values()) {
    const nextPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      const nested = await collectDocs(entry, nextPath);
      docs.push(...nested);
      continue;
    }

    const lower = entry.name.toLowerCase();
    const isPdf = lower.endsWith(".pdf");
    const isDocx = lower.endsWith(".docx");
    if (!isPdf && !isDocx) continue;

    const file = await entry.getFile();
    docs.push({
      id: `${nextPath}:${file.lastModified}:${file.size}`,
      name: entry.name,
      path: nextPath,
      kind: isPdf ? "pdf" : "docx",
      handle: entry,
      size: file.size,
      scanState: "queued",
      text: "",
    });
  }

  return docs.sort((a, b) => a.path.localeCompare(b.path));
}

function App() {
  const [dirName, setDirName] = useState<string>("");
  const [docs, setDocs] = useState<IndexedDoc[]>([]);
  const [scanBusy, setScanBusy] = useState(false);
  const [sdkBusy, setSdkBusy] = useState(false);
  const [askBusy, setAskBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [voiceLang, setVoiceLang] = useState("en-US");

  const indexedCount = docs.filter(
    (doc) => doc.scanState === "done" && doc.text.trim(),
  ).length;
  const totalChars = docs.reduce((sum, doc) => sum + doc.text.length, 0);

  async function pickDirectory() {
    setError("");
    setAnswer("");

    if (!("showDirectoryPicker" in window)) {
      setError(
        "This app requires Chrome/Edge with File System Access API support.",
      );
      return;
    }

    try {
      const handle = await window.showDirectoryPicker({
        id: "document-scan",
        startIn: "documents",
        mode: "read",
      });
      const foundDocs = await collectDocs(handle);
      setDirName(handle.name);
      setDocs(foundDocs);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Directory selection failed.";
      setError(message);
    }
  }

  async function scanDirectoryFiles() {
    if (!docs.length || scanBusy) return;
    setError("");
    setScanBusy(true);

    try {
      for (const doc of docs) {
        setDocs((prev) =>
          prev.map((item) =>
            item.id === doc.id
              ? { ...item, scanState: "scanning", error: undefined }
              : item,
          ),
        );

        try {
          const file = await doc.handle.getFile();
          const text =
            doc.kind === "pdf"
              ? await extractPdf(file)
              : await extractDocx(file);

          setDocs((prev) =>
            prev.map((item) =>
              item.id === doc.id
                ? {
                    ...item,
                    text,
                    scanState: "done",
                  }
                : item,
            ),
          );
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Failed to parse this file.";
          setDocs((prev) =>
            prev.map((item) =>
              item.id === doc.id
                ? {
                    ...item,
                    scanState: "failed",
                    error: message,
                  }
                : item,
            ),
          );
        }
      }
    } finally {
      setScanBusy(false);
    }
  }

  async function loadModel() {
    setError("");
    setSdkBusy(true);
    try {
      await ensureModel();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "RunAnywhere setup failed.";
      setError(message);
    } finally {
      setSdkBusy(false);
    }
  }

  function speakText(text: string) {
    if (!("speechSynthesis" in window)) {
      setError("Speech synthesis not supported in this browser.");
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = voiceLang;

    // Optional: better voice selection
    const voices = speechSynthesis.getVoices();
    const selectedVoice = voices.find((v) => v.lang === voiceLang);
    if (selectedVoice) {
      utterance.voice = selectedVoice;
    }

    speechSynthesis.cancel(); // stop previous speech
    speechSynthesis.speak(utterance);
  }

  async function askQuestion() {
    if (!question.trim() || askBusy) return;
    const scannedDocs = docs.filter(
      (doc) => doc.scanState === "done" && doc.text.trim(),
    );
    if (!scannedDocs.length) {
      setError("Scan at least one PDF or DOCX file before prompting.");
      return;
    }

    setError("");
    setAskBusy(true);
    setAnswer("");

    try {
      await ensureModel();

      const context = buildContext(scannedDocs, question);
      const prompt = [
        "Use only the context below to answer the user.",
        'If information is missing, say "Not found in selected documents."',
        "",
        context,
        "",
        `Question: ${question}`,
        "Answer:",
      ].join("\n");

      const { stream } = await TextGeneration.generateStream(prompt, {
        maxTokens: 260,
        temperature: 0.2,
        systemPrompt:
          "You are a precise document analyst. Keep answers concise and factual.",
      });

      let text = "";
      for await (const token of stream) {
        text += token;
        setAnswer(text);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Prompt failed.";
      setError(message);
    } finally {
      setAskBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100">
      <div className="mx-auto max-w-6xl px-5 py-10 md:px-8 md:py-14">
        <header className="mb-8 rounded-3xl border border-stone-800 bg-stone-900/70 p-6 md:p-8">
          <div className="mb-3 flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-700 bg-emerald-900/40 px-3 py-1 text-xs text-emerald-100">
              <ShieldCheck size={14} />
              AI Inference
            </span>

            <span className="inline-flex items-center gap-2 rounded-full border border-blue-700 bg-blue-900/40 px-3 py-1 text-xs text-blue-100">
              <FolderOpen size={14} />
              Easy Uploading
            </span>

            <span className="inline-flex items-center gap-2 rounded-full border border-purple-700 bg-purple-900/40 px-3 py-1 text-xs text-purple-100">
              <ScanSearch size={14} />
              Automatic File Scanning
            </span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-stone-50 md:text-4xl">
            Filesystem Document Scanner
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-stone-300 md:text-base">
            Select a local folder with the File System Access API, index all PDF
            and DOCX files, and ask questions against those files using the
            RunAnywhere Web SDK in your browser.
          </p>
        </header>

        <main className="grid gap-6 md:grid-cols-2">
          <section className="rounded-3xl border border-stone-800 bg-stone-900/60 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="inline-flex items-center gap-2 text-lg font-medium">
                <FolderOpen size={18} />
                Directory
              </h2>
              <button
                type="button"
                onClick={pickDirectory}
                className="rounded-xl border border-stone-700 bg-stone-800 px-4 py-2 text-sm text-stone-100"
              >
                Select Folder
              </button>
            </div>

            <div className="mb-5 rounded-2xl border border-stone-800 bg-stone-950/70 p-4 text-sm text-stone-300">
              {dirName ? `Selected: ${dirName}` : "No folder selected"}
            </div>

            <div className="mb-5 flex gap-3">
              <button
                type="button"
                onClick={scanDirectoryFiles}
                disabled={!docs.length || scanBusy}
                className="inline-flex items-center gap-2 rounded-xl border border-emerald-700 bg-emerald-900/40 px-4 py-2 text-sm text-emerald-100 disabled:opacity-50"
              >
                {scanBusy ? (
                  <LoaderCircle size={16} className="animate-spin" />
                ) : (
                  <ScanSearch size={16} />
                )}
                Scan Files
              </button>

              <button
                type="button"
                onClick={loadModel}
                disabled={sdkBusy}
                className="inline-flex items-center gap-2 rounded-xl border border-indigo-700 bg-indigo-900/40 px-4 py-2 text-sm text-indigo-100 disabled:opacity-50"
              >
                {sdkBusy ? (
                  <LoaderCircle size={16} className="animate-spin" />
                ) : (
                  <Brain size={16} />
                )}
                Load AI Model
              </button>
            </div>

            <div className="space-y-3">
              {docs.length === 0 ? (
                <p className="rounded-2xl border border-stone-800 bg-stone-950/70 p-4 text-sm text-stone-400">
                  No PDF or DOCX files found yet.
                </p>
              ) : (
                docs.map((doc) => (
                  <article
                    key={doc.id}
                    className="rounded-2xl border border-stone-800 bg-stone-950/70 p-4 text-sm"
                  >
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <p className="inline-flex items-center gap-2 font-medium text-stone-100">
                        <FileText size={15} />
                        {doc.name}
                      </p>
                      <span className="text-xs uppercase tracking-wide text-stone-400">
                        {doc.kind}
                      </span>
                    </div>
                    <p className="mb-2 text-xs text-stone-400">{doc.path}</p>
                    <div className="flex items-center justify-between text-xs text-stone-400">
                      <span>{formatBytes(doc.size)}</span>
                      <span>
                        {doc.scanState}
                        {doc.error ? ` • ${doc.error}` : ""}
                      </span>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>

          <section className="rounded-3xl border border-stone-800 bg-stone-900/60 p-6">
            <h2 className="mb-4 inline-flex items-center gap-2 text-lg font-medium">
              <MessageSquare size={18} />
              Ask Documents
            </h2>

            <div className="mb-4 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-2xl border border-stone-800 bg-stone-950/70 p-3">
                <p className="text-stone-400">Indexed files</p>
                <p className="text-lg font-semibold text-stone-100">
                  {indexedCount}
                </p>
              </div>
              <div className="rounded-2xl border border-stone-800 bg-stone-950/70 p-3">
                <p className="text-stone-400">Extracted text</p>
                <p className="text-lg font-semibold text-stone-100">
                  {totalChars.toLocaleString()} chars
                </p>
              </div>
            </div>

            <label
              className="mb-2 block text-sm text-stone-300"
              htmlFor="question"
            >
              Prompt
            </label>
            <textarea
              id="question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="What does the architecture section say about deployment?"
              rows={4}
              className="mb-4 w-full resize-y rounded-2xl border border-stone-700 bg-stone-950/70 px-4 py-3 text-sm text-stone-100 outline-none"
            />
            <select
              value={voiceLang}
              onChange={(e) => setVoiceLang(e.target.value)}
              className="mb-3 w-full rounded-xl border border-stone-700 bg-stone-950/70 px-3 py-2 text-sm text-stone-100"
            >
              <option value="en-US">English</option>
              <option value="hi-IN">Hindi</option>
              <option value="es-ES">Spanish</option>
              <option value="fr-FR">French</option>
              <option value="de-DE">German</option>
              <option value="ja-JP">Japanese</option>
            </select>

            <button
              type="button"
              onClick={askQuestion}
              disabled={askBusy || !question.trim()}
              className="inline-flex items-center gap-2 rounded-xl border border-amber-700 bg-amber-900/40 px-4 py-2 text-sm text-amber-100 disabled:opacity-50"
            >
              {askBusy ? (
                <LoaderCircle size={16} className="animate-spin" />
              ) : (
                <MessageSquare size={16} />
              )}
              Ask
            </button>

            <div className="mt-4 min-h-56 rounded-2xl border border-stone-800 bg-stone-950/70 p-4">
              <p className="mb-2 text-xs uppercase tracking-wide text-stone-500">
                Answer
              </p>
              <p className="whitespace-pre-wrap text-sm leading-6 text-stone-200">
                {answer || "Your answer will appear here."}
              </p>
            </div>
          </section>
          <button
            type="button"
            onClick={() => speakText(answer)}
            disabled={!answer}
            className="mt-3 inline-flex items-center gap-2 rounded-xl border border-pink-700 bg-pink-900/40 px-4 py-2 text-sm text-pink-100 disabled:opacity-50"
          >
            🔊 Speak Answer
          </button>
        </main>

        {error ? (
          <div className="mt-6 rounded-2xl border border-rose-800 bg-rose-950/40 p-4 text-sm text-rose-200">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default App;
