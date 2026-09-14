# Merge daily totals from persisted rows and the live accumulator. The caller
# holds the history lock so an hourly flush cannot duplicate or omit rows.
BEGIN { FS=OFS="," }
NF==15 {
	k=$1 SUBSEP $2; date[k]=$1; wan[k]=$2
	for(i=3;i<=15;i++) {
		if(i==12 || i==15) { if($i+0>a[k,i])a[k,i]=$i+0 }
		else a[k,i]+=$i
	}
}
END {
	for(k in date) {
		printf "%s,%s",date[k],wan[k]
		for(i=3;i<=15;i++)printf ",%s",a[k,i]+0
		printf "\n"
	}
}
