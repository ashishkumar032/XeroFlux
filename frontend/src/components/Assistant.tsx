import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUp, Bot, Compass, Mic, MicOff, RefreshCw, Volume2, VolumeX, X } from 'lucide-react';
import { INITIAL_GREETING, QUICK_PROMPTS, queryAssistant, type AssistantMessage } from '../api/assistantClient';

interface SpeechRecognitionResultItem {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResultList {
  [index: number]: {
    [index: number]: SpeechRecognitionResultItem;
  };
}

interface ISpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}

interface ISpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface ISpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onresult: ((event: ISpeechRecognitionEvent) => void) | null;
  onerror: ((event: ISpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionConstructor {
  new (): ISpeechRecognition;
}

interface IWindowSpeech extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

/** Minimal safe Markdown: paragraphs, "-"/"*" bullets, **bold**. Builds React nodes, never raw HTML. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : part);
}

function FormattedText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) blocks.push(<ul key={`u${blocks.length}`}>{bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}</ul>);
    bullets = [];
  };
  for (const line of text.split('\n')) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) { bullets.push(bullet[1]); continue; }
    flush();
    if (line.trim()) blocks.push(<p key={`p${blocks.length}`}>{inline(line.trim().replace(/^#+\s*/, ''))}</p>);
  }
  flush();
  return <>{blocks}</>;
}

export default function Assistant() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<AssistantMessage[]>([
    {
      id: 'initial',
      role: 'assistant',
      text: INITIAL_GREETING,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      links: []
    }
  ]);
  const [loading, setLoading] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);

  const launcherRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<ISpeechRecognition | null>(null);

  // Initialize Web Speech APIs
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const win = window as IWindowSpeech;
    const SpeechRecognition = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (SpeechRecognition) {
      setVoiceSupported(true);
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        setListening(true);
        setVoiceNotice('Listening… Speak your question.');
      };

      recognition.onresult = (event: ISpeechRecognitionEvent) => {
        const transcript = event.results?.[0]?.[0]?.transcript;
        if (transcript) {
          setInput(transcript);
          setVoiceNotice(null);
          void handleSend(transcript);
        }
      };

      recognition.onerror = (event: ISpeechRecognitionErrorEvent) => {
        setListening(false);
        if (event.error === 'not-allowed') {
          setVoiceNotice('Microphone access blocked. Please enable microphone permissions in your browser or type your question.');
        } else if (event.error === 'no-speech') {
          setVoiceNotice('No speech detected. Tap microphone to try again.');
        } else {
          setVoiceNotice(`Speech recognition error (${event.error}). Please type below.`);
        }
      };

      recognition.onend = () => {
        setListening(false);
      };

      recognitionRef.current = recognition;
    }
  }, []);

  // Keyboard navigation & accessibility focus trap
  useEffect(() => {
    if (!open) {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      setSpeakingMessageId(null);
      return;
    }

    inputRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        launcherRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  // Scroll messages to bottom on update
  useEffect(() => {
    if (open) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, open, loading]);

  const toggleVoiceInput = () => {
    if (!voiceSupported) {
      setVoiceNotice('Voice recognition is not supported in this browser. Please type below.');
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      setVoiceNotice(null);
    } else {
      setVoiceNotice(null);
      try {
        recognitionRef.current?.start();
      } catch {
        setListening(false);
      }
    }
  };

  const speakText = (msgId: string, text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    if (speakingMessageId === msgId) {
      window.speechSynthesis.cancel();
      setSpeakingMessageId(null);
      return;
    }

    window.speechSynthesis.cancel();
    // Clean text of URLs or technical markers for natural TTS pronunciation
    const clean = text.replace(/https?:\/\/\S+/g, '').replace(/[#*`_]/g, '');
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = 'en-US';
    utterance.onend = () => setSpeakingMessageId(null);
    utterance.onerror = () => setSpeakingMessageId(null);

    setSpeakingMessageId(msgId);
    window.speechSynthesis.speak(utterance);
  };

  const handleSend = async (queryText?: string) => {
    const textToSend = (queryText ?? input).trim();
    if (!textToSend || loading) return;

    setInput('');
    setVoiceNotice(null);

    const userMessage: AssistantMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: textToSend,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setMessages(prev => [...prev, userMessage]);
    setLoading(true);

    try {
      const response = await queryAssistant(textToSend, {
        route: window.location.hash
      });

      const assistantMessage: AssistantMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        text: response.text,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        sources: response.sources,
        links: response.links
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch {
      setMessages(prev => [
        ...prev,
        {
          id: `assistant-err-${Date.now()}`,
          role: 'assistant',
          text: 'Unable to reach the assistant service. Verified observations and maps remain available in the dashboard navigation.',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void handleSend();
  };

  return <>
    {/* Floating Trigger Button */}
    {!open && (
      <button
        ref={launcherRef}
        type="button"
        className="assistant-launcher"
        aria-label="Open ClimateLens assistant"
        aria-expanded={false}
        onClick={() => setOpen(true)}
      >
        <span className="assistant-launcher-icon"><Bot size={18} aria-hidden="true" /></span>
        <span className="assistant-launcher-text">Assistant</span>
      </button>
    )}

    {/* Assistant Slide-Out Panel */}
    {open && (
      <aside
        ref={drawerRef}
        className="assistant-drawer"
        role="dialog"
        aria-label="ClimateLens Assistant"
        aria-modal="false"
      >
        {/* Drawer Header */}
        <header className="assistant-header">
          <div className="assistant-title-group">
            <span className="assistant-avatar"><Compass size={17} aria-hidden="true" /></span>
            <div>
              <div className="assistant-title">ClimateLens Assistant</div>
              <div className="assistant-subtitle">Historical telemetry &amp; evidence guide</div>
            </div>
          </div>
          <div className="assistant-header-actions">
            <span className="assistant-grounded-pill" title="Answers restricted strictly to verified catalog telemetry">
              <span className="status-dot" /> Grounded
            </span>
            <button
              type="button"
              className="assistant-close-btn"
              aria-label="Close assistant"
              onClick={() => {
                setOpen(false);
                launcherRef.current?.focus();
              }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Message Thread */}
        <div className="assistant-thread" role="log" aria-live="polite">
          {messages.map(msg => (
            <div key={msg.id} className={`assistant-bubble-row ${msg.role === 'user' ? 'is-user' : 'is-assistant'}`}>
              <div className="assistant-bubble">
                <div className="assistant-bubble-text"><FormattedText text={msg.text} /></div>
                {msg.sources && msg.sources.length > 0 && (
                  <div className="assistant-sources">
                    <span>Sources:</span>
                    {msg.sources.map(src => (
                      <a key={src} href={`#/sources?source_id=${encodeURIComponent(src)}`} className="assistant-source-tag">
                        {src}
                      </a>
                    ))}
                  </div>
                )}
                {msg.links && msg.links.length > 0 && (
                  <div className="assistant-links">
                    {msg.links.map((link, idx) => (
                      <a key={idx} href={link.href} className="assistant-deeplink-btn" onClick={() => setOpen(false)}>
                        {link.label} →
                      </a>
                    ))}
                  </div>
                )}
                <div className="assistant-bubble-meta">
                  <time>{msg.timestamp}</time>
                  {msg.role === 'assistant' && (
                    <button
                      type="button"
                      className="assistant-tts-btn"
                      title={speakingMessageId === msg.id ? 'Stop speaking' : 'Read message aloud'}
                      aria-label={speakingMessageId === msg.id ? 'Stop speaking' : 'Read message aloud'}
                      onClick={() => speakText(msg.id, msg.text)}
                    >
                      {speakingMessageId === msg.id ? <VolumeX size={13} aria-hidden="true" /> : <Volume2 size={13} aria-hidden="true" />}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}

          {loading && (
            <div className="assistant-bubble-row is-assistant">
              <div className="assistant-bubble assistant-loading">
                <RefreshCw size={13} className="spin" aria-hidden="true" /> Querying verified telemetry…
              </div>
            </div>
          )}

          {/* Quick Prompts on initial conversation */}
          {messages.length === 1 && (
            <div className="assistant-suggestions" aria-label="Suggested questions">
              <div className="assistant-suggestions-title">Suggested questions:</div>
              {QUICK_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  type="button"
                  className="assistant-suggestion-chip"
                  onClick={() => void handleSend(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Voice Status Alert / Notice */}
        {voiceNotice && (
          <div className="assistant-notice" role="status">
            <span>{voiceNotice}</span>
            <button type="button" className="assistant-notice-dismiss" onClick={() => setVoiceNotice(null)}>
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Query Input Bar */}
        <form className="assistant-input-bar" onSubmit={onSubmit}>
          <button
            type="button"
            className={`assistant-mic-btn ${listening ? 'is-listening' : ''}`}
            title={voiceSupported ? (listening ? 'Stop listening' : 'Speak your question') : 'Voice recognition unavailable'}
            aria-label={listening ? 'Stop listening' : 'Speak query using microphone'}
            disabled={!voiceSupported}
            onClick={toggleVoiceInput}
          >
            {listening ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
          </button>
          <input
            ref={inputRef}
            type="text"
            className="assistant-text-input"
            placeholder={listening ? 'Listening…' : 'Ask about states, rainfall, cyclones, or data…'}
            value={input}
            disabled={loading}
            onChange={e => setInput(e.target.value)}
          />
          <button
            type="submit"
            className="assistant-send-btn"
            title="Send query"
            aria-label="Send query"
            disabled={!input.trim() || loading}
          >
            <ArrowUp size={16} aria-hidden="true" />
          </button>
        </form>
      </aside>
    )}
  </>;
}
