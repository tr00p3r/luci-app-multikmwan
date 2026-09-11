# MultiKwan

**A LuCI web UI for GL.iNet's built-in multi-WAN engine (`kmwan`).** It lets you switch between failover, load-balance, and a "fastest" mode; give individual LAN devices a preferred WAN; speed-test each line (against a public server or your own) and auto-rank the fastest with hysteresis so it doesn't flap; flag metered links as backup-only; and keep 90 days of per-WAN uptime, outage and speed history — all by driving the stock `kmwan` module rather than replacing it, so nothing about your GL.iNet setup is forked or lost.

| Status & Speed | 90-Day History |
|---|---|
| ![Status](screenshots/status.png) | ![History](screenshots/history.png) |

| Mode & Priority | Client Preference |
|---|---|
| ![Mode](screenshots/mode.png) | ![Clients](screenshots/clients.png) |

## Install

LuCI on GL.iNet is on **port 8080**. Download the `.ipk` from [Releases](../../releases):

```sh
scp luci-app-multikwan_*.ipk root@192.168.8.1:/tmp/
ssh root@192.168.8.1 "opkg install /tmp/luci-app-multikwan_*.ipk"
```

Then open **Network → MultiKwan**. Requires a GL.iNet 4.x device with `kmwan` and LuCI; the package is architecture-independent.

**Tested on:** GL-AX1800 (Flint), OpenWrt 23.05 / GL SDK4, `kmwan` 5.4.164, with three wired WANs.

## Documentation

Full docs — features, configuration, CLI, how it works, building from source, and FAQ (including "how do I use speedtest.net?") — are in the **[Wiki](../../wiki)**.

## ⚠️ Built by AI — read before you run it

This project was written by **Claude (Anthropic's AI)** in a single interactive session, developing directly against a live GL-AX1800 over SSH. A human directed it and it was tested on real hardware, but **no line was hand-written by a person.** It's networking code that runs as root on your router, so treat it accordingly:

- The source is **heavily commented with the reasoning** behind each non-obvious choice (why the `.ipk` is a tar.gz not an `ar`, why history uses an in-RAM accumulator, why `kmwan` only has two real modes, etc.) — read those comments; they are the design docs.
- Review the shell and JS yourself, or have someone you trust do so, before deploying on a network you care about.
- It's released into the public domain (below), with **no warranty** — you own the outcome.

If that trade-off isn't for you, that's completely fair.

## License

Public domain — [the Unlicense](LICENSE). Do whatever you want; no conditions, no attribution required.
