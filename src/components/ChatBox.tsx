import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare, Send } from 'lucide-react';
import type { ChatMessage } from '../shared/gameConstants.ts';

interface ChatBoxProps {
  messages: ChatMessage[];
  myPlayerId: string;
  onSendMessage: (text: string) => Promise<void>;
  compact?: boolean;
}

const QUICK_REPLIES = ['Good luck!', 'Nice roll!', 'So close!', 'GG!'];

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export const ChatBox: React.FC<ChatBoxProps> = ({
  messages,
  myPlayerId,
  onSendMessage,
  compact = false,
}) => {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  const sendText = async (textToSend: string) => {
    const trimmed = textToSend.replace(/\s+/g, ' ').trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSendMessage(trimmed);
      if (textToSend === draft) {
        setDraft('');
      }
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await sendText(draft);
  };

  return (
    <div
      className={`rounded-2xl bg-[#111827]/90 border border-slate-800 ${
        compact ? 'p-3.5' : 'p-4 sm:p-5'
      } flex flex-col gap-3`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare className="w-4 h-4 text-amber-400 shrink-0" />
          <h2 className="text-sm font-semibold text-slate-100 truncate">
            Room Chat
          </h2>
        </div>
        <span className="font-mono-code text-xs text-slate-500 shrink-0">
          {messages.length} {messages.length === 1 ? 'msg' : 'msgs'}
        </span>
      </div>

      {/* Scrollable Messages */}
      <div
        ref={listRef}
        className={`${
          compact ? 'h-36' : 'h-44'
        } overflow-y-auto space-y-2 rounded-xl bg-slate-950/60 border border-slate-800/80 p-2.5`}
      >
        {messages.length === 0 ? (
          <p className="text-xs text-slate-500 text-center py-10">
            Send a quick message while playing or talking.
          </p>
        ) : (
          messages.map((msg) => {
            const isMe = msg.playerId === myPlayerId;
            return (
              <div
                key={msg.id}
                className={`flex flex-col ${
                  isMe ? 'items-end' : 'items-start'
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-relaxed ${
                    isMe
                      ? 'bg-amber-500/15 border border-amber-400/30 text-amber-50'
                      : 'bg-slate-800/90 border border-slate-700/70 text-slate-100'
                  }`}
                >
                  <div className="flex items-center gap-2 text-[10px] mb-0.5 text-slate-400">
                    <span className="font-semibold text-slate-300">
                      {isMe ? 'You' : msg.nickname}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono-code">
                      {formatTime(msg.timestamp)}
                    </span>
                  </div>
                  <p className="break-words">{msg.text}</p>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Quick Tap Phrases */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
        {QUICK_REPLIES.map((phrase) => (
          <button
            key={phrase}
            type="button"
            disabled={sending}
            onClick={() => void sendText(phrase)}
            className="min-h-[32px] px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[11px] font-medium text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            {phrase}
          </button>
        ))}
      </div>

      {/* Input Form */}
      <form onSubmit={(e) => void handleSubmit(e)} className="flex items-center gap-2">
        <label htmlFor="room-chat-input" className="sr-only">
          Type a message
        </label>
        <input
          id="room-chat-input"
          type="text"
          maxLength={280}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a message..."
          className="flex-1 min-w-0 min-h-[44px] px-3.5 rounded-xl bg-slate-900/90 border border-slate-700 focus:border-amber-400 focus:outline-none text-sm text-white placeholder:text-slate-500 transition-colors"
        />
        <button
          type="submit"
          disabled={sending || draft.trim().length === 0}
          aria-label="Send message"
          className="min-w-[44px] min-h-[44px] px-3.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-slate-950 font-bold inline-flex items-center justify-center transition-colors shrink-0 cursor-pointer"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
};
