-- acquire_probe.lua
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
