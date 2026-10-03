import { useGraph } from "../store/graph";
import { fetchHistory } from "./api";

/**
 * Single event stream with exponential-backoff reconnect + history restore. Returns disposer.
 *
 * On every (re)connect: buffer live frames, load the persisted event log, apply it, then flush
 * the buffer. Duplicates are dropped by the projection (seq <= last seen), so nothing is
 * applied twice and nothing published while we were away is lost.
 */
export function connectEvents(url = defaultUrl(), history: () => Promise<unknown[]> = () => fetchHistory()): () => void {
  let ws: WebSocket | null = null;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const { ingest, setWsStatus } = useGraph.getState();

  const open = () => {
    setWsStatus("connecting");
    const sock = new WebSocket(url);
    ws = sock;
    let buffer: string[] | null = [];
    sock.onopen = () => {
      retry = 0;
      history()
        .catch((e) => {
          console.warn("[ws] history restore failed", e);
          return [] as unknown[];
        })
        .then((events) => {
          if (disposed || ws !== sock) return;
          for (const e of events) ingest(JSON.stringify(e), { history: true });
          for (const raw of buffer ?? []) ingest(raw);
          buffer = null;
          setWsStatus("open");
        });
    };
    sock.onmessage = (m) => {
      const raw = typeof m.data === "string" ? m.data : "";
      if (buffer) buffer.push(raw);
      else ingest(raw);
    };
    sock.onclose = () => {
      setWsStatus("closed");
      if (disposed || ws !== sock) return;
      timer = setTimeout(open, Math.min(500 * 2 ** retry++, 8000));
    };
    sock.onerror = () => sock.close();
  };
  open();

  return () => {
    disposed = true;
    clearTimeout(timer);
    ws?.close();
  };
}

function defaultUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}
