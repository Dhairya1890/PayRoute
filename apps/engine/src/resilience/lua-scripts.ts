import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ACQUIRE_PROBE_LUA = `-- acquire_probe.lua
-- Atomically transitions open breaker to half_open after cooldown, and acquires a probe slot if available.
-- 
-- KEYS[1]: breaker key e.g. breaker:{provider}:{method}
-- KEYS[2]: pubsub channel e.g. breaker:events
-- 
-- ARGV[1]: now_sec (number)
-- ARGV[2]: max_probes (number, default 3)
-- ARGV[3]: provider (string)
-- ARGV[4]: method (string)

local now_sec = tonumber(ARGV[1])
local max_probes = tonumber(ARGV[2]) or 3
local provider = ARGV[3]
local method = ARGV[4]

local breaker = redis.call('HMGET', KEYS[1], 'state', 'cooldown_until', 'probes_inflight', 'consecutive_opens')
local state = breaker[1] or 'closed'
local cooldown_until = tonumber(breaker[2]) or 0
local probes_inflight = tonumber(breaker[3]) or 0
local consecutive_opens = tonumber(breaker[4]) or 0

-- 1. Closed breaker allows all traffic
if state == 'closed' then
    return {1, 'closed', probes_inflight}
end

-- 2. Open breaker: check if cooldown elapsed
if state == 'open' then
    if now_sec >= cooldown_until then
        -- Cooldown elapsed: transition to half_open and take first probe slot
        redis.call('HMSET', KEYS[1],
            'state', 'half_open',
            'probes_inflight', 1,
            'probes_ok', 0
        )
        local event = cjson.encode({
            provider = provider,
            method = method,
            from = 'open',
            to = 'half_open',
            consecutive_opens = consecutive_opens,
            reason = 'cooldown_elapsed'
        })
        redis.call('PUBLISH', KEYS[2], event)
        return {1, 'half_open', 1}
    else
        return {0, 'open', 0}
    end
end

-- 3. Half-open breaker: allow up to max_probes concurrent requests
if state == 'half_open' then
    if probes_inflight < max_probes then
        local new_inflight = redis.call('HINCRBY', KEYS[1], 'probes_inflight', 1)
        return {1, 'half_open', new_inflight}
    else
        return {0, 'half_open', probes_inflight}
    end
end

return {0, state, 0}
`;

export const RECORD_OUTCOME_LUA = `-- record_outcome.lua
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
`;

export const RECORD_PROBE_LUA = `-- record_probe.lua
-- Records the outcome of a half-open probe request.
-- If all probes succeed, recovers breaker to closed.
-- If any probe fails, re-opens breaker immediately with doubled cooldown.
-- 
-- KEYS[1]: breaker key e.g. breaker:{provider}:{method}
-- KEYS[2]: pubsub channel e.g. breaker:events
-- 
-- ARGV[1]: now_sec (number)
-- ARGV[2]: success (1 for success, 0 for failure)
-- ARGV[3]: required_probes (number, default 3)
-- ARGV[4]: provider (string)
-- ARGV[5]: method (string)

local now_sec = tonumber(ARGV[1])
local success = (tonumber(ARGV[2]) == 1)
local required_probes = tonumber(ARGV[3]) or 3
local provider = ARGV[4]
local method = ARGV[5]

local breaker = redis.call('HMGET', KEYS[1], 'state', 'consecutive_opens', 'probes_inflight', 'probes_ok')
local state = breaker[1] or 'closed'
local consecutive_opens = tonumber(breaker[2]) or 0
local probes_inflight = math.max(0, (tonumber(breaker[3]) or 1) - 1)
local probes_ok = tonumber(breaker[4]) or 0

if state ~= 'half_open' then
    redis.call('HSET', KEYS[1], 'probes_inflight', probes_inflight)
    return state
end

if success then
    probes_ok = probes_ok + 1
    if probes_ok >= required_probes then
        -- All probes succeeded: Full recovery to closed state!
        redis.call('HMSET', KEYS[1],
            'state', 'closed',
            'consecutive_opens', 0,
            'probes_inflight', 0,
            'probes_ok', 0
        )
        local event = cjson.encode({
            provider = provider,
            method = method,
            from = 'half_open',
            to = 'closed',
            consecutive_opens = 0,
            reason = 'probes_succeeded'
        })
        redis.call('PUBLISH', KEYS[2], event)
        return 'closed'
    else
        redis.call('HMSET', KEYS[1],
            'probes_inflight', probes_inflight,
            'probes_ok', probes_ok
        )
        return 'half_open'
    end
else
    -- Probe failed: Re-open breaker immediately with doubled cooldown!
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
        from = 'half_open',
        to = 'open',
        cooldown_until = cooldown_until,
        consecutive_opens = consecutive_opens,
        reason = 'probe_failed'
    })
    redis.call('PUBLISH', KEYS[3], event)
    return 'open'
end
`;

/**
 * Loads a Lua script from disk if present, with guaranteed embedded fallback
 * to prevent ENOENT errors in production container environments (Render/Docker).
 */
export async function loadLuaScript(filename: string, fallback: string): Promise<string> {
  const possiblePaths = [
    path.join(__dirname, 'lua', filename),
    path.join(__dirname, '../../src/resilience/lua', filename),
    path.join(process.cwd(), 'apps/engine/src/resilience/lua', filename),
    path.join(process.cwd(), 'src/resilience/lua', filename),
  ];

  for (const candidate of possiblePaths) {
    try {
      return await fs.readFile(candidate, 'utf8');
    } catch {
      // Continue to next path
    }
  }

  // Fallback to embedded script
  return fallback;
}
