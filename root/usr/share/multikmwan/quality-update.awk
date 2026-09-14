# Previous state: wan epoch state onset interval target. Current input keeps
# the legacy health prefix: wan rtt loss epoch jitter sent received state
# target interval reason. Caller holds the health lock for all outputs.
FILENAME==previous {
	last[$1]=$2; state[$1]=$3; onset[$1]=$4; cadence[$1]=$5; target[$1]=$6; next
}
function event(kind, start, duration, why) {
	printf "%d,%s,%s,%d,%d,%s\n",ts,w,kind,start,duration,why >> events
}
{
	w=$1; ts=$4+0; current=$8; start=onset[w]
	if (w !~ /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/ || length(w)>64 || NF!=11) next
	continuous=(last[w]>0 && ts>last[w] && ts-last[w]<=3*cadence[w] && target[w]==$9)
	if(last[w] && !continuous) {
		event("gap",last[w],-1,(target[w]!=$9?"target_changed":"sampling_gap"))
	}
	if (!continuous || state[w]!=current) {
		start=ts
		if(current=="down") event("outage",ts,0,$11)
		else if(current=="degraded") event("degraded",ts,0,$11)
		if(continuous && (state[w]=="down" || state[w]=="degraded") &&
			(current=="healthy" || (state[w]=="down" && current=="degraded")))
			event("recovery",onset[w],ts-onset[w],(state[w]=="down"?"probe_recovered":"quality_recovered"))
		if(current=="disabled") event("disabled",ts,0,"not_tracked")
	}
	printf "%s %d %s %d %d %s\n",w,ts,current,start,$10,$9 > nextstate
	printf "%d,%s,%s,%s,%s,%s,%d,%d,%d,%s,%s\n",ts,w,current,$2,$3,$5,$6,$7,$10,$9,$11 >> samples
}
