import type { ProviderInfo, ScoreboardData, PaymentItem, ScenarioResult, FailureMode } from './types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const API_KEY = import.meta.env.VITE_API_KEY || 'pr_test_engine_key_secret';

if (
  typeof window !== 'undefined' &&
  window.location.hostname !== 'localhost' &&
  window.location.hostname !== '127.0.0.1' &&
  !import.meta.env.VITE_API_URL
) {
  console.warn(
    `[PayRoute UI] ⚠️ VITE_API_URL is not set. API calls are targeting "${API_BASE}". Set VITE_API_URL in your build environment variables to point to your deployed Render backend.`
  );
}

const defaultHeaders = {
  'Content-Type': 'application/json',
  'x-api-key': API_KEY,
};

export async function fetchProviders(): Promise<ProviderInfo[]> {
  const res = await fetch(`${API_BASE}/providers`, { headers: defaultHeaders });
  if (!res.ok) throw new Error('Failed to fetch providers');
  return res.json();
}

export async function updateProvider(
  name: string,
  updates: { enabled?: boolean; priority?: number; cost_bps?: number; timeout_ms?: number }
): Promise<void> {
  const res = await fetch(`${API_BASE}/providers/${name}`, {
    method: 'PATCH',
    headers: defaultHeaders,
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Failed to update provider ${name}`);
}

export async function setProviderMode(
  name: string,
  mode: FailureMode,
  options?: { latencyMs?: number; retryAfterSec?: number }
): Promise<void> {
  const res = await fetch(`${API_BASE}/lab/providers/${name}/mode`, {
    method: 'POST',
    headers: defaultHeaders,
    body: JSON.stringify({ mode, ...options }),
  });
  if (!res.ok) throw new Error(`Failed to set provider mode for ${name}`);
}

export async function fetchSettings(): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/settings`, { headers: defaultHeaders });
  if (!res.ok) throw new Error('Failed to fetch settings');
  return res.json();
}

export async function updateSettings(settings: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${API_BASE}/settings`, {
    method: 'PUT',
    headers: defaultHeaders,
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error('Failed to update settings');
}

export async function startLabRun(params: {
  count: number;
  rate: number;
  method: string;
  hard_decline_share?: number;
  soft_decline_share?: number;
  hardDeclineShare?: number;
  softDeclineShare?: number;
  amount_minor?: number;
}): Promise<{ batch_id: string; status: string }> {
  const hard = params.hard_decline_share ?? params.hardDeclineShare ?? 0;
  const soft = params.soft_decline_share ?? params.softDeclineShare ?? 0;
  const normalizedHard = hard > 1 ? hard / 100 : hard;
  const normalizedSoft = soft > 1 ? soft / 100 : soft;

  const payload = {
    ...params,
    hard_decline_share: normalizedHard,
    soft_decline_share: normalizedSoft,
    hardDeclineShare: normalizedHard,
    softDeclineShare: normalizedSoft,
  };

  try {
    const res = await fetch(`${API_BASE}/lab/runs`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({}));
      throw new Error(errorBody.message || errorBody.error || `HTTP ${res.status}: Failed to start lab run`);
    }
    return res.json();
  } catch (err: any) {
    if (err.message === 'Failed to fetch') {
      throw new Error(`Cannot reach PayRoute backend at ${API_BASE}. Ensure the Render backend is online and VITE_API_URL is configured.`);
    }
    throw err;
  }
}

export async function fetchRunScoreboard(batchId: string): Promise<ScoreboardData> {
  const res = await fetch(`${API_BASE}/lab/runs/${batchId}`, { headers: defaultHeaders });
  if (!res.ok) throw new Error('Failed to fetch run scoreboard');
  return res.json();
}

export async function fetchPayments(filters?: {
  status?: string;
  batchId?: string;
  limit?: number;
}): Promise<PaymentItem[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.batchId) params.set('batch_id', filters.batchId);
  if (filters?.limit) params.set('limit', filters.limit.toString());

  const url = `${API_BASE}/payments?${params.toString()}`;
  const res = await fetch(url, { headers: defaultHeaders });
  if (!res.ok) throw new Error('Failed to fetch payments');
  return res.json();
}

export async function fetchPaymentDetails(id: string): Promise<PaymentItem> {
  const res = await fetch(`${API_BASE}/payments/${id}`, { headers: defaultHeaders });
  if (!res.ok) throw new Error(`Failed to fetch payment ${id}`);
  const data = await res.json();
  const paymentObj = data.payment || data;
  return {
    ...paymentObj,
    id: paymentObj.id || data.id,
    idempotency_key: paymentObj.idempotency_key || paymentObj.idempotencyKey || data.idempotency_key,
    amount_minor: (paymentObj.amount_minor || paymentObj.amountMinor || data.amount_minor || '0').toString(),
    currency: paymentObj.currency || data.currency,
    payment_method: paymentObj.payment_method || paymentObj.paymentMethod || data.payment_method,
    status: paymentObj.status || data.status,
    final_provider: paymentObj.final_provider || paymentObj.finalProvider || data.final_provider || null,
    failure_reason: paymentObj.failure_reason || paymentObj.failureReason || data.failure_reason || null,
    batch_id: paymentObj.batch_id || paymentObj.batchId || data.batch_id || null,
    created_at: paymentObj.created_at || paymentObj.createdAt || data.created_at,
    attempts: data.attempts || paymentObj.attempts || [],
  };
}

export async function runScenario(name: string): Promise<{ batch_id: string }> {
  try {
    const res = await fetch(`${API_BASE}/lab/scenarios/${name}/run`, {
      method: 'POST',
      headers: defaultHeaders,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to start scenario ${name}`);
    return res.json();
  } catch (err: any) {
    if (err.message === 'Failed to fetch') {
      throw new Error(`Cannot reach PayRoute backend at ${API_BASE}. Ensure the Render backend is online and VITE_API_URL is configured.`);
    }
    throw err;
  }
}

export async function fetchScenarioResult(name: string): Promise<ScenarioResult | null> {
  const res = await fetch(`${API_BASE}/lab/scenarios/${name}/results`, { headers: defaultHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch scenario result for ${name}`);
  return res.json();
}

export async function fetchLatestScoreboard(): Promise<ScoreboardData | null> {
  try {
    const res = await fetch(`${API_BASE}/lab/runs/latest`, { headers: defaultHeaders });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export function subscribeToLabStream(onEvent: (event: any) => void): () => void {
  const eventSource = new EventSource(`${API_BASE}/lab/stream?api_key=${API_KEY}`);

  const parseData = (raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && 'data' in parsed && 'type' in parsed) {
        return parsed.data;
      }
      return parsed;
    } catch {
      return raw;
    }
  };

  eventSource.addEventListener('connected', (e) => {
    onEvent({ type: 'connected', data: parseData(e.data) });
  });

  eventSource.addEventListener('payment_completed', (e) => {
    onEvent({ type: 'payment_completed', data: parseData(e.data) });
  });

  eventSource.addEventListener('breaker_transition', (e) => {
    onEvent({ type: 'breaker_transition', data: parseData(e.data) });
  });

  eventSource.addEventListener('scoreboard_update', (e) => {
    onEvent({ type: 'scoreboard_update', data: parseData(e.data) });
  });

  eventSource.addEventListener('scenario_verdict', (e) => {
    onEvent({ type: 'scenario_verdict', data: parseData(e.data) });
  });

  eventSource.onerror = (err) => {
    onEvent({ type: 'error', data: err });
  };

  return () => {
    eventSource.close();
  };
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Sends a message to the PayRoute Assistant, supporting live streaming token callbacks.
 */
export async function sendChatMessage(
  messages: ChatMessage[],
  onChunk?: (chunk: string, fullText: string) => void
): Promise<string> {
  const payload = { messages, stream: Boolean(onChunk) };
  // First try API_BASE, fallback to relative /chat (Vite dev proxy/middleware)
  const endpoints = [`${API_BASE}/chat`, '/chat'];
  let lastError: Error | null = null;

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Chat request failed (${res.status}): ${errorText}`);
      }

      if (onChunk && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            if (trimmed.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(trimmed.slice(6));
                if (parsed.text) {
                  fullText += parsed.text;
                  onChunk(parsed.text, fullText);
                }
              } catch {
                // Ignore framing errors
              }
            }
          }
        }
        return fullText;
      }

      const data = await res.json();
      return data.reply || data.text || '';
    } catch (err: any) {
      lastError = err;
      // If network fails (e.g. localhost:3000 not running), loop to fallback /chat
    }
  }

  throw lastError || new Error('Failed to reach PayRoute Chat service');
}

