import type {
  BackupFile,
  ExtractedStatement,
  ImportInput,
  Overview,
  Settings,
} from "../../shared/schema";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "same-origin", ...init });
  const text = await r.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  if (!r.ok) {
    const body = (data ?? {}) as { error?: string; code?: string };
    throw new ApiError(body.error ?? `Request failed (${r.status})`, r.status, body.code);
  }
  return data as T;
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export type SessionInfo = {
  user: { id: number; email: string; displayName: string } | null;
  canRegister: boolean;
};

export type ChatConfig = {
  claude: boolean;
  claudeModels: { id: string; name: string }[];
};
export type ChatReply = {
  reply: string;
  sources: { title: string; url: string }[];
  model: string;
  searched: boolean;
};

export const api = {
  session: () => request<SessionInfo>("/api/auth"),
  login: (email: string, password: string) =>
    post<{ user: SessionInfo["user"] }>("/api/auth", { action: "login", email, password }),
  register: (email: string, displayName: string, password: string) =>
    post<{ user: SessionInfo["user"] }>("/api/auth", { action: "register", email, displayName, password }),
  logout: () => post<{ ok: true }>("/api/auth", { action: "logout" }),

  overview: () => request<Overview>("/api/portfolio"),
  backup: () => request<BackupFile>("/api/portfolio?all=1"),
  importSnapshot: (input: ImportInput) =>
    post<{ snapshotId: number; inserted: number }>("/api/portfolio", { action: "import", ...input }),
  deleteSnapshot: (id: number) =>
    post<{ deleted: number }>("/api/portfolio", { action: "deleteSnapshot", id }),
  saveFx: (currency: string, rate: number) =>
    post<{ currency: string; rate: number }>("/api/portfolio", { action: "saveFx", currency, rate }),

  saveSettings: (settings: Settings) =>
    post<Settings>("/api/portfolio", { action: "saveSettings", ...settings }),

  chatConfig: () => request<ChatConfig>("/api/chat"),
  chat: (input: {
    model: string | null;
    messages: { role: "user" | "model"; text: string }[];
    context: string;
    search: boolean;
  }) => post<ChatReply>("/api/chat", input),

  // The PDF goes as the raw request body (no base64 overhead).
  extractPdf: (file: File) =>
    request<ExtractedStatement>("/api/pdf-extract", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
    }),
};
