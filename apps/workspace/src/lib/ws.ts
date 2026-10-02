import { useGraph } from "../store/graph";

/** Single event stream with exponential-backoff reconnect. Returns disposer. */
export function connectEvents(url = defaultUrl()): () => void {
  let ws: WebSocket | null = null;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const { ingest, setWsStatus } = useGraph.getState();

  const open = () => {
    setWsStatus("connecting");
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 0;
      setWsStatus("open");
    };
    ws.onmessage = (m) => ingest(typeof m.data === "string" ? m.data : "");
    ws.onclose = () => {
      setWsStatus("closed");
      if (disposed) return;
      timer = setTimeout(open, Math.min(500 * 2 ** retry++, 8000));
    };
    ws.onerror = () => ws?.close();
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
