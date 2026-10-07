import { useState, useEffect } from 'react';
import type { FC } from 'react';
import {
  Fingerprint,
  Copy,
  Download,
  CreditCard,
  GitBranch,
  ArrowRight,
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
  Layers,
  SearchX,
  Search,
  RefreshCw,
} from 'lucide-react';
import type { PaymentItem, PaymentAttempt } from '../types';
import { fetchPayments, fetchPaymentDetails } from '../api';

export const PaymentTracePage: FC = () => {
  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [selectedPayment, setSelectedPayment] = useState<PaymentItem | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [expandedAttempts, setExpandedAttempts] = useState<Record<string, boolean>>({});
  const [viewMode, setViewMode] = useState<'Timeline' | 'Compact' | 'JSON'>('Timeline');

  useEffect(() => {
    loadPayments();
  }, [statusFilter]);

  const handleDownloadJson = () => {
    if (!selectedPayment) return;
    const blob = new Blob([JSON.stringify(selectedPayment, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payment-${selectedPayment.id}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const loadPayments = async () => {
    setLoading(true);
    try {
      const data = await fetchPayments({
        status: statusFilter || undefined,
        limit: 50,
      });
      setPayments(data);
      if (data.length > 0 && !selectedPayment) {
        selectPayment(data[0].id);
      }
    } catch (err: any) {
      console.error('Failed to load payments:', err);
    } finally {
      setLoading(false);
    }
  };

  const selectPayment = async (id: string) => {
    try {
      const full = await fetchPaymentDetails(id);
      setSelectedPayment(full);
      // Auto-expand attempts that are failed or the last attempt
      if (full.attempts) {
        const initialExpanded: Record<string, boolean> = {};
        full.attempts.forEach((att, idx) => {
          const isLast = idx === full.attempts!.length - 1;
          if (isLast || att.status === 'failed' || att.status === 'unknown') {
            initialExpanded[att.id || String(idx)] = true;
          }
        });
        setExpandedAttempts(initialExpanded);
      }
    } catch (err) {
      console.error('Failed to select payment:', err);
    }
  };

  const filteredPayments = payments.filter((p) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const id = (p.id || '').toLowerCase();
    const key = (p.idempotency_key || (p as any).idempotencyKey || '').toLowerCase();
    const provider = (p.final_provider || (p as any).finalProvider || '').toLowerCase();
    return id.includes(q) || key.includes(q) || provider.includes(q);
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'succeeded':
        return (
          <span className="h-5 px-1.5 rounded flex items-center gap-1 font-sans text-[10px] font-medium bg-[rgba(74,222,128,0.08)] border border-[rgba(74,222,128,0.3)] text-success">
            <span className="w-1.5 h-1.5 rounded-sm bg-success"></span>succeeded
          </span>
        );
      case 'failed':
        return (
          <span className="h-5 px-1.5 rounded flex items-center gap-1 font-sans text-[10px] font-medium bg-[rgba(248,113,113,0.12)] border border-[rgba(248,113,113,0.3)] text-error">
            <span className="w-1.5 h-1.5 rounded-sm bg-error"></span>failed
          </span>
        );
      case 'unknown':
        return (
          <span className="h-5 px-1.5 rounded flex items-center gap-1 font-sans text-[10px] font-medium bg-[rgba(251,191,36,0.15)] border border-[rgba(251,191,36,0.4)] text-warning">
            <span className="w-1.5 h-1.5 rounded-sm bg-warning"></span>needs review
          </span>
        );
      case 'processing':
        return (
          <span className="h-5 px-1.5 rounded flex items-center gap-1 font-sans text-[10px] font-medium bg-surface-container-highest border border-outline-variant text-on-surface">
            <span className="w-1.5 h-1.5 rounded-sm bg-on-surface"></span>processing
          </span>
        );
      default:
        return (
          <span className="h-5 px-1.5 rounded flex items-center gap-1 font-sans text-[10px] font-medium bg-surface-container-highest border border-outline-variant text-on-surface">
            {status ? status : 'created'}
          </span>
        );
    }
  };

  const getPlainExplanation = (attempt: PaymentAttempt, _isLast: boolean): string => {
    const errorClass = attempt.error_class || (attempt as any).errorClass;
    const latencyMs = attempt.latency_ms ?? (attempt as any).latencyMs ?? 0;
    const providerRef = attempt.provider_ref || (attempt as any).providerRef || 'ok';

    if (attempt.status === 'succeeded') {
      return `Charge succeeded on ${attempt.provider} in ${latencyMs}ms. Provider confirmed transaction with reference ${providerRef}. Zero double charge verified.`;
    }

    if (errorClass === 'ambiguous') {
      return `Attempt on ${attempt.provider} timed out or lost connection. PayRoute immediately queried provider status via idempotency reference. Confirmed not charged; safe to failover.`;
    }

    if (errorClass === 'hard_decline') {
      return `Customer card was declined by issuing bank (insufficient funds / stolen card). Non-retryable error; payment failed permanently without double-attempting.`;
    }

    if (errorClass === 'soft_decline') {
      return `Card issuer network temporarily unavailable on ${attempt.provider}. Safe cascade triggered to alternate provider.`;
    }

    if (errorClass === 'not_sent') {
      return `Network connection failure or DNS timeout before request reached ${attempt.provider}. Failed over immediately to next provider.`;
    }

    if (errorClass === 'rate_limited') {
      return `Provider ${attempt.provider} returned HTTP 429 Rate Limited. Backoff window evaluated against remaining synchronous deadline.`;
    }

    if (errorClass === 'transient_known') {
      return `Provider returned transient error confirmed as not processed. Retried under jittered exponential backoff.`;
    }

    return `Attempt failed with ${errorClass || 'error'}. Router evaluated fallback providers.`;
  };

  const toggleAttempt = (id: string) => {
    setExpandedAttempts((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  return (
    <div className="flex w-full h-[calc(100vh-40px)] text-on-surface font-sans">
      {/* Left Panel (Payment List) */}
      <div className="w-[320px] bg-surface-container-low border-r border-outline-variant/30 flex flex-col flex-shrink-0">
        <div className="p-3 border-b border-outline-variant/30 bg-surface-container-lowest">
          <div className="flex items-center gap-2 mb-2">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-outline absolute left-2 top-2" />
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-[28px] bg-surface-container border border-outline-variant/40 rounded px-7 font-mono text-[12px] text-on-surface placeholder:text-outline focus:outline-none focus:border-outline"
              />
            </div>
            <button
              onClick={loadPayments}
              disabled={loading}
              className="h-[28px] px-2 bg-surface-container border border-outline-variant/40 hover:bg-surface-container-high rounded text-outline hover:text-on-surface flex items-center justify-center transition-colors"
              title="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="w-full h-[28px] bg-surface-container border border-outline-variant/40 rounded px-2 font-mono text-[12px] text-on-surface focus:outline-none focus:border-outline"
          >
            <option value="">All Statuses</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="unknown">Unknown</option>
            <option value="processing">Processing</option>
          </select>
        </div>
        
        <div className="flex-1 overflow-y-auto">
          {filteredPayments.map((p) => {
            const isSelected = selectedPayment?.id === p.id;
            const amt = Number(p.amount_minor || (p as any).amountMinor || 0);
            return (
              <div
                key={p.id}
                onClick={() => selectPayment(p.id)}
                className={`h-[44px] px-3 flex items-center justify-between cursor-pointer border-b border-outline-variant/10 hover:bg-surface-container-low transition-colors ${
                  isSelected ? 'bg-surface-container-high/40 border-l-2 border-l-on-surface' : 'border-l-2 border-l-transparent'
                }`}
              >
                <div className="flex flex-col min-w-0 flex-1 pr-2">
                  <div className="flex items-center gap-1.5">
                    {p.status === 'succeeded' ? (
                      <span className="w-1.5 h-1.5 rounded-sm bg-success flex-shrink-0" />
                    ) : p.status === 'failed' ? (
                      <span className="w-1.5 h-1.5 rounded-sm bg-error flex-shrink-0" />
                    ) : p.status === 'unknown' ? (
                      <span className="w-1.5 h-1.5 rounded-sm bg-warning flex-shrink-0" />
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-sm bg-on-surface flex-shrink-0" />
                    )}
                    <span className="font-mono text-[11px] text-on-surface truncate">
                      {p.id}
                    </span>
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <span className="font-mono text-[11px] text-on-surface block">
                    {(amt / 100).toFixed(2)}
                  </span>
                  <span className="font-sans text-[10px] text-outline uppercase">
                    {p.currency}
                  </span>
                </div>
              </div>
            );
          })}
          
          {!loading && filteredPayments.length === 0 && (
            <div className="text-center p-4 text-[12px] text-outline font-mono">
              No payments found
            </div>
          )}
        </div>
      </div>

      {/* Right Panel (Detail & Trace) */}
      <div className="flex-1 bg-surface overflow-y-auto">
        {selectedPayment ? (
          <div className="px-6 py-6 space-y-6">
            {/* Payment Header Block */}
            <div className="border-b border-outline-variant/30 pb-6">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="flex items-center gap-1.5 bg-surface-container-high px-2 py-0.5 border border-outline-variant/40 rounded-md">
                    <Fingerprint className="w-4 h-4 text-outline" />
                    <span className="font-mono text-[13px] text-on-surface select-all tracking-tight">
                      {selectedPayment.id}
                    </span>
                    <button
                      className="hover:text-primary text-outline transition-colors p-0.5 rounded ml-1"
                      onClick={() => navigator.clipboard.writeText(selectedPayment.id)}
                      title="Copy payment ID"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {getStatusBadge(selectedPayment.status)}
                </div>
                
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleDownloadJson}
                    className="h-[28px] px-2.5 bg-surface-container border border-outline-variant/40 hover:bg-surface-container-high text-on-surface text-[12px] flex items-center gap-1.5 transition-colors rounded-md cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5 text-outline" />
                    Download JSON
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-on-surface-variant">
                <span className="font-mono text-[14px] text-on-surface font-semibold">
                  {selectedPayment.currency} {(Number(selectedPayment.amount_minor || (selectedPayment as any).amountMinor || 0) / 100).toFixed(2)}
                </span>
                <span className="text-outline-variant/60">|</span>
                <span className="flex items-center gap-1 text-on-surface">
                  <CreditCard className="w-3.5 h-3.5 text-outline" />
                  {selectedPayment.payment_method || (selectedPayment as any).paymentMethod}
                </span>
                <span className="text-outline-variant/60">|</span>
                <span className="flex items-center gap-1">
                  <span className="text-outline">idempotency key</span>
                  <code className="font-mono text-[11px] text-on-surface bg-surface-container-high px-1 border border-outline-variant/30 rounded">
                    {selectedPayment.idempotency_key?.substring(0, 8) || (selectedPayment as any).idempotencyKey?.substring(0, 8)}...
                  </code>
                  <button
                    className="hover:text-primary text-outline transition-colors"
                    onClick={() => navigator.clipboard.writeText(selectedPayment.idempotency_key || (selectedPayment as any).idempotencyKey)}
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                </span>
                <span className="text-outline-variant/60">|</span>
                <span>
                  batch <span className="font-mono text-on-surface">{selectedPayment.batch_id || (selectedPayment as any).batchId || '-'}</span>
                </span>
                <span className="text-outline-variant/60">|</span>
                <span>
                  created <span className="font-mono text-on-surface">{new Date(selectedPayment.created_at).toLocaleTimeString()}</span>
                </span>
                <span className="text-outline-variant/60">|</span>
                <span className="px-1.5 py-0.5 bg-surface-container border border-outline-variant/30 text-on-surface rounded">
                  {selectedPayment.attempts?.length || 0} attempts
                </span>
              </div>
            </div>

            {/* View Switch & Attempts Section Header */}
            <div className="flex items-center justify-between border-b border-outline-variant/20 pb-2">
              <div className="flex items-center gap-2">
                <GitBranch className="w-4 h-4 text-outline" />
                <h2 className="text-[16px] text-on-surface font-semibold">Attempts</h2>
                <span className="text-outline text-[10px] uppercase tracking-wider ml-2">execution breakdown &amp; routing logic</span>
              </div>
              <div className="flex h-[28px] bg-surface-container-lowest border border-outline-variant/40 rounded-lg p-0.5 gap-0.5">
                <button
                  onClick={() => setViewMode('Timeline')}
                  className={`px-3 flex items-center text-[10px] uppercase font-medium transition-colors rounded-md ${
                    viewMode === 'Timeline' ? 'bg-surface-container-highest text-on-surface border border-outline-variant/50' : 'text-outline hover:text-on-surface hover:bg-surface-container'
                  }`}
                >
                  Timeline
                </button>
                <button
                  onClick={() => setViewMode('Compact')}
                  className={`px-3 flex items-center text-[10px] uppercase font-medium transition-colors rounded-md ${
                    viewMode === 'Compact' ? 'bg-surface-container-highest text-on-surface border border-outline-variant/50' : 'text-outline hover:text-on-surface hover:bg-surface-container'
                  }`}
                >
                  Compact
                </button>
                <button
                  onClick={() => setViewMode('JSON')}
                  className={`px-3 flex items-center text-[10px] uppercase font-medium transition-colors rounded-md ${
                    viewMode === 'JSON' ? 'bg-surface-container-highest text-on-surface border border-outline-variant/50' : 'text-outline hover:text-on-surface hover:bg-surface-container'
                  }`}
                >
                  JSON
                </button>
              </div>
            </div>

            {/* Attempt Timeline Section */}
            {viewMode === 'Timeline' && selectedPayment.attempts && selectedPayment.attempts.length > 0 && (
              <div className="border border-outline-variant/30 bg-surface-container-lowest p-4 space-y-4 rounded-xl">
                {selectedPayment.attempts.map((att, idx) => {
                  const isLast = idx === selectedPayment.attempts!.length - 1;
                  const attemptNo = att.attempt_no ?? (att as any).attemptNo ?? (idx + 1);
                  const latencyMs = att.latency_ms ?? (att as any).latencyMs ?? 0;
                  const errorClass = att.error_class ?? (att as any).errorClass;
                  const trace: any = att.decision_trace || (att as any).decisionTrace;
                  const candidates: any[] = trace?.candidates || [];
                  const attKey = att.id || String(idx);
                  const isExpanded = !!expandedAttempts[attKey];

                  // Status-based styling for the left accent
                  let accentColor = 'bg-outline-variant/40';
                  if (att.status === 'succeeded') accentColor = 'bg-success';
                  else if (att.status === 'failed') accentColor = 'bg-error';
                  else if (att.status === 'unknown') accentColor = 'bg-warning';

                  return (
                    <div key={attKey} className="space-y-3">
                      {/* Connector logic (if not first attempt) */}
                      {idx > 0 && (
                        <div className="relative pl-6 py-2 border-l border-dashed border-outline-variant/50 ml-4 space-y-1.5">
                          <div className="flex items-center gap-2 text-on-surface-variant text-[12px]">
                            <ArrowRightLeft className="w-3.5 h-3.5 text-outline" />
                            <span>
                              Failed over to <span className="text-on-surface font-medium capitalize">{att.provider}</span>.
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Attempt Row */}
                      <div className="p-3 bg-surface-container hover:bg-surface-container-high transition-colors border border-outline-variant/20 rounded-lg overflow-hidden relative">
                        <div className={`absolute left-0 top-0 bottom-0 w-1 ${accentColor}`}></div>
                        <div className="pl-3">
                          <div className="flex flex-wrap items-center justify-between gap-2 mb-2 text-[12px]">
                            <div className="flex items-center gap-3">
                              <span className="text-[13px] font-medium text-on-surface">Attempt {attemptNo}</span>
                              <span className="text-on-surface-variant font-medium capitalize">{att.provider}</span>
                              
                              {errorClass && (
                                <>
                                  <ArrowRight className="w-3.5 h-3.5 text-outline" />
                                  <span className="h-[18px] px-1.5 text-[10px] uppercase font-medium bg-surface-container-highest border border-outline-variant/40 text-on-surface-variant rounded flex items-center">
                                    {errorClass}
                                  </span>
                                </>
                              )}
                              
                              <div className="ml-2">{getStatusBadge(att.status)}</div>
                            </div>
                            
                            <div className="flex items-center gap-4 text-outline">
                              <span className="font-mono text-[11px] text-on-surface">{latencyMs} ms</span>
                              {att.provider_ref && (
                                <span className="flex items-center gap-1 font-mono text-[11px]">
                                  {att.provider_ref}
                                  <button
                                    className="hover:text-primary transition-colors p-0.5 rounded"
                                    onClick={() => navigator.clipboard.writeText(att.provider_ref as string)}
                                    title="Copy provider ref"
                                  >
                                    <Copy className="w-3 h-3" />
                                  </button>
                                </span>
                              )}
                            </div>
                          </div>
                          
                          {/* Plain Language Explanation */}
                          <div className="mt-3 bg-surface-container-lowest/60 p-2.5 rounded border border-outline-variant/30 text-[12px] text-on-surface-variant leading-relaxed">
                            {getPlainExplanation(att, isLast)}
                          </div>
                        </div>
                      </div>

                      {/* Decision Trace Accordion */}
                      {candidates.length > 0 && (
                        <div className="ml-8 border border-outline-variant/30 bg-surface-container p-2 rounded-lg">
                          <div 
                            className="flex items-center justify-between cursor-pointer select-none hover:bg-surface-container-high transition-colors p-1.5 rounded"
                            onClick={() => toggleAttempt(attKey)}
                          >
                            <div className="flex items-center gap-1.5">
                              {isExpanded ? <ChevronDown className="w-4 h-4 text-on-surface" /> : <ChevronRight className="w-4 h-4 text-outline" />}
                              <span className="text-[13px] font-semibold text-on-surface">Decision trace for attempt {attemptNo}</span>
                              <span className="text-outline text-[12px] ml-2">— {trace?.strategy || 'strategy weighted'}</span>
                            </div>
                          </div>
                          
                          {isExpanded && (
                            <div className="mt-3 overflow-x-auto pb-1">
                              <table className="w-full text-left text-[11px] whitespace-nowrap">
                                <thead>
                                  <tr className="h-8 border-b border-outline-variant/30 text-outline uppercase tracking-wider">
                                    <th className="px-2 font-medium">Provider</th>
                                    <th className="px-2 font-medium">Eligible</th>
                                    <th className="px-2 font-medium">Reason</th>
                                    <th className="px-2 text-right font-medium">Success</th>
                                    <th className="px-2 text-right font-medium">p95</th>
                                    <th className="px-2 text-right font-medium">Score</th>
                                    <th className="px-2 text-center font-medium">Chosen</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-outline-variant/20 font-mono">
                                  {candidates.map((cand) => {
                                    const isChosen = cand.provider === att.provider;
                                    const smoothed = cand.smoothedSuccessRate ?? cand.smoothed_success_rate ?? 0;
                                    const p95 = cand.p95LatencyMs ?? cand.p95_latency_ms ?? 0;
                                    const exclusion = cand.exclusionReason ?? cand.exclusion_reason;
                                    
                                    return (
                                      <tr key={cand.provider} className={`h-8 ${isChosen ? 'bg-surface-container-high/60 text-on-surface' : 'hover:bg-surface-container-high/30 text-on-surface-variant'}`}>
                                        <td className="px-2 font-medium flex items-center gap-1.5 pt-2 capitalize">
                                          {isChosen && <span className="w-1.5 h-1.5 bg-success rounded-sm"></span>}
                                          {cand.provider}
                                        </td>
                                        <td className={`px-2 ${cand.eligible ? 'text-success' : 'text-outline'}`}>
                                          {cand.eligible ? 'yes' : 'no'}
                                        </td>
                                        <td className={`px-2 ${exclusion ? 'text-error' : 'text-outline'}`}>
                                          {exclusion || '-'}
                                        </td>
                                        <td className="px-2 text-right">{(smoothed * 100).toFixed(1)}%</td>
                                        <td className="px-2 text-right">{p95} ms</td>
                                        <td className="px-2 text-right">{cand.score !== undefined ? cand.score.toFixed(2) : '-'}</td>
                                        <td className="px-2 text-center">
                                          {isChosen ? (
                                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-primary text-on-primary font-sans text-[10px] font-semibold rounded uppercase">
                                              chosen
                                            </span>
                                          ) : (
                                            <span className="text-outline">-</span>
                                          )}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Compact View */}
            {viewMode === 'Compact' && selectedPayment.attempts && selectedPayment.attempts.length > 0 && (
              <div className="border border-outline-variant/30 bg-surface-container-lowest p-3 rounded-xl overflow-x-auto">
                <table className="w-full text-left text-[11px] whitespace-nowrap">
                  <thead>
                    <tr className="h-8 border-b border-outline-variant/30 text-outline uppercase tracking-wider">
                      <th className="px-2 font-medium">Attempt</th>
                      <th className="px-2 font-medium">Provider</th>
                      <th className="px-2 font-medium">Status</th>
                      <th className="px-2 font-medium">Error Class</th>
                      <th className="px-2 text-right font-medium">Latency</th>
                      <th className="px-2 font-medium">Routing Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/20 font-mono">
                    {selectedPayment.attempts.map((att, idx) => {
                      const attemptNo = att.attempt_no ?? (att as any).attemptNo ?? (idx + 1);
                      const latencyMs = att.latency_ms ?? (att as any).latencyMs ?? 0;
                      const errorClass = att.error_class ?? (att as any).errorClass;
                      const routingReason = att.routing_reason ?? (att as any).routingReason ?? '-';
                      return (
                        <tr key={att.id || idx} className="h-8 hover:bg-surface-container-high/30">
                          <td className="px-2 font-medium">Attempt {attemptNo}</td>
                          <td className="px-2 capitalize font-medium text-on-surface">{att.provider}</td>
                          <td className="px-2">{getStatusBadge(att.status)}</td>
                          <td className="px-2">{errorClass ? <span className="uppercase text-text-secondary">{errorClass}</span> : '-'}</td>
                          <td className="px-2 text-right">{latencyMs} ms</td>
                          <td className="px-2 text-on-surface-variant font-sans text-[11px] truncate max-w-xs">{routingReason}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* JSON View */}
            {viewMode === 'JSON' && (
              <div className="border border-outline-variant/30 bg-surface-container-lowest p-4 rounded-xl">
                <pre className="font-mono text-[11px] text-on-surface overflow-x-auto max-h-[500px]">
                  {JSON.stringify(selectedPayment, null, 2)}
                </pre>
              </div>
            )}
            
            {/* Contextual Variants Section (bottom grid) */}
            <div className="pt-6 border-t border-outline-variant/30 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-outline" />
                  <h3 className="text-[16px] text-on-surface font-semibold">Trace state visualizer</h3>
                </div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {selectedPayment.status === 'processing' && (
                  <div className="border border-outline-variant/30 bg-surface-container p-4 flex flex-col justify-between rounded-xl">
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-semibold text-[13px] text-on-surface">Payment still processing</span>
                        {getStatusBadge('processing')}
                      </div>
                      <p className="text-[11px] text-outline mb-3">Live transaction actively resolving against third-party webhook.</p>
                    </div>
                    <div className="mt-4 pt-2 border-t border-outline-variant/20 flex items-center gap-1.5 font-mono text-[11px] text-on-surface">
                      <span className="w-2 h-2 rounded-sm bg-primary animate-pulse inline-block"></span>
                      Updating live
                    </div>
                  </div>
                )}
                
                {selectedPayment.status === 'unknown' && (
                  <div className="border border-warning/30 bg-surface-container p-4 flex flex-col justify-between rounded-xl">
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-semibold text-[13px] text-on-surface">Payment unknown</span>
                        {getStatusBadge('unknown')}
                      </div>
                      <div className="p-2 border border-warning/40 bg-warning/10 text-on-surface text-[11px] leading-relaxed mb-2 rounded-lg">
                        Outcome not confirmed. The engine is checking provider status and will not retry elsewhere until it knows.
                      </div>
                    </div>
                  </div>
                )}
                
                {(!selectedPayment.attempts || selectedPayment.attempts.length === 0) && (
                   <div className="border border-outline-variant/30 bg-surface-container p-4 flex flex-col items-center text-center rounded-xl justify-center h-[140px]">
                     <SearchX className="w-6 h-6 text-outline mb-2" />
                     <div className="text-[13px] text-on-surface-variant font-medium">No attempts recorded</div>
                   </div>
                )}
              </div>
            </div>

            {/* Footer Lab Disclaimer */}
            <div className="flex items-center justify-between pt-2 border-t border-outline-variant/20 text-[10px] text-outline select-none uppercase tracking-wider">
              <div className="flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-outline" />
                <span>Controlled-failure lab run. Not live traffic.</span>
              </div>
              <span className="font-mono lowercase truncate max-w-[280px]">Hash: {selectedPayment.request_hash || (selectedPayment as any).requestHash || selectedPayment.id}</span>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-outline text-[12px] font-mono">
            Select a payment from the left to inspect its trace
          </div>
        )}
      </div>
    </div>
  );
};
