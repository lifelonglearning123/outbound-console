"use client";

import { useEffect, useRef, useState } from "react";
import { htmlWarnings, renderMerge, sanitizeEmailHtml, STANDARD_FIELDS } from "@/lib/merge";

// The editor lives in an iframe so the app's own CSS can't change how the email looks: what you see
// here is the HTML that gets sent. Pasting from Gmail, Outlook, Word or a web page keeps the formatting.
const FRAME_STYLE = "body{font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;margin:14px;color:#222}";
const SAMPLE = { email: "sara@brightpixel.co.uk", first_name: "Sara", last_name: "Hughes", company: "Bright Pixel", title: "Founder", website: "brightpixel.co.uk" };

function frameDoc(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FRAME_STYLE}</style></head><body>${html}</body></html>`;
}

export function EmailEditor({ name, initial }: { name: string; initial: string }) {
  const [html, setHtml] = useState(initial);
  const [view, setView] = useState<"visual" | "html" | "preview">("visual");
  const frame = useRef<HTMLIFrameElement>(null);

  // (Re)load the editable frame whenever the visual view is shown, from the current HTML.
  useEffect(() => {
    if (view !== "visual") return;
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(frameDoc(html));
    doc.close();
    doc.designMode = "on";
    const onInput = () => setHtml(sanitizeEmailHtml(doc.body.innerHTML));
    doc.addEventListener("input", onInput);
    return () => doc.removeEventListener("input", onInput);
    // Only when switching views; typing updates `html` from the frame itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const insertField = (field: string) => {
    const token = `{{${field}}}`;
    if (view === "visual" && frame.current?.contentWindow) {
      frame.current.contentWindow.focus();
      frame.current.contentDocument?.execCommand("insertText", false, token);
    } else {
      setHtml(html + token);
    }
  };

  const warnings = htmlWarnings(html);
  const tab = (v: typeof view, label: string) => (
    <button type="button" onClick={() => setView(v)} className={`rounded px-2.5 py-1 text-xs ${view === v ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}>
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name={name} value={html} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex rounded-md border border-line p-0.5">
          {tab("visual", "Design")}
          {tab("html", "HTML")}
          {tab("preview", "Preview with a sample lead")}
        </div>
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-muted">Insert:</span>
          {STANDARD_FIELDS.filter((f) => f !== "email" && f !== "phone").map((f) => (
            <button key={f} type="button" onClick={() => insertField(f)} className="rounded border border-line px-1.5 py-0.5 font-mono hover:border-ink">
              {f}
            </button>
          ))}
        </div>
      </div>

      {view === "visual" && (
        <iframe ref={frame} title="Email design" className="h-80 w-full rounded-md border border-line bg-white" />
      )}
      {view === "html" && (
        <textarea
          className="field h-80 font-mono text-xs"
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          onBlur={(e) => setHtml(sanitizeEmailHtml(e.target.value))}
          spellCheck={false}
        />
      )}
      {view === "preview" && (
        <iframe
          title="Email preview"
          sandbox=""
          srcDoc={frameDoc(renderMerge(html, SAMPLE, true).text)}
          className="h-80 w-full rounded-md border border-line bg-white"
        />
      )}

      <p className="text-xs text-muted">
        Paste your finished email into Design (formatting is kept), or paste its HTML into HTML. It&apos;s sent exactly as shown; only merge fields
        change. Use <span className="font-mono">{"{{first_name|there}}"}</span> for a fallback when a lead has no first name. Any CSV column works too, e.g.{" "}
        <span className="font-mono">{"{{city}}"}</span>.
      </p>
      {warnings.map((w) => (
        <p key={w} className="text-xs text-wait">⚑ {w}</p>
      ))}
    </div>
  );
}
