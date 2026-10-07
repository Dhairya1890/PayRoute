-- record_outcome.lua
-- Atomically increments rolling health counters and trips the circuit breaker if thresholds are breached.
-- 
-- KEYS[1]: health bucket key e.g. health:{provider}:{method}:{bucket}
-- KEYS[2]: breaker key e.g. breaker:{provider}:{method}
-- KEYS[3]: pubsub channel e.g. breaker:events
-- 
-- ARGV[1]: now_sec (number)
-- ARGV[2]: outcome_class (string)
-- ARGV[3]: latency_ms (number)
-- ARGV[4]: window_prefix (string: health:{provider}:{method}:)
-- ARGV[5]: provider (string)
-- ARGV[6]: method (string)

local now_sec = tonumber(ARGV[1])
local outcome_class = ARGV[2]
local latency_ms = tonumber(ARGV[3]) or 0
local window_prefix = ARGV[4]
local provider = ARGV[5]
local method = ARGV[6]

-- 1. Increment bucket counters based on outcome classification
if outcome_class == 'success' then
    redis.call('HINCRBY', KEYS[1], 'ok', 1)
elseif outcome_class == 'hard_decline' or outcome_class == 'soft_decline' then
    redis.call('HINCRBY', KEYS[1], 'decline', 1)
elseif outcome_class == 'not_sent' or outcome_class == 'transient_known' or outcome_class == 'ambiguous' or outcome_class == 'config_error' then
    redis.call('HINCRBY', KEYS[1], 'fail', 1)
end

-- Track latency stats
if latency_ms > 0 then
    redis.call('HINCRBY', KEYS[1], 'latency_sum', latency_ms)
    redis.call('HINCRBY', KEYS[1], 'latency_count', 1)
end
redis.call('EXPIRE', KEYS[1], 600) -- Retain 10s buckets for 10 minutes

-- 2. Read breaker state
local breaker = redis.call('HMGET', KEYS[2], 'state', 'consecutive_opens', 'cooldown_until')
local state = breaker[1] or 'closed'
local consecutive_opens = tonumber(breaker[2]) or 0

-- 3. Immediate trip on config_error (401/403 credentials failure)
if outcome_class == 'config_error' and state ~= 'open' then
    consecutive_opens = consecutive_opens + 1
    local cooldown = math.min(300, 30 * math.floor(math.pow(2, consecutive_opens - 1)))
    local cooldown_until = now_sec + cooldown

    redis.call('HMSET', KEYS[2],
        'state', 'open',
        'opened_at', now_sec,
        'cooldown_until', cooldown_until,
        'consecutive_opens', consecutive_opens,
        'probes_inflight', 0,
        'probes_ok', 0
    )

    local event = cjson.encode({
        provider = provider,
        method = method,
        from = state,
        to = 'open',
        cooldown_until = cooldown_until,
        consecutive_opens = consecutive_opens,
        reason = 'config_error'
    })
    redis.call('PUBLISH', KEYS[3], event)
    return 'tripped_immediate'
end

-- 4. Check rolling window threshold if breaker is currently closed and failure occurred
local is_health_fail = (outcome_class == 'not_sent' or outcome_class == 'transient_known' or outcome_class == 'ambiguous')
if state == 'closed' and is_health_fail then
    local total_ok = 0
    local total_fail = 0
    local current_bucket = math.floor(now_sec / 10)

    -- Evaluate 6 consecutive 10s buckets (60s rolling window)
    for b = current_bucket - 5, current_bucket do
        local bkey = window_prefix .. tostring(b)
        local vals = redis.call('HMGET', bkey, 'ok', 'fail')
        total_ok = total_ok + (tonumber(vals[1]) or 0)
        total_fail = total_fail + (tonumber(vals[2]) or 0)
    end

    local total_reqs = total_ok + total_fail
    -- Threshold: minimum 20 requests and failure rate > 50%
    if total_reqs >= 20 and (total_fail / total_reqs) > 0.50 then
        consecutive_opens = consecutive_opens + 1
        local cooldown = math.min(300, 30 * math.floor(math.pow(2, consecutive_opens - 1)))
        local cooldown_until = now_sec + cooldown

        redis.call('HMSET', KEYS[2],
            'state', 'open',
            'opened_at', now_sec,
            'cooldown_until', cooldown_until,
            'consecutive_opens', consecutive_opens,
            'probes_inflight', 0,
            'probes_ok', 0
        )

        local event = cjson.encode({
            provider = provider,
            method = method,
            from = 'closed',
            to = 'open',
            cooldown_until = cooldown_until,
            consecutive_opens = consecutive_opens,
            reason = 'threshold_exceeded',
            failure_rate = (total_fail / total_reqs)
        })
        redis.call('PUBLISH', KEYS[3], event)
        return 'tripped_threshold'
    end
end

return 'ok'
