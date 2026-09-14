**Orb-inspired feature roadmap for MultiKmwan**

Reviewed 2026-09-11 against repository commit `2a22068b05629337c9ba24522aec8262c7ba01e9` on `main`. This is a feature assessment based on source inspection and Orb's official documentation; router behavior has not been tested in this workspace. Priorities, designs, and acceptance criteria below are recommendations, not implemented features or claims about Orb's internals.

Build continuous WAN quality monitoring first, then use that evidence to improve routing. The useful product question is: "Which connection will work best for my devices, and what happened when it stopped working?"

**Existing foundation**

| Area | Already implemented | Remaining opportunity |
| --- | --- | --- |
| Routing | Failover, load balancing, speed-based automatic ranking with a margin | Rank by responsiveness and reliability; explain decisions |
| Device preferences | Explicit WAN order and fastest/slowest/backup roles | Low-latency and most-reliable roles |
| Health | Interface-bound ping, average RTT and loss, healthy/degraded/failing indicators | Jitter, multiple targets, freshness, DNS/HTTP diagnostics |
| Speed | Interface-bound parallel upload/download, custom server profiles, smaller scheduled tests, busy-link guard | Independent monitoring schedule, validated results, latency under load |
| History | 90-day daily aggregates and last ten speed runs | Intraday quality timeline, timed incidents, exports |
| Link information | Public IP, ISP, location, link state and traffic counters | Change events and diagnostic correlation |
| Integration | LuCI RPC methods with read/write ACLs | Stable measurement schema and optional external collection |

Evidence: [README](../README.md), [backend](../root/usr/sbin/multikmwan), [RPC provider](../root/usr/libexec/rpcd/luci.multikmwan), and the [LuCI views](../htdocs/luci-static/resources/view/multikmwan).

**Recommended backlog, in delivery order**

| Priority | Feature | User benefit | Relative effort |
| --- | --- | --- | --- |
| P0 | Reliable collection and freshness | Trust the measurements before acting on them | Medium |
| P1 | Live quality and incident timeline | Explain brief drops and recurring slow periods | Medium |
| P1 | WAN quality summary | Compare responsiveness, reliability and speed at a glance | Medium |
| P1 | Diagnostic checks | Distinguish link, DNS, endpoint and congestion symptoms | Medium |
| P2 | Configurable alerts | Learn about sustained problems and recovery | Medium |
| P2 | Quality-based WAN/device preferences | Put interactive devices on the better-performing link | Large |
| P2 | Better speed measurements | Measure everyday transfers and performance under load | Medium |
| P3 | Reports, external metrics and optional Orb adapter | Support ISP troubleshooting and existing dashboards | Medium to large |

Effort is comparative, not a calendar estimate; hardware validation is a dependency.

**1. Make collection reliable enough for these features**

The following source findings directly affect the proposed monitoring and ranking:

- `cmd_loop()` runs health checks, route synchronization, geolocation and scheduled speed tests sequentially, then sleeps for the configured interval (20 seconds by default). That interval is not the actual sampling period. Long tests can leave monitoring gaps. Separate bounded health collection from slow jobs, prevent overlapping writers, and timestamp each result.
- `cmd_health()` sends three pings to one target per WAN. A single batch only gives coarse loss observations; retain sent/received counts across a window. Define jitter explicitly, for example mean absolute difference between successive successful RTT samples to the same target, and report insufficient data when appropriate.
- `_wan_cb()` omits interfaces without a resolved device. Retain configured WAN identities so a disappearing device can produce a link-down event instead of silently disappearing from monitoring.
- `grade()` does not check `health_epoch` before using RTT/loss. Add an unknown/stale state. Keep administratively disabled, missing telemetry, failed probes and physical link-down distinguishable.
- `hist_rollup()` counts successful/failed samples, rather than elapsed time. Keep this existing statistic labeled as sample availability; add observed durations and coverage for new reliability reports. Do not infer downtime across a reboot or a long sampling gap. Brief failures between probes remain undetectable.
- Busy-link skips retain old speed results, and `hist_record_speed()`/`hist_rollup speed` can record those again as part of a new run. Deduplicate by measurement ID/timestamp. `rank_sorted()` also needs an age limit before old results can influence routing.
- `st_one()` uses curl throughput and download positivity without validating HTTP status or direction-specific success. Record exit status, HTTP status, transferred bytes and elapsed time; rejected uploads and HTTP error bodies must not count as successful capacity measurements.

Acceptance: a slow speed test does not stop health sampling; stale data becomes unknown; a disappeared WAN stays visible; failed requests and reused speed results do not become fresh successful measurements. Verify probe egress on every WAN during failover and balancing, including DNS traffic, before trusting per-WAN attribution.

**2. Live quality timeline and incident history**

Orb distinguishes responsive, laggy, unresponsive and inactive periods, and tracks outage duration. Adapt that distinction to WAN monitoring. [Orb reliability documentation](https://orb.net/docs/orb-app/reliability).

Add 1-hour and 24-hour views for RTT, jitter, packet loss and state, with events for link loss, degraded connectivity, recovery and ranking changes. Record first/last observation, approximate duration, WAN, affected target and reason. Clearly mark unknown gaps and sampling resolution. Annotate expected `kmwan` re-probing after a configuration change.

Use a bounded RAM buffer for recent samples and minute aggregates, retaining existing daily summaries on flash. As a sizing example, three WANs at one record per 20 seconds and an assumed 160 bytes per record require about 2.1 MB per day before indexes or extra targets. Cap bytes as well as time; measure actual memory and write rates on hardware. Make durable detailed history opt-in to external storage or an external collector.

Implementation: `cmd_health()`, `hist_rollup()`, `hist_flush()`, RPC `history_json()`, and `history.js`. The current history RPC reads only the persisted CSV; merge the live accumulator into the response without forcing a flash write.

Acceptance: a detected interruption appears with recovery and supporting measurements; a service stop produces a telemetry gap; today's data is visible before the hourly flush; memory stays bounded over a multi-day run.

**3. Explainable WAN quality summary**

Orb presents a 0-100 score composed of responsiveness, reliability and speed. Its documentation distinguishes content speed from peak tests. [Orb scores and metrics](https://orb.net/docs/orb-app/orb-scores-metrics).

Extend existing WAN cards with separate responsiveness, reliability and throughput indicators, measurement age, coverage and reasons such as "elevated packet loss over the last five minutes." Start with these components; introduce a composite score only after thresholds have been calibrated against observed problems. Publish any formula and version it. Use a MultiKmwan name; the reviewed docs do not establish an exact formula we can reproduce as an Orb Score.

Implementation: compute shared summaries in the backend/RPC layer and render them in `overview.js`, so later routing uses the same evidence. Keep measurement type, target and time window visible. Missing speed data should remain unavailable rather than silently becoming zero.

Acceptance: a fast but lossy WAN shows why it is unsuitable for interactive use; stale/insufficient data cannot receive a healthy score; raw measurements explain each warning.

**4. Diagnostics that answer why**

Orb exposes DNS resolution time and HTTP time to first byte alongside network responsiveness. Its Wi-Fi views distinguish local and internet paths. [Orb responsiveness documentation](https://orb.net/docs/orb-app/responsiveness).

Add an on-demand per-WAN diagnostic panel: interface/gateway state, several independently operated internet targets, DNS resolution, and a small HTTPS request with connection/TLS/first-byte timings. Probe failure at one destination should be reported as endpoint evidence, not automatically as whole-WAN failure. Use configurable targets and bounded time/byte budgets.

Implementation: extend the backend with a diagnostic job and read-only result RPC; add a LuCI diagnostics view. Validate available curl and DNS capabilities on the target firmware. Binding an HTTP transfer does not by itself establish that its resolver query used the same WAN; implement explicit resolver routing or label that measurement as router-wide.

Acceptance: injected DNS failure, one blocked target, total upstream failure and high latency produce distinct explanations. Treat explanations as likely causes supported by evidence. A router-originated test cannot establish a particular client's Wi-Fi experience; that needs a client/browser probe or companion sensor.

**5. Alerts with sustained conditions and recovery**

Orb provides threshold rules, evaluation periods, cooldowns and notification destinations. [Orb events and alerts](https://orb.net/docs/orb-cloud/events-alerts).

Start with WAN down/recovered, sustained degradation, backup-link activation and routing changes. Support a threshold, minimum duration, cooldown and recovery notification. Show events locally and in syslog, with an optional generic HTTPS webhook. Add public-IP changes only after improving refresh triggers; current geolocation is cached for six hours.

Implementation: UCI alert sections, a bounded event queue and a delivery worker separate from collection/routing. Keep secrets out of read RPC responses. If all WANs fail, queue delivery until connectivity returns; immediate notification of total site loss requires an external observer.

Acceptance: one brief spike does not generate repeated alerts; a sustained condition generates one incident and one recovery; webhook timeout never stalls monitoring.

**6. Quality-based routing and device roles**

This is our extension of the measurement ideas, not an Orb routing feature established by the reviewed documentation. Add "Lowest latency" and "Most reliable" device roles, followed by an optional global "Best quality" mode. For example, a call device can prefer a stable 100 Mbps WAN over a lossy 500 Mbps WAN.

Implementation: extend `rank_sorted()`, `cmd_autorank()`, `_client_order()`, `mode.js` and `clients.js`. Initially display recommendations without changing routes. Gate later automation on fresh measurements, sufficient coverage, a minimum improvement, consecutive qualifying windows and a hold-down period. Preserve metered-link policy and manual WAN order as explicit constraints.

`rank_apply()` commits configuration and restarts `kmwan`; the source describes roughly seven seconds of re-probing. Do not apply on every health sample. Global ranking and per-client rule changes need separate disruption tests. Test existing sessions and new connections; do not promise seamless session migration between public IPs.

Acceptance: jittery scores cannot cause route flapping; unavailable data cannot promote a WAN; every applied decision records old/new selection and reason; packet-capture tests confirm device traffic follows policy.

**7. Separate routine transfers from capacity tests**

Orb separates small scheduled content transfers from user-initiated peak measurements. [Orb speed documentation](https://orb.net/docs/orb-app/speed).

MultiKmwan already has smaller scheduled payloads, so extend that mechanism with a monitoring-only schedule independent of automatic ranking, explicit routine/capacity labels, budgets and per-direction status. Add an on-demand test comparing baseline latency with latency during download and upload; describe excessive increases as possible queueing/congestion, not a definitive diagnosis.

Implementation: `st_one()`, `cmd_speedtest()`, scheduler configuration and `overview.js`. Persist endpoint and test type to avoid mixing incomparable results. Retain busy-link and metered safeguards. For scale, a hypothetical 10 MB download plus 10 MB upload every hour is 480 MB/day/WAN before overhead; display estimated and actual usage.

Acceptance: monitoring works with ranking off; failed uploads are visible independently; load-test results are annotated so self-induced congestion does not trigger automatic WAN switching.

**8. Reports and integration strategy**

Add CSV/JSON downloads and a printable selected-period report containing WAN quality, incidents, speed-test provenance and monitoring coverage. Offer an authenticated, versioned read-only metrics interface through the existing RPC/ACL structure; external systems can retain longer history. Orb's local analytics example uses Telegraf, InfluxDB and Grafana, illustrating this integration pattern. [Orb local analytics](https://orb.net/docs/deploy-and-configure/local-analytics).

An optional Orb sensor adapter is worth a later compatibility spike. Orb documents installation on OpenWrt and approximately 5 MB installation storage plus 35 MB local data storage. Verify CPU architecture, firmware, runtime resources, licensing and API/authentication requirements before choosing it as a dependency. [Orb OpenWrt guide](https://orb.net/docs/setup-sensor/linux/openwrt).

Do not assume one sensor reports every WAN separately: Orb's documented multi-interface deployment uses separate Docker sensors attached to networks/VLANs. Prove WAN identity and routing isolation for any router integration. [Orb multi-interface guide](https://orb.net/docs/setup-sensor/docker-multiple-interfaces).

Keep the native lightweight collector as the first implementation. Defer cloud fleet management, multi-tenancy, mobile apps and MCP until there is a concrete consumer. Full Wi-Fi path testing belongs in a companion capability: Orb's LAN tester uses a dedicated Wi-Fi/Ethernet measurement setup and currently labels its endpoint features experimental. [Orb LAN tester](https://orb.net/docs/deploy-and-configure/orb-lan-tester).

**First implementation milestone**

Ship the collection fixes, a 24-hour quality timeline, freshness/coverage indicators and an outage/recovery event log. This is useful immediately and supplies the evidence needed for alerts and quality-based routing.

Before enabling routing automation, validate on a GL.iNet router with multiple WANs: single-target failure, packet loss/jitter, link disappearance, collector restart, clock changes, concurrent manual/scheduled tests, metered backup behavior and actual packet egress. Measure CPU/RAM and persistence growth over a soak run. Source inspection alone cannot establish those behaviors on the tested GL SDK/kernel combination.
