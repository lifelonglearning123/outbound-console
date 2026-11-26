"use client";

import { useEffect } from "react";

/** Opens the folded section (a <details>) with this id when the page is opened at #id, so links to it land open. */
export function HashOpen({ id }: { id: string }) {
  useEffect(() => {
    const open = () => {
      if (window.location.hash === `#${id}`) {
        const el = document.getElementById(id);
        if (el instanceof HTMLDetailsElement) {
          el.open = true;
          el.scrollIntoView({ block: "start" });
        }
      }
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [id]);
  return null;
}
