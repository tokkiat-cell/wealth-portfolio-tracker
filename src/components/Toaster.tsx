import { useEffect, useState } from "react";
import { toast, type ToastMessage } from "../lib/toast";

export function Toaster() {
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  useEffect(() => toast.subscribe(setMessages), []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {messages.map((m) => (
        <div key={m.id} className={`toast ${m.kind === "error" ? "error" : ""}`}>
          {m.text}
        </div>
      ))}
    </div>
  );
}
