# Bounded, compact RPC response. All string tokens are validated before JSON
# interpolation. Durations cover adjacent observations only, never long gaps.
BEGIN { FS=","; start=now-hours*3600; width=(hours==1?60:300) }
function safe(s) { return length(s)<=253 && s ~ /^[A-Za-z0-9_.:-]+$/ }
function number(s) { return s ~ /^[0-9]+([.][0-9]+)?$/ }
function severity(s) { return s=="down"?3:(s=="degraded"?2:(s=="healthy"?1:0)) }
function add(w, from, to, state, rtt, loss, jitter,    b,end,d,k) {
	if(from<start)from=start
	if(to>now)to=now
	if(!severity(state) || to<=from)return
	for(b=int(from/width)*width; b<to; b+=width) {
		end=(to<b+width?to:b+width); d=end-(from>b?from:b); k=w SUBSEP b
		observed[w]+=d; dur[k,state]+=d; seen[k]=1
		if(number(rtt)){rs[k]+=rtt*d;rn[k]+=d}
		if(number(loss)){ls[k]+=loss*d;ln[k]+=d}
		if(number(jitter)){js[k]+=jitter*d;jn[k]+=d}
	}
}
FILENAME==samples {
	if(NF!=11 || !safe($2) || !safe($3) || !safe($10) || !safe($11) ||
		!number($1) || !number($9) || $9<5 || $9>3600 || $1>now)next
	w=$2; t=$1+0
	if(last[w] && t>last[w] && t-last[w]<=3*interval[w] && target[w]==$10)
		add(w,last[w],t,state[w],rtt[w],loss[w],jitter[w])
	last[w]=t; state[w]=$3; rtt[w]=$4; loss[w]=$5; jitter[w]=$6
	interval[w]=$9; target[w]=$10; reason[w]=$11; have[w]=1
	nsamples[w]++
	if(number($7) && number($8) && t>=start){sent[w]+=$7;received[w]+=$8}
	next
}
FILENAME==events {
	if(NF!=6 || !number($1) || $1<start || $1>now || !safe($2) || !safe($3) ||
		!number($4) || $5!~/^-?[0-9]+$/ || !safe($6))next
	event[++ne]=sprintf("[%d,\"%s\",\"%s\",%d,%d,\"%s\"]",$1,$2,$3,$4,$5,$6)
}
END {
	printf "{\"now\":%d,\"hours\":%d,\"bucket_seconds\":%d,\"wans\":[",now,hours,width
	comma=""
	for(w in have) {
		fresh=(now>=last[w] && now-last[w]<=3*interval[w])
		if(fresh)add(w,last[w],now,state[w],rtt[w],loss[w],jitter[w])
		printf "%s{\"name\":\"%s\",\"state\":\"%s\",\"epoch\":%d,\"interval\":%d,",comma,w,(fresh?state[w]:"unknown"),last[w],interval[w]
		printf "\"target\":\"%s\",\"reason\":\"%s\",\"coverage\":%.2f,\"loss\":%s,\"points\":[",target[w],(fresh?reason[w]:"stale"),100*observed[w]/(hours*3600),(sent[w]?sprintf("%.2f",100*(sent[w]-received[w])/sent[w]):"null")
		sep=""
		for(b=int(start/width)*width;b<now;b+=width) {
			k=w SUBSEP b
			if(!seen[k])continue
			printf "%s[%d,%d,%d,%d,%s,%s,%s]",sep,b,dur[k,"healthy"],dur[k,"degraded"],dur[k,"down"],(rn[k]?sprintf("%.2f",rs[k]/rn[k]):"null"),(ln[k]?sprintf("%.2f",ls[k]/ln[k]):"null"),(jn[k]?sprintf("%.2f",js[k]/jn[k]):"null")
			sep=","
		}
		printf "]}";comma=","
	}
	printf "],\"events\":["
	for(i=ne;i>=1;i--)printf "%s%s",(i<ne?",":""),event[i]
	printf "]}\n"
}
