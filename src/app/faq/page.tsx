import { requireUser } from "@/lib/auth";
import { FAQ, type FaqBlock } from "@/lib/faq";

export const metadata = { title: "FAQ" };

/** Answers to the questions people ask about the console, for everyone who can sign in. */
export default async function FaqPage() {
  await requireUser();
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">FAQ</h1>
        <p className="text-sm text-muted">Answers to the questions people ask about the console.</p>
      </header>
      {FAQ.map((section) => (
        <section key={section.id} id={section.id} className="flex flex-col gap-2">
          <h2 className="font-semibold">{section.title}</h2>
          <div className="card divide-y divide-line">
            {section.items.map((item) => (
              <details key={item.id} id={item.id} className="group">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-4 py-3 text-sm font-medium hover:bg-line/40 [&::-webkit-details-marker]:hidden">
                  <span>{item.question}</span>
                  <span aria-hidden className="text-muted transition-transform group-open:rotate-45 motion-reduce:transition-none">+</span>
                </summary>
                <div className="flex flex-col gap-2 px-4 pb-4 text-sm text-muted">
                  {item.answer.map((block, i) => <Block key={i} block={block} />)}
                </div>
              </details>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Block({ block }: { block: FaqBlock }) {
  if (typeof block === "string") return <p>{block}</p>;
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5">
      {block.map((line, i) => <li key={i}>{line}</li>)}
    </ul>
  );
}
