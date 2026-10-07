import { useState, useRef, useEffect, useMemo } from 'react';
import type { FC } from 'react';
import {
  Sparkles,
  X,
  Send,
  RotateCcw,
  Bot,
  User,
  Copy,
  Check,
  Terminal,
  GripVertical,
} from 'lucide-react';
import { sendChatMessage } from '../api';
import type { ChatMessage } from '../api';

interface FormattedMessage extends ChatMessage {
  id: string;
  timestamp: string;
  isStreaming?: boolean;
  rejected?: boolean;
}

const QUICK_PROMPTS = [
  'How does PayRoute prevent double charges?',
  'Explain Baseline vs Full policy',
  'How does lowest_cost routing work?',
  'What failure modes does Provider Lab simulate?',
  'How do circuit breakers handle provider outages?',
];

const INITIAL_GREETING: FormattedMessage = {
  id: 'init-1',
  role: 'assistant',
  content: `Hi! How can I help you with PayRoute today?`,
  timestamp: 'Just now',
};

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/**
 * Lightweight markdown parser for technical responses.
 * Formats tables, headers, code blocks, bold text, bullet points, and inline code.
 */
function MarkdownView({ content }: { content: string }) {
  const rendered = useMemo(() => {
    // Strip redundant "Simple Words" or "Technical Quick-Start" meta-headers if present
    const sanitized = content
      .replace(/^(#+\s*)?(\*\*)?Simple\s+Words(\*\*)?[:\s]*/im, '')
      .replace(/^(#+\s*)?(\*\*)?Technical\s+Quick-Start(\*\*)?[:\s]*/im, '')
      .trimStart();

    const lines = sanitized.split('\n');
    const elements: React.ReactNode[] = [];
    let inCodeBlock = false;
    let codeBlockLang = '';
    let codeBlockLines: string[] = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Check for code blocks
      if (line.trim().startsWith('```')) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeBlockLang = line.trim().slice(3).trim();
          codeBlockLines = [];
        } else {
          inCodeBlock = false;
          elements.push(
            <div
              key={`code-${i}`}
              className="my-2 rounded-lg bg-surface-container-lowest border border-outline-variant overflow-hidden"
            >
              {codeBlockLang && (
                <div className="px-3 py-1 bg-surface-container border-b border-outline-variant text-[10px] font-mono text-text-tertiary uppercase flex items-center justify-between">
                  <span className="flex items-center gap-1">
                    <Terminal className="w-3 h-3 text-text-secondary" />
                    {codeBlockLang}
                  </span>
                </div>
              )}
              <pre className="p-2.5 font-mono text-[11px] text-on-surface overflow-x-auto leading-relaxed">
                <code>{codeBlockLines.join('\n')}</code>
              </pre>
            </div>
          );
        }
        i++;
        continue;
      }

      if (inCodeBlock) {
        codeBlockLines.push(line);
        i++;
        continue;
      }

      // Check for Markdown table: starts with | and next line is separator |---|
      if (
        line.trim().startsWith('|') &&
        line.trim().endsWith('|') &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1])
      ) {
        const headerCells = parseTableRow(line);
        i += 2; // skip header and separator row
        const tableRows: string[][] = [];
        while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
          tableRows.push(parseTableRow(lines[i]));
          i++;
        }

        elements.push(
          <div
            key={`table-${i}`}
            className="my-2.5 overflow-x-auto rounded-lg border border-outline-variant bg-surface-container-lowest"
          >
            <table className="w-full text-left text-[11px] border-collapse min-w-[280px]">
              <thead>
                <tr className="bg-surface-container border-b border-outline-variant">
                  {headerCells.map((h, hIdx) => (
                    <th key={hIdx} className="px-2.5 py-1.5 font-semibold text-on-surface text-[11px]">
                      {formatInlineText(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row, rIdx) => (
                  <tr
                    key={rIdx}
                    className="border-b border-outline-variant/30 hover:bg-surface-container-high/30 transition-colors"
                  >
                    {row.map((cell, cIdx) => (
                      <td key={cIdx} className="px-2.5 py-1.5 align-top text-on-surface leading-relaxed">
                        {formatInlineText(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }

      // Horizontal separator
      if (line.trim() === '---' || line.trim() === '***') {
        elements.push(<hr key={`hr-${i}`} className="my-2 border-outline-variant" />);
        i++;
        continue;
      }

      // Headers
      if (line.startsWith('### ')) {
        elements.push(
          <h4 key={`h3-${i}`} className="text-[13px] font-semibold text-on-surface mt-2.5 mb-1">
            {formatInlineText(line.slice(4))}
          </h4>
        );
        i++;
        continue;
      }
      if (line.startsWith('## ')) {
        elements.push(
          <h3 key={`h2-${i}`} className="text-[14px] font-semibold text-on-surface mt-3 mb-1.5 text-primary">
            {formatInlineText(line.slice(3))}
          </h3>
        );
        i++;
        continue;
      }
      if (line.startsWith('# ')) {
        elements.push(
          <h2 key={`h1-${i}`} className="text-[15px] font-bold text-on-surface mt-3 mb-2">
            {formatInlineText(line.slice(2))}
          </h2>
        );
        i++;
        continue;
      }

      // Unordered lists
      if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
        elements.push(
          <li key={`li-${i}`} className="ml-4 list-disc text-on-surface text-[12px] my-0.5 leading-relaxed">
            {formatInlineText(line.trim().slice(2))}
          </li>
        );
        i++;
        continue;
      }

      // Ordered lists
      const orderedMatch = line.trim().match(/^(\d+)\.\s+(.*)/);
      if (orderedMatch) {
        elements.push(
          <div key={`oli-${i}`} className="ml-2 text-on-surface text-[12px] my-0.5 flex gap-1.5 leading-relaxed">
            <span className="font-mono text-text-tertiary select-none">{orderedMatch[1]}.</span>
            <span>{formatInlineText(orderedMatch[2])}</span>
          </div>
        );
        i++;
        continue;
      }

      // Blank line
      if (!line.trim()) {
        elements.push(<div key={`sp-${i}`} className="h-1.5" />);
        i++;
        continue;
      }

      // Standard paragraph
      elements.push(
        <p key={`p-${i}`} className="text-[12px] text-on-surface my-0.5 leading-relaxed">
          {formatInlineText(line)}
        </p>
      );
      i++;
    }

    // Handle unclosed code block
    if (inCodeBlock && codeBlockLines.length > 0) {
      elements.push(
        <div key="unclosed-code" className="my-2 rounded-lg bg-surface-container-lowest border border-outline-variant p-2.5 font-mono text-[11px] text-on-surface overflow-x-auto">
          <code>{codeBlockLines.join('\n')}</code>
        </div>
      );
    }

    return elements;
  }, [content]);

  return <div className="space-y-0.5">{rendered}</div>;
}

/**
 * Formats inline bold text (**...**), italic (*...*), inline code (`...`), and <br> line breaks
 */
function formatInlineText(text: string): React.ReactNode {
  // Support <br> or <br/> tags
  const brParts = text.split(/<br\s*\/?>/gi);
  if (brParts.length > 1) {
    return brParts.map((part, index) => (
      <span key={`br-${index}`}>
        {formatInlineTokens(part)}
        {index < brParts.length - 1 && <br />}
      </span>
    ));
  }
  return formatInlineTokens(text);
}

function formatInlineTokens(text: string): React.ReactNode {
  // Regex to match `code` or **bold** or *italic*
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);

  return tokens.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={i}
          className="px-1 py-0.5 mx-0.5 rounded bg-surface-container-highest border border-outline-variant font-mono text-[11px] text-[#A5B4FC]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="font-semibold text-on-surface">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return (
        <em key={i} className="italic text-on-surface/90">
          {part.slice(1, -1)}
        </em>
      );
    }
    return part;
  });
}

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

function getCornerPosition(
  corner: Corner,
  width = typeof window !== 'undefined' ? window.innerWidth : 1200,
  height = typeof window !== 'undefined' ? window.innerHeight : 800
) {
  const pillWidth = 148;
  const pillHeight = 40;
  const marginX = 20;
  const marginTop = 52;
  const marginBottom = 34;

  switch (corner) {
    case 'top-left':
      return { x: marginX, y: marginTop };
    case 'top-right':
      return { x: Math.max(marginX, width - pillWidth - marginX), y: marginTop };
    case 'bottom-left':
      return { x: marginX, y: Math.max(marginTop, height - pillHeight - marginBottom) };
    case 'bottom-right':
    default:
      return {
        x: Math.max(marginX, width - pillWidth - marginX),
        y: Math.max(marginTop, height - pillHeight - marginBottom),
      };
  }
}

function getNearestCorner(
  currentX: number,
  currentY: number,
  width = typeof window !== 'undefined' ? window.innerWidth : 1200,
  height = typeof window !== 'undefined' ? window.innerHeight : 800
): Corner {
  const midX = width / 2;
  const midY = height / 2;

  const isLeft = currentX < midX;
  const isTop = currentY < midY;

  if (isTop && isLeft) return 'top-left';
  if (isTop && !isLeft) return 'top-right';
  if (!isTop && isLeft) return 'bottom-left';
  return 'bottom-right';
}

export const ChatBot: FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<FormattedMessage[]>([INITIAL_GREETING]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isCopiedId, setIsCopiedId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);

  // Active corner: defaults to 'bottom-right' (origin)
  const [activeCorner, setActiveCorner] = useState<Corner>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('payroute_chat_pill_corner') as Corner | null;
        if (saved && ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(saved)) {
          return saved;
        }
      } catch {}
    }
    return 'bottom-right';
  });

  const [position, setPosition] = useState<{ x: number; y: number }>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('payroute_chat_pill_corner') as Corner | null;
        const corner = (saved && ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(saved))
          ? saved
          : 'bottom-right';
        return getCornerPosition(corner, window.innerWidth, window.innerHeight);
      } catch {}
    }
    return { x: 500, y: 500 };
  });

  const [isDragging, setIsDragging] = useState(false);
  const dragOffsetRef = useRef<{ offsetX: number; offsetY: number }>({ offsetX: 0, offsetY: 0 });

  // Modal drag state
  const modalRef = useRef<HTMLDivElement>(null);
  const [modalPos, setModalPos] = useState<{ x: number; y: number } | null>(null);
  const [isModalDragging, setIsModalDragging] = useState(false);
  const modalDragOffsetRef = useRef<{ offsetX: number; offsetY: number }>({ offsetX: 0, offsetY: 0 });

  // Handle window resizing to keep pill snapped to active corner
  useEffect(() => {
    const handleResize = () => {
      setPosition(getCornerPosition(activeCorner, window.innerWidth, window.innerHeight));
      if (modalPos) {
        setModalPos((prev) => {
          if (!prev) return null;
          return {
            x: Math.min(Math.max(12, prev.x), window.innerWidth - 430),
            y: Math.min(Math.max(12, prev.y), window.innerHeight - 600),
          };
        });
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [activeCorner, modalPos]);

  // Handle-specific pointer events (dragging limited to the dot handle only)
  const handleHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);

    const pillEl = pillRef.current;
    if (!pillEl) return;
    const rect = pillEl.getBoundingClientRect();

    dragOffsetRef.current = {
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };
    setIsDragging(true);
  };

  const handleHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const pillWidth = 148;
    const pillHeight = 40;
    const newX = Math.min(Math.max(12, e.clientX - dragOffsetRef.current.offsetX), window.innerWidth - pillWidth - 12);
    const newY = Math.min(Math.max(12, e.clientY - dragOffsetRef.current.offsetY), window.innerHeight - pillHeight - 12);
    setPosition({ x: newX, y: newY });
  };

  const handleHandlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    setIsDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}

    // Magnetic snap to nearest of the 4 corner zones
    const nearest = getNearestCorner(position.x, position.y, window.innerWidth, window.innerHeight);
    const snapTarget = getCornerPosition(nearest, window.innerWidth, window.innerHeight);
    setPosition(snapTarget);
    setActiveCorner(nearest);
    try {
      localStorage.setItem('payroute_chat_pill_corner', nearest);
    } catch {}
  };

  // Double click on grip handle resets pill back to bottom-right origin
  const handleResetToOrigin = (e: React.MouseEvent) => {
    e.stopPropagation();
    const originPos = getCornerPosition('bottom-right', window.innerWidth, window.innerHeight);
    setPosition(originPos);
    setActiveCorner('bottom-right');
    try {
      localStorage.setItem('payroute_chat_pill_corner', 'bottom-right');
    } catch {}
  };

  // Modal header pointer events
  const handleModalHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.button !== 0) return;

    e.currentTarget.setPointerCapture(e.pointerId);
    const modalEl = modalRef.current;
    if (!modalEl) return;
    const rect = modalEl.getBoundingClientRect();
    modalDragOffsetRef.current = {
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };
    setIsModalDragging(true);
  };

  const handleModalHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isModalDragging) return;
    const modalWidth = Math.min(420, window.innerWidth - 32);
    const modalHeight = Math.min(580, window.innerHeight - 60);

    const newX = Math.min(Math.max(12, e.clientX - modalDragOffsetRef.current.offsetX), window.innerWidth - modalWidth - 12);
    const newY = Math.min(Math.max(12, e.clientY - modalDragOffsetRef.current.offsetY), window.innerHeight - modalHeight - 24);

    setModalPos({ x: newX, y: newY });
  };

  const handleModalHeaderPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isModalDragging) return;
    setIsModalDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  };

  // Compute smart modal position docked relative to the active corner
  const getModalStyle = () => {
    if (modalPos) {
      return {
        left: `${modalPos.x}px`,
        top: `${modalPos.y}px`,
      };
    }

    switch (activeCorner) {
      case 'top-left':
        return {
          left: '20px',
          top: '52px',
        };
      case 'top-right':
        return {
          right: '20px',
          top: '52px',
        };
      case 'bottom-left':
        return {
          left: '20px',
          bottom: '34px',
        };
      case 'bottom-right':
      default:
        return {
          right: '20px',
          bottom: '34px',
        };
    }
  };

  // Reset modal manual drag position on reopen to re-anchor next to pill
  useEffect(() => {
    if (isOpen) {
      setModalPos(null);
    }
  }, [isOpen]);

  // Auto scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
      // Auto focus input after open animation
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen, messages]);

  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend || inputValue).trim();
    if (!text || isLoading) return;

    const userMessage: FormattedMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInputValue('');
    setIsLoading(true);

    // Placeholder for streaming agent response
    const assistantId = `agent-${Date.now()}`;
    const initialAssistantMessage: FormattedMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isStreaming: true,
    };

    setMessages((prev) => [...prev, initialAssistantMessage]);

    // Format chat payload for backend
    const apiPayload: ChatMessage[] = nextMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      const fullResponse = await sendChatMessage(apiPayload, (_chunk, accumulated) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: accumulated, isStreaming: true }
              : m
          )
        );
      });

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: fullResponse || m.content, isStreaming: false }
            : m
        )
      );
    } catch (err: any) {
      console.error('Chat error:', err);
      const errorText =
        err?.message?.includes('401')
          ? 'Authentication error communicating with PayRoute chat endpoint.'
          : err?.message || 'Sorry, I encountered an error while processing your request. Please try again.';

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: errorText,
                isStreaming: false,
                rejected: true,
              }
            : m
        )
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleCopyMessage = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setIsCopiedId(id);
    setTimeout(() => setIsCopiedId(null), 2000);
  };

  const handleClearHistory = () => {
    setMessages([INITIAL_GREETING]);
  };

  return (
    <>
      {/* ── Fixed Floating Rounded Popup Modal ── */}
      <div
        ref={modalRef}
        style={getModalStyle()}
        className={`fixed z-[60] w-[420px] max-w-[calc(100vw-32px)] h-[580px] max-h-[calc(100vh-60px)] flex flex-col rounded-2xl border border-outline-variant bg-[#131313]/95 backdrop-blur-xl shadow-2xl shadow-black/80 transition-all duration-300 ease-out origin-bottom-right ${
          isModalDragging ? 'transition-none select-none' : ''
        } ${
          isOpen
            ? 'scale-100 opacity-100 translate-y-0 pointer-events-auto'
            : 'scale-90 opacity-0 translate-y-6 pointer-events-none'
        }`}
      >
        {/* Modal Header (Draggable) */}
        <div
          onPointerDown={handleModalHeaderPointerDown}
          onPointerMove={handleModalHeaderPointerMove}
          onPointerUp={handleModalHeaderPointerUp}
          className="h-[46px] bg-surface-container-low border-b border-outline-variant px-4 flex items-center justify-between rounded-t-2xl select-none cursor-grab active:cursor-grabbing touch-none"
          title="Drag header to move chat"
        >
          <div className="flex items-center gap-2">
            <GripVertical className="w-3.5 h-3.5 text-text-tertiary mr-0.5" />
            <div className="w-7 h-7 rounded-lg bg-surface-container-high border border-outline-variant flex items-center justify-center text-success relative">
              <Sparkles className="w-4 h-4 text-success" />
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-success ring-2 ring-surface" />
            </div>
            <span className="text-[13px] font-semibold text-on-surface">PayRoute Assistant</span>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={handleClearHistory}
              title="Reset conversation"
              className="p-1.5 rounded-lg text-text-secondary hover:text-on-surface hover:bg-surface-container-high transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setIsOpen(false)}
              title="Close chat"
              className="p-1.5 rounded-lg text-text-secondary hover:text-on-surface hover:bg-surface-container-high transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Messages Body */}
        <div className="flex-1 overflow-y-auto px-3.5 py-3 space-y-3.5 scrollbar-thin">
          {messages.map((msg) => {
            const isUser = msg.role === 'user';
            return (
              <div
                key={msg.id}
                className={`flex gap-2.5 ${isUser ? 'justify-end' : 'justify-start'}`}
              >
                {!isUser && (
                  <div className="w-6 h-6 rounded-md bg-surface-container-high border border-outline-variant flex items-center justify-center shrink-0 mt-0.5 text-success">
                    <Bot className="w-3.5 h-3.5" />
                  </div>
                )}

                <div
                  className={`group relative max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[12px] leading-relaxed transition-all ${
                    isUser
                      ? 'bg-surface-container-high text-on-surface border border-outline-variant/70 rounded-br-xs'
                      : msg.rejected
                      ? 'bg-error/10 text-on-surface border border-error/40 rounded-bl-xs'
                      : 'bg-surface-container-low text-on-surface border border-outline-variant/50 rounded-bl-xs'
                  }`}
                >
                  {/* Message Content */}
                  <MarkdownView content={msg.content} />

                  {/* Streaming indicator cursor */}
                  {msg.isStreaming && (
                    <span className="inline-block w-1.5 h-3.5 bg-success ml-1 align-middle animate-pulse" />
                  )}

                  {/* Action row (time & copy) */}
                  {!msg.isStreaming && msg.content && (
                    <div className="mt-1 flex items-center justify-between text-[10px] text-text-tertiary select-none pt-1">
                      <span>{msg.timestamp}</span>
                      {!isUser && (
                        <button
                          onClick={() => handleCopyMessage(msg.id, msg.content)}
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:text-on-surface ml-2"
                          title="Copy response"
                        >
                          {isCopiedId === msg.id ? (
                            <Check className="w-3 h-3 text-success" />
                          ) : (
                            <Copy className="w-3 h-3 text-text-tertiary" />
                          )}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {isUser && (
                  <div className="w-6 h-6 rounded-md bg-surface-container-highest border border-outline-variant flex items-center justify-center shrink-0 mt-0.5 text-text-secondary">
                    <User className="w-3.5 h-3.5" />
                  </div>
                )}
              </div>
            );
          })}

          {/* Loading Animation Placeholder (Before stream tokens arrive) */}
          {isLoading &&
            messages.length > 0 &&
            messages[messages.length - 1].role === 'assistant' &&
            !messages[messages.length - 1].content && (
              <div className="flex gap-2.5 justify-start">
                <div className="w-6 h-6 rounded-md bg-surface-container-high border border-outline-variant flex items-center justify-center shrink-0 mt-0.5 text-success animate-pulse">
                  <Bot className="w-3.5 h-3.5" />
                </div>
                <div className="bg-surface-container-low border border-outline-variant/50 rounded-2xl rounded-bl-xs px-3.5 py-2.5 flex items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-success animate-bounce [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-success animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-success animate-bounce [animation-delay:300ms]" />
                  </div>
                  <span className="text-[11px] text-text-secondary font-mono animate-pulse">
                    PayRoute reasoning...
                  </span>
                </div>
              </div>
            )}

          <div ref={messagesEndRef} />
        </div>

        {/* Quick Suggestion Chips (Shown on fresh conversations) */}
        {messages.length <= 2 && !isLoading && (
          <div className="px-3.5 py-1.5 border-t border-outline-variant/30 bg-surface-container-lowest/50">
            <div className="text-[10px] font-mono text-text-tertiary mb-1.5 flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-warning" />
              <span>Suggested questions:</span>
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-[82px] overflow-y-auto">
              {QUICK_PROMPTS.map((prompt, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSendMessage(prompt)}
                  className="text-left text-[11px] px-2.5 py-1 rounded-full bg-surface-container border border-outline-variant/60 text-text-secondary hover:text-on-surface hover:bg-surface-container-high hover:border-outline transition-all"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Input Bar */}
        <div className="p-3 bg-surface-container-lowest border-t border-outline-variant rounded-b-2xl">
          <div className="flex items-end gap-2 bg-surface-container border border-outline-variant focus-within:border-success/60 rounded-xl px-3 py-1.5 transition-colors">
            <textarea
              ref={inputRef}
              rows={1}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question..."
              disabled={isLoading}
              className="flex-1 bg-transparent text-on-surface text-[12px] placeholder:text-text-tertiary resize-none focus:outline-none max-h-24 py-1 leading-relaxed"
            />
            <button
              onClick={() => handleSendMessage()}
              disabled={isLoading || !inputValue.trim()}
              className={`p-1.5 rounded-lg flex items-center justify-center transition-all ${
                inputValue.trim() && !isLoading
                  ? 'bg-primary text-on-primary hover:bg-on-surface cursor-pointer'
                  : 'bg-surface-container-highest text-text-tertiary cursor-not-allowed opacity-60'
              }`}
              title="Send message (Enter)"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* ── Floatable Rounded Trigger Button (FAB) ── */}
      {!isOpen && (
        <div
          ref={pillRef}
          style={{
            left: `${position.x}px`,
            top: `${position.y}px`,
          }}
          className={`fixed z-[60] h-10 rounded-full bg-[#1c1b1b] hover:bg-[#252424] text-on-surface border border-outline-variant shadow-lg shadow-black/80 flex items-center select-none group touch-none ${
            isDragging
              ? 'scale-105 shadow-2xl ring-1 ring-success/60 transition-none'
              : 'transition-all duration-300 ease-out'
          }`}
        >
          {/* Draggable Dot Handle (Only this left-most dot part initiates drag) */}
          <div
            onPointerDown={handleHandlePointerDown}
            onPointerMove={handleHandlePointerMove}
            onPointerUp={handleHandlePointerUp}
            onDoubleClick={handleResetToOrigin}
            className="flex items-center justify-center py-2.5 pl-3 pr-1.5 rounded-l-full text-text-tertiary hover:text-on-surface hover:bg-white/5 cursor-grab active:cursor-grabbing select-none touch-none group/grip transition-colors"
            title="Drag dots to snap to 4 corners (top-left, top-right, bottom-left, bottom-right) • Double-click to reset to origin"
          >
            <GripVertical className="w-3.5 h-3.5 transition-transform group-hover/grip:scale-110" />
          </div>

          {/* Clickable Pill Body (Hover shows pointer, clicking opens chat) */}
          <button
            type="button"
            onClick={() => setIsOpen(true)}
            className="flex items-center gap-2 py-2 pr-3.5 pl-1 rounded-r-full text-on-surface cursor-pointer select-none focus:outline-none transition-transform active:scale-95"
            title="Open PayRoute AI Assistant"
          >
            <div className="relative flex items-center justify-center shrink-0">
              <Sparkles className="w-4 h-4 text-success" />
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-success animate-ping" />
            </div>
            <span className="text-[12px] font-semibold text-on-surface whitespace-nowrap">PayRoute AI</span>
          </button>
        </div>
      )}
    </>
  );
};

export default ChatBot;
