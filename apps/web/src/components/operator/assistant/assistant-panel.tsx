"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import Link from "next/link";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { ProvenanceBadge } from "@/components/provenance-badge";
import { CopyId } from "@/components/table";
import { displaySeller } from "@/lib/catalog/display-name";
import {
  ASSISTANT_PATH,
  type AssistantContext,
  type AssistantMessage,
  type AssistantSource,
  describeTool,
  ERROR_LABEL,
  type HealthState,
  KIND_WORD,
  MOCK_SUGGESTIONS,
  parseAssistantError,
  readHealth,
  suggestionList,
} from "@/lib/operator/assistant";
import { AssistantMarkdown } from "./assistant-markdown";
import { useAssistant } from "./assistant-provider";

/**
 * The operator assistant. A right sidebar on desktop, a bottom sheet on narrow screens.
 * Streams through the AI SDK. When the route is down the reason is shown and Send is off.
 */
export function AssistantPanel() {
  const { open, setOpen, context } = useAssistant();
  const [health, setHealth] = useState<HealthState>({ kind: "checking" });
  const contextRef = useRef(context);
  contextRef.current = context;

  // One health read each time the panel opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setHealth({ kind: "checking" });
    readHealth().then((state) => {
      if (!cancelled) setHealth(state);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<AssistantMessage>({
        api: ASSISTANT_PATH,
        body: () => ({ context: wire(contextRef.current) }),
      }),
    [],
  );
  const { messages, sendMessage, status, error, stop, regenerate, clearError } =
    useChat<AssistantMessage>({ transport });

  const busy = status === "submitted" || status === "streaming";
  const live = health.kind === "ok";
  const canSend = live && !busy;
  const failure = error ? parseAssistantError(error) : null;

  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Keep the newest text in view while it streams. The size is what changes as parts arrive.
  const transcriptSize = messages.reduce(
    (n, m) => n + m.parts.reduce((k, p) => k + (p.type === "text" ? p.text.length : 1), 0),
    0,
  );
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.dataset.size = String(transcriptSize);
    el.scrollTop = el.scrollHeight;
  }, [transcriptSize]);

  // The page shifts to make room for the sidebar. The root is a server component, so flag it here.
  useEffect(() => {
    const root = document.querySelector(".op-root");
    root?.classList.toggle("has-assistant", open);
    return () => root?.classList.remove("has-assistant");
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const streamedSuggestions = lastSuggestions(messages);
  const suggestions = streamedSuggestions ?? MOCK_SUGGESTIONS[context.kind ?? "none"];
  const suggestionsMock = streamedSuggestions === null;

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !canSend) return;
    clearError();
    setDraft("");
    void sendMessage({ text: trimmed }, { body: { context: wire(contextRef.current) } });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    submit(draft);
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(draft);
    }
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant") ?? null;

  return (
    <aside
      id="op-assistant"
      className={`op-assist${open ? " is-open" : ""}`}
      data-tour="admin.assistant.panel"
      aria-label="Operator assistant"
      hidden={!open}
    >
      <header className="op-assist-head">
        <div>
          <h2>Assistant</h2>
          <Status health={health} />
        </div>
        <button
          type="button"
          className="op-assist-close"
          onClick={() => setOpen(false)}
          aria-label="Close assistant"
        >
          <svg className="op-assist-icon" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M3 3l8 8M11 3l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      <RecordCard context={context} />

      <div className="op-assist-body" ref={listRef}>
        {messages.length === 0 && (
          <p className="op-assist-intro">
            Ask about a record, an integration event, or an issue. Answers cite the records the
            tools read. Read only.
          </p>
        )}

        {messages.map((message) => (
          <Message
            key={message.id}
            message={message}
            streaming={busy && message === messages[messages.length - 1]}
          />
        ))}

        {status === "submitted" && (
          <div className="op-assist-msg is-assistant">
            <span className="op-assist-thinking">Working</span>
          </div>
        )}

        {failure && (
          <div className="op-assist-error" role="alert">
            <b>{ERROR_LABEL[failure.error]}</b>
            <span>{failure.message}</span>
            {lastAssistant || messages.length > 0 ? (
              <button
                type="button"
                className="pill ghost sm"
                onClick={() => {
                  clearError();
                  void regenerate({ body: { context: wire(contextRef.current) } });
                }}
                disabled={!live}
              >
                Retry
              </button>
            ) : null}
          </div>
        )}
      </div>

      <div className="op-assist-suggest" data-tour="admin.assistant.suggestions">
        <div className="op-assist-suggest-head">
          <span title={suggestionsMock ? "Fixture suggestions until the route is live" : undefined}>
            Suggested
          </span>
        </div>
        <div className="op-assist-chips">
          {suggestions.map((text) => (
            <button
              key={text}
              type="button"
              className="op-assist-chip"
              onClick={() => (canSend ? submit(text) : setDraft(text))}
              title={
                canSend
                  ? "Send this question"
                  : "Copies into the box. Send is off while the route is down."
              }
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      <form className="op-assist-form" onSubmit={onSubmit}>
        <label className="op-sr" htmlFor="op-assist-input">
          Ask the assistant
        </label>
        <textarea
          id="op-assist-input"
          ref={inputRef}
          className="op-assist-input"
          data-tour="admin.assistant.input"
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKey}
          placeholder={live ? "Ask about this record" : "Send is off while the assistant is down"}
          disabled={busy}
        />
        <div className="op-assist-actions">
          {busy ? (
            <button
              type="button"
              className="pill ghost sm"
              data-tour="admin.assistant.stop"
              onClick={() => stop()}
            >
              Stop
            </button>
          ) : (
            <span className="op-assist-hint">Enter sends, Shift+Enter breaks a line</span>
          )}
          {!busy && lastAssistant && !failure && (
            <button
              type="button"
              className="pill ghost sm"
              onClick={() => void regenerate({ body: { context: wire(contextRef.current) } })}
              disabled={!live}
            >
              Retry
            </button>
          )}
          <button
            type="submit"
            className="pill ink sm"
            data-tour="admin.assistant.send"
            disabled={!canSend || !draft.trim()}
            title={live ? undefined : "The assistant route is down"}
          >
            Send
          </button>
        </div>
      </form>
    </aside>
  );
}

/** Only the contract fields go over the wire. */
function wire(context: AssistantContext) {
  return { kind: context.kind, id: context.id, route: context.route };
}

function Status({ health }: { health: HealthState }) {
  if (health.kind === "checking") {
    return (
      <p className="op-assist-status">
        <i className="op-dot pending" aria-hidden="true" /> Checking
      </p>
    );
  }
  if (health.kind === "ok") {
    return (
      <p className="op-assist-status">
        <i className="op-dot active" aria-hidden="true" /> Ready
      </p>
    );
  }
  return (
    <p className="op-assist-status is-down">
      <i className="op-dot" aria-hidden="true" />
      <span>
        Unavailable: {health.reason}
        {health.status ? <span className="op-mono"> {health.status}</span> : null}
      </span>
    </p>
  );
}

function RecordCard({ context }: { context: AssistantContext }) {
  if (!context.kind || !context.id) {
    return (
      <div className="op-assist-record is-empty">
        <span className="op-muted">
          No record selected. Open an issue, a ledger row or a seller and the assistant starts from
          it.
        </span>
      </div>
    );
  }
  return (
    <div className="op-assist-record">
      <span className="op-assist-record-kind">{KIND_WORD[context.kind]}</span>
      <span className="op-assist-record-main">
        <b className="op-assist-record-title">{context.label ?? context.id}</b>
        <CopyId value={context.id} />
      </span>
      {context.href && (
        <Link className="op-assist-record-link" href={context.href}>
          Open
        </Link>
      )}
    </div>
  );
}

function Message({ message, streaming }: { message: AssistantMessage; streaming: boolean }) {
  const isUser = message.role === "user";
  const sources: AssistantSource[] = [];
  const lines: Array<{ key: string; kind: "text" | "tool"; text: string; done: boolean }> = [];
  message.parts.forEach((part, index) => {
    if (part.type === "text") {
      lines.push({
        key: `t${index}`,
        kind: "text",
        text: part.text,
        done: part.state !== "streaming",
      });
    } else if (part.type === "data-source") {
      sources.push(part.data);
    } else if (part.type === "dynamic-tool") {
      lines.push({
        key: `d${index}`,
        kind: "tool",
        text: describeTool(part.toolName, part.input),
        done: part.state === "output-available" || part.state === "output-error",
      });
    } else if (part.type.startsWith("tool-")) {
      const tool = part as { type: string; input?: unknown; state?: string };
      lines.push({
        key: `x${index}`,
        kind: "tool",
        text: describeTool(part.type.slice(5), tool.input),
        done: tool.state === "output-available" || tool.state === "output-error",
      });
    }
  });
  return (
    <div className={`op-assist-msg ${isUser ? "is-user" : "is-assistant"}`}>
      {lines.map((line) =>
        line.kind === "tool" ? (
          <div key={line.key} className={`op-assist-tool${line.done ? " is-done" : ""}`}>
            <i aria-hidden="true" />
            <span>{line.text}</span>
          </div>
        ) : isUser ? (
          <p key={line.key} className="op-assist-text">
            {line.text}
          </p>
        ) : (
          <div key={line.key} className="op-assist-text">
            <AssistantMarkdown text={line.text} streaming={streaming && !line.done} />
            {streaming && !line.done && <span className="op-assist-cursor" aria-hidden="true" />}
          </div>
        ),
      )}
      {sources.length > 0 && (
        <div className="op-assist-sources" data-tour="admin.assistant.sources">
          <span className="op-assist-sources-head">Sources</span>
          <ul>
            {sources.map((source) => (
              <li key={`${source.kind}-${source.id}`}>
                <Link href={source.href}>{sourceLabel(source)}</Link>
                <span className="op-mono op-assist-src-id">{source.id}</span>
                {source.provenance && <ProvenanceBadge provenance={source.provenance} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The newest `data-suggestions` part in the conversation, or null before the route speaks. */
function lastSuggestions(messages: AssistantMessage[]): string[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    for (let j = message.parts.length - 1; j >= 0; j--) {
      const part = message.parts[j];
      if (part?.type === "data-suggestions") {
        const list = suggestionList(part.data);
        if (list.length > 0) return list;
      }
    }
  }
  return null;
}

/** Seller sources show the business name, never an external id. */
function sourceLabel(source: AssistantSource): string {
  if (source.kind !== "seller") return source.label;
  return displaySeller({ id: source.id, name: source.label }).name;
}
