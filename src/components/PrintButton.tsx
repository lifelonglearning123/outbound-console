"use client";

/** Opens the browser's print dialog; choose "Save as PDF" to get a file to send. */
export function PrintButton() {
  return (
    <button type="button" className="btn-go print:hidden" onClick={() => window.print()}>
      Download PDF
    </button>
  );
}
