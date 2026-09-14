# Parse BusyBox/iputils ping. Jitter is mean absolute successive RTT delta
# within this batch, ignoring missing replies (not RFC 3550 RTP jitter).
/bytes from/ {
	for (i=1; i<=NF; i++) if ($i ~ /^time[=<]/) {
		v=$i; sub(/^time[=<]/, "", v)
		if (v !~ /^[0-9]+([.][0-9]+)?$/) continue
		v+=0; sum+=v
		if (n) { delta=v-prev; if(delta<0)delta=-delta; variation+=delta }
		prev=v; n++
	}
}
/packets transmitted/ {
	tx=$1+0
	for(i=2;i<=NF;i++) if($i ~ /^received/) {
		rx=$(i-1); if(rx=="packets")rx=$(i-2); rx+=0
	}
	valid=1
}
END {
	if (!valid || tx<=0 || rx<0 || rx>tx) { print "- - - 0 0 unknown"; exit }
	state=(rx==0 ? "down" : (rx<tx || (n && sum/n>250) ? "degraded" : "healthy"))
	printf "%s %.1f %s %d %d %s\n", (n?sprintf("%.2f",sum/n):"-"),
		100*(tx-rx)/tx, (n>1?sprintf("%.2f",variation/(n-1)):"-"), tx,rx,state
}
