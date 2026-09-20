export type ToastMessage = { id: number; text: string; kind: "ok" | "error" };

type Listener = (messages: ToastMessage[]) => void;

let messages: ToastMessage[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

const emit = () => listeners.forEach((l) => l(messages));

function push(text: string, kind: ToastMessage["kind"]) {
  const id = nextId++;
  messages = [...messages, { id, text, kind }];
  emit();
  setTimeout(() => {
    messages = messages.filter((m) => m.id !== id);
    emit();
  }, kind === "error" ? 7000 : 4000);
}

export const toast = {
  ok: (text: string) => push(text, "ok"),
  error: (text: string) => push(text, "error"),
  subscribe: (l: Listener) => {
    listeners.add(l);
    l(messages);
    return () => {
      listeners.delete(l);
    };
  },
};
