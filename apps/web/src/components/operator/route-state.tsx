import { type ApiMiss, describeMiss, type Method } from "@/lib/operator/api";

type Props =
  | { kind: "pending"; method: Method; path: string }
  | { kind: "miss"; miss: ApiMiss }
  | { kind: "ok"; method: Method; path: string; status: number; summary: string };

function statusTone(status: number): "ok" | "bad" | "warn" | "" {
  if (status === 0) return "warn";
  if (status >= 200 && status < 300) return "ok";
  if (status >= 500) return "bad";
  return "";
}

/** The calm inline state for a request: method, path, status, one sentence. Never a fake result. */
export function RouteState(props: Props) {
  if (props.kind === "pending") {
    return (
      <div className="op-route pending" role="status">
        <div className="op-route-line">
          <span className="op-method">{props.method}</span>
          <span>{props.path}</span>
          <span className="op-status">sending</span>
        </div>
        <span>Waiting for the app API.</span>
      </div>
    );
  }
  if (props.kind === "miss") {
    const { miss } = props;
    return (
      <div className="op-route" role="status">
        <div className="op-route-line">
          <span className="op-method">{miss.method}</span>
          <span>{miss.path}</span>
          <span className={`op-status ${statusTone(miss.status)}`}>
            {miss.status === 0 ? "no response" : miss.status}
          </span>
        </div>
        <span title={miss.detail || undefined}>{describeMiss(miss)}</span>
      </div>
    );
  }
  return (
    <div className="op-route" role="status">
      <div className="op-route-line">
        <span className="op-method">{props.method}</span>
        <span>{props.path}</span>
        <span className={`op-status ${statusTone(props.status)}`}>{props.status}</span>
      </div>
      <span>{props.summary}</span>
    </div>
  );
}
