import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Settings } from "../../shared/schema";
import { ApiError, api, type ChatConfig } from "../lib/api";
import { SHARE_MODES, buildChatContext, type ShareMode } from "../lib/chatContext";
import type { PortfolioModel } from "../lib/portfolioModel";

interface Props {
  model: PortfolioModel;
  settings: Settings;
}

type Msg = { role: "user" | "model"; text: string; sources?: { title: string; url: string }[]; note?: string };

const STARTERS = [
  "Summarise my currency risk and what drives it.",
  "How concentrated is my portfolio, and what are the main risks?",
  "What are the trade-offs of holding gold through an SGD-listed ETF versus a USD one?",
  "How exposed am I to rising interest rates, given my loans?",
  "What questions should I take to a licensed adviser about my rebalancing?",
];

const KEY_HELP =
  "Create a key at console.anthropic.com (this is separate from a Claude.ai subscription and is billed per use), add it in Vercel as ANTHROPIC_API_KEY (Project → Settings → Environment Variables), then redeploy.";

const store = {
  get: (k: string): string | null => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // storage can be blocked; the choice just isn't remembered
    }
  },
};

// **bold** inside a line, as real elements (no HTML injection).
function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

// Enough markdown for a chat answer: headings, bullets, bold, paragraphs.
function Rendered({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) {
      const items = bullets;
      blocks.push(
        <ul key={`u${blocks.length}`}>
          {items.map((b, i) => (
            <li key={i}>{inline(b)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (bullet) bullets.push(bullet[1]);
    else {
      flush();
      if (heading) blocks.push(<h4 key={blocks.length}>{inline(heading[1])}</h4>);
      else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
    }
  }
  flush();
  return <>{blocks}</>;
}

export function ChatPanel({ model, settings }: Props) {
  const [config, setConfig] = useState<ChatConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [claudeModel, setClaudeModel] = useState<string>(() => store.get("wpt.chat.claudeModel") ?? "");
  const [search, setSearch] = useState(() => store.get("wpt.chat.search") !== "0");
  const [share, setShare] = useState<ShareMode>(() => {
    const s = store.get("wpt.chat.share");
    return s === "full" || s === "none" ? s : "shares";
  });
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .chatConfig()
      .then((c) => {
        setConfig(c);
        setClaudeModel((m) => (c.claudeModels.some((x) => x.id === m) ? m : (c.claudeModels[0]?.id ?? "")));
      })
      .catch((e) => setConfigError(e instanceof ApiError ? e.message : "Could not reach the server."));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, busy]);

  const context = useMemo(() => buildChatContext(model, settings, share), [model, settings, share]);
  const ready = Boolean(config?.claude);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy || !ready) return;
    const next: Msg[] = [...messages, { role: "user", text: question }];
    setMessages(next);
    setInput("");
    setError(null);
    setBusy(true);
    try {
      // Only the recent turns are sent, and the first must be the person's.
      // Earlier AI replies are trimmed so a long chat stays quick and cheap.
      let history = next.slice(-12).map((m) => ({ role: m.role, text: m.role === "model" ? m.text.slice(0, 8000) : m.text }));
      while (history.length > 1 && history[0].role !== "user") history = history.slice(1);
      const r = await api.chat({ model: claudeModel || null, messages: history, context, search });
      const note =
        claudeModel && r.model !== claudeModel ? `Answered by ${r.model} because ${claudeModel} was busy.` : undefined;
      setMessages([...next, { role: "model", text: r.reply, sources: r.sources, note }]);
    } catch (e) {
      // Put the question back so nothing is lost and turns keep alternating.
      setMessages(messages);
      setInput(question);
      setError(e instanceof ApiError ? e.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  const shareHelp = SHARE_MODES.find((m) => m.id === share)?.help;

  return (
    <div>
      <section className="card">
        <h3>AI analysis and research</h3>
        <p className="muted">
          Ask about your exposures, risks, scenarios or a topic you want researched. It gives analysis and trade-offs, not
          personal advice: it will not tell you what to buy or sell. It can be wrong, so check figures and take decisions
          to a licensed adviser.
        </p>

        {configError && <p className="notice error">{configError}</p>}

        <div className="form">
          <label className="field">
            Claude model
            <select
              value={claudeModel}
              onChange={(e) => {
                setClaudeModel(e.target.value);
                store.set("wpt.chat.claudeModel", e.target.value);
              }}
              disabled={!config?.claudeModels.length}
            >
              {(config?.claudeModels ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            Share about my portfolio
            <select
              value={share}
              onChange={(e) => {
                const v = e.target.value as ShareMode;
                setShare(v);
                store.set("wpt.chat.share", v);
              }}
            >
              {SHARE_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="row" style={{ marginBottom: "0.5rem" }}>
          <input
            type="checkbox"
            checked={search}
            onChange={(e) => {
              setSearch(e.target.checked);
              store.set("wpt.chat.search", e.target.checked ? "1" : "0");
            }}
          />
          <span className="muted">
            Let Claude search the web for research (adds sources, and web search is billed extra by Anthropic)
          </span>
        </label>

        <p className="notice">
          Your questions and the shared summary are sent to Anthropic's Claude API and billed to your Anthropic account.{" "}
          {shareHelp} Account numbers are never sent.
        </p>

        {config && !ready && <p className="notice error">Claude has no key yet. {KEY_HELP}</p>}
      </section>

      <section className="card chat">
        {messages.length === 0 && (
          <div>
            <p className="muted">Try one of these, or type your own.</p>
            <div className="row">
              {STARTERS.map((s) => (
                <button key={s} className="btn small" disabled={!ready || busy} onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="chat-log" aria-live="polite">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <span className="msg-who">{m.role === "user" ? "You" : "AI"}</span>
              {m.role === "user" ? <p>{m.text}</p> : <Rendered text={m.text} />}
              {m.note && <p className="muted">{m.note}</p>}
              {m.sources && m.sources.length > 0 && (
                <div className="sources">
                  <span className="muted">Sources</span>
                  <ul>
                    {m.sources.map((s) => (
                      <li key={s.url}>
                        <a href={s.url} target="_blank" rel="noopener noreferrer">
                          {s.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
          {busy && <p className="muted">Thinking… this can take up to a minute.</p>}
          <div ref={endRef} />
        </div>

        {error && <p className="notice error">{error}</p>}

        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            rows={3}
            value={input}
            maxLength={4000}
            placeholder="Ask about your portfolio, a risk, or a topic to research…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(input);
              }
            }}
            aria-label="Your question"
          />
          <div className="actions" style={{ marginTop: 0 }}>
            <button className="btn primary" type="submit" disabled={!ready || busy || !input.trim()}>
              {busy ? "Sending…" : "Ask"}
            </button>
            {messages.length > 0 && (
              <button
                className="btn ghost"
                type="button"
                disabled={busy}
                onClick={() => {
                  setMessages([]);
                  setError(null);
                }}
              >
                Clear chat
              </button>
            )}
            <span className="muted">Enter to send · Shift+Enter for a new line · chats are not saved</span>
          </div>
        </form>
      </section>
    </div>
  );
}
