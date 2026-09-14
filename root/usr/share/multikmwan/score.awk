# Composite "fastest" score per WAN, from the last speed test, the last
# website test and recent ping latency. One line per WAN with an ok speed
# result:
#   composite wan speed_pts dns_pts web_pts speed_mbps dns_ms first_byte_ms down up sites lat_pts lat_ms
# Each component is the WAN's figure relative to the best WAN (1.0 = best):
# throughput as a share of the fastest; DNS, first-byte and ping round trip
# as the fastest time over this one. composite = 100 * weighted mean.
#
# Sites are compared only where every measured WAN loaded them, so a page one
# link could not fetch cannot tilt the averages in either direction. A WAN
# with no website rows scores 0 on DNS and web, and one with no latency
# sample scores 0 on latency: missing data must never promote a link. A
# component that NO WAN could measure (no website test yet, every lookup
# failed, monitor just started) drops out of the weighting instead, so the
# scores still read 0-100 and the ranking uses what is known.
#
# -v by=sum|down|up   -v ws= -v wd= -v ww= -v wl= (weights)
# -v speed= -v sites= -v latency= (paths; latency lines are "wan ms")
BEGIN { if (ws + wd + ww + wl <= 0) { ws = 1; wd = 0; ww = 0; wl = 0 } }
function median(a, n,    i, j, x) {
	for (i = 2; i <= n; i++) { x = a[i]; j = i - 1; while (j > 0 && a[j] > x) { a[j+1] = a[j]; j-- } a[j+1] = x }
	return n % 2 ? a[(n + 1) / 2] : (a[n / 2] + a[n / 2 + 1]) / 2
}
FILENAME == speed {
	if ($1 ~ /^#/ || NF < 5 || $4 != "ok") next
	cand[$1] = 1; down[$1] = $2; up[$1] = $3
	sp[$1] = (by == "down" ? $2 : (by == "up" ? $3 : $2 + $3)) + 0
	next
}
FILENAME == sites {
	if ($1 ~ /^#/ || NF < 8 || !($1 in cand)) next
	w = $1; h = $2; rows[w] = 1; host[h] = 1
	if ($7 == "ok") {
		ok[w, h] = 1; ttfb[w, h] = $4 + 0
		if ($3 != "-") { dns[w, h] = $3 + 0; hasdns[w, h] = 1 }
	}
	next
}
FILENAME == latency {
	if (NF < 2 || !($1 in cand) || $2 !~ /^[0-9]+([.][0-9]+)?$/) next
	lat[$1] = $2 + 0; haslat[$1] = 1
	next
}
END {
	for (h in host) { common[h] = 1; for (w in cand) if (rows[w] && !ok[w, h]) common[h] = 0 }
	for (w in cand) {
		n = 0; s = 0; k = 0; split("", dv)
		for (h in host) if (common[h] && ok[w, h]) {
			n++; s += ttfb[w, h]
			if (hasdns[w, h]) dv[++k] = dns[w, h]
		}
		if (n) { web[w] = s / n; nsites[w] = n; if (!(bw > 0) || web[w] < bw) bw = web[w] }
		if (k) { dm[w] = median(dv, k); if (!(bd > 0) || dm[w] < bd) bd = dm[w] }
		if (haslat[w] && (!(bl > 0) || lat[w] < bl)) bl = lat[w]
		if (sp[w] > bs) bs = sp[w]
	}
	if (!(bw > 0)) ww = 0
	if (!(bd > 0)) wd = 0
	if (!(bl > 0)) wl = 0
	if (ws + wd + ww + wl <= 0) ws = 1
	# Times are floored at 1 ms so a lucky 0 cannot divide the field to nothing.
	for (w in cand) {
		spp = bs > 0 ? sp[w] / bs : 0
		dnp = (w in dm) ? (bd < 1 ? 1 : bd) / (dm[w] < 1 ? 1 : dm[w]) : 0
		wbp = (w in web) ? (bw < 1 ? 1 : bw) / (web[w] < 1 ? 1 : web[w]) : 0
		ltp = haslat[w] ? (bl < 1 ? 1 : bl) / (lat[w] < 1 ? 1 : lat[w]) : 0
		printf "%.1f %s %.3f %.3f %.3f %.2f %s %s %s %s %d %.3f %s\n",
			100 * (ws * spp + wd * dnp + ww * wbp + wl * ltp) / (ws + wd + ww + wl), w, spp, dnp, wbp, sp[w],
			(w in dm ? sprintf("%.0f", dm[w]) : "-"), (w in web ? sprintf("%.0f", web[w]) : "-"),
			down[w], up[w], nsites[w] + 0, ltp, (haslat[w] ? sprintf("%.1f", lat[w]) : "-")
	}
}
