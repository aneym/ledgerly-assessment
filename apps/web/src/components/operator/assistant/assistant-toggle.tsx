"use client";

import { useAssistant } from "./assistant-provider";

/** App bar control. The "?" key does the same. */
export function AssistantToggle() {
  const { open, toggle } = useAssistant();
  return (
    <button
      type="button"
      className={`op-assist-toggle${open ? " is-on" : ""}`}
      data-tour="admin.assistant.toggle"
      aria-pressed={open}
      aria-controls="op-assistant"
      onClick={toggle}
      title="Assistant, press ? to toggle"
    >
      <svg className="op-assist-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 1.5c.4 1.9 1.6 3.1 3.5 3.5-1.9.4-3.1 1.6-3.5 3.5-.4-1.9-1.6-3.1-3.5-3.5 1.9-.4 3.1-1.6 3.5-3.5ZM3 9.5c.25 1.2 1.05 2 2.25 2.25C4.05 12 3.25 12.8 3 14c-.25-1.2-1.05-2-2.25-2.25C1.95 11.5 2.75 10.7 3 9.5Z"
          fill="currentColor"
        />
      </svg>
      <span>Assistant</span>
      <kbd>?</kbd>
    </button>
  );
}
