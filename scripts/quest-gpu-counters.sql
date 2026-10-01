-- Use trace_processor_shell -q scripts/quest-gpu-counters.sql <trace.pftrace>.
-- Some metavr RPC versions return empty tables for this trace; direct loading works.
SELECT t.id, t.name, COUNT(*) AS samples, ROUND(AVG(c.value),3) AS mean,
 ROUND(MIN(c.value),3) AS minimum, ROUND(MAX(c.value),3) AS maximum,
 MIN(c.ts) AS first_ts, MAX(c.ts) AS last_ts
 FROM counter c JOIN counter_track t ON c.track_id=t.id
 WHERE t.name IN ('% Shaders Busy','% Time Shading Fragments',
 '% Shader ALU Capacity Utilized','GPU % Bus Busy','GPU Frequency',
 'app_gpu_ms','timewarp_gpu_ms','GpuUtilization','gpu_util')
 GROUP BY t.id, t.name ORDER BY t.name,t.id;
