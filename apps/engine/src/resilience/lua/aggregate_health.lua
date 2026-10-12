-- aggregate_health.lua
-- Aggregates rolling health metrics and breaker states for all providers and payment methods in ONE atomic operation.
-- Replaces 63 individual HMGET + HGETALL pipeline commands with 1 single server-side execution.
--
-- ARGV[1]: now_sec (number)
-- ARGV[2]: providers JSON array (string e.g. '["razorpay","stripe","payu"]')
-- ARGV[3]: methods JSON array (string e.g. '["card","upi","netbanking"]')

local now_sec = tonumber(ARGV[1])
local current_bucket = math.floor(now_sec / 10)
local providers = cjson.decode(ARGV[2])
local methods = cjson.decode(ARGV[3])

local results = {}

for _, provider in ipairs(providers) do
    for _, method in ipairs(methods) do
        local breaker_key = "breaker:" .. provider .. ":" .. method
        local breaker = redis.call('HMGET', breaker_key, 'state', 'cooldown_until', 'consecutive_opens')
        local state = breaker[1] or 'closed'
        local cooldown_until = tonumber(breaker[2])
        local consecutive_opens = tonumber(breaker[3]) or 0

        local total_ok = 0
        local total_fail = 0
        local total_decline = 0
        local latency_sum = 0
        local latency_count = 0

        for b = current_bucket - 5, current_bucket do
            local bkey = "health:" .. provider .. ":" .. method .. ":" .. tostring(b)
            local vals = redis.call('HMGET', bkey, 'ok', 'fail', 'decline', 'latency_sum', 'latency_count')
            if vals[1] then total_ok = total_ok + (tonumber(vals[1]) or 0) end
            if vals[2] then total_fail = total_fail + (tonumber(vals[2]) or 0) end
            if vals[3] then total_decline = total_decline + (tonumber(vals[3]) or 0) end
            if vals[4] then latency_sum = latency_sum + (tonumber(vals[4]) or 0) end
            if vals[5] then latency_count = latency_count + (tonumber(vals[5]) or 0) end
        end

        table.insert(results, {
            provider = provider,
            method = method,
            breaker_state = state,
            cooldown_until = cooldown_until,
            consecutive_opens = consecutive_opens,
            ok_count = total_ok,
            fail_count = total_fail,
            decline_count = total_decline,
            latency_sum = latency_sum,
            latency_count = latency_count
        })
    end
end

return cjson.encode(results)
