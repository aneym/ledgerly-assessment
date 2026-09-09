"use client";

import { Streamdown } from "streamdown";
import "streamdown/styles.css";

/**
 * Assistant replies are Markdown streamed token by token. Streamdown closes unterminated
 * bold, lists and code fences while the text is still arriving, so a half-written
 * "**$325" never shows literal asterisks. The panel styles the rendered elements itself
 * (operator.css .op-assist-md); Streamdown's Tailwind class names are not compiled into
 * this app's stylesheet on purpose, so its shadcn look never leaks in.
 */
export function AssistantMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Streamdown
      className="op-assist-md"
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      controls={false}
      linkSafety={{ enabled: false }}
      tableMaxHeight={0}
    >
      {text}
    </Streamdown>
  );
}
