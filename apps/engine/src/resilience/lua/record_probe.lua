-- record_probe.lua
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

    redis.call('HMSET', KEYS[1],
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
    redis.call('PUBLISH', KEYS[2], event)
    return 'open'
end
