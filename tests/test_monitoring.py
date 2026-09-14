"""Behavior tests for shipped shell/AWK logic. Run: python -m unittest discover -s tests -v.

Uses Git Bash on Windows, /bin/sh on Unix. OpenWrt network/UCI are mocked;
kernel flock tests run only when a native flock executable is available.
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest
ROOT = pathlib.Path(__file__).resolve().parents[1]
LIB = ROOT / 'root/usr/share/multikmwan'
GIT = pathlib.Path('C:/Program Files/Git')
AWK = shutil.which('awk') or str(GIT / 'usr/bin/awk.exe')
SHELL = str(GIT / 'bin/bash.exe') if os.name == 'nt' else '/bin/sh'


def run(args, **kwargs):
    result = subprocess.run(args, text=True, encoding='utf-8', capture_output=True, **kwargs)
    if result.returncode:
        raise AssertionError(f'{args} exited {result.returncode}\n{result.stdout}\n{result.stderr}')
    return result.stdout.strip()


class MonitoringTests(unittest.TestCase):
    def setUp(self):
        (ROOT / 'build').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='mk-tests-', dir=ROOT / 'build')
        self.addCleanup(self.temp.cleanup)
        self.dir = pathlib.Path(self.temp.name)

    def file(self, name, text=''):
        path = self.dir / name
        path.write_text(text, encoding='utf-8', newline='\n')
        return path.as_posix()

    def awk(self, name, text='', variables=None, files=None):
        args = [AWK]
        for key, value in (variables or {}).items():
            args += ['-v', f'{key}={value}']
        args += ['-f', str(LIB / name)] + (files or [])
        return run(args, input=text)

    def shell(self, commands, real_locks=False):
        source = (ROOT / 'root/usr/sbin/multikmwan').read_text(encoding='utf-8')
        source = source.rsplit('case "$1" in', 1)[0]
        source = source.replace('. /lib/functions.sh', '').replace('. /lib/functions/network.sh', '')
        replacements = {'/usr/share/multikmwan': LIB.as_posix(), '/var/lock': self.dir.as_posix(),
                        '/etc/multikmwan': self.dir.as_posix(), '/tmp': self.dir.as_posix()}
        source = re.sub('|'.join(re.escape(p) for p in replacements),
                        lambda m: replacements[m.group(0)], source)
        # config_get hands back the caller's default for unset options, as the real one does.
        prelude = 'config_load() { :; }; config_get() { eval "$1=\\"\\$4\\""; };\n'
        if not real_locks:
            prelude += 'flock() { return 0; };\n'
        script = self.file('run.sh', prelude + source + '\n' + commands)
        env = dict(os.environ)
        if os.name == 'nt':
            env['PATH'] = str(GIT / 'usr/bin') + os.pathsep + env.get('PATH', '')
        return run([SHELL, script], cwd=self.dir, env=env)

    def test_ping_jitter_and_loss_busybox(self):
        text = ('64 bytes from 1.1.1.1: seq=0 ttl=55 time=10.000 ms\n'
                '64 bytes from 1.1.1.1: seq=2 ttl=55 time=30.000 ms\n'
                '3 packets transmitted, 2 packets received, 33% packet loss\n')
        self.assertEqual(self.awk('ping.awk', text), '20.00 33.3 20.00 3 2 degraded')

    def test_ping_iputils_and_unknown(self):
        text = ('64 bytes from 1.1.1.1: icmp_seq=1 ttl=55 time=10 ms\n'
                '3 packets transmitted, 1 received, 66.6667% packet loss, time 2000ms\n')
        self.assertEqual(self.awk('ping.awk', text), '10.00 66.7 - 3 1 degraded')
        self.assertEqual(self.awk('ping.awk', 'ping: invalid option'), '- - - 0 0 unknown')
        self.assertEqual(self.awk('ping.awk', '3 packets transmitted, 0 packets received, 100% packet loss'),
                         '- 100.0 - 3 0 down')

    def update(self, previous, health):
        prev = self.file('state', previous)
        nextstate = self.file('nextstate')
        samples = self.file('samples')
        events = self.file('events')
        self.awk('quality-update.awk', variables=dict(previous=prev, nextstate=nextstate, samples=samples, events=events),
                 files=[prev, self.file('health', health)])
        return pathlib.Path(events).read_text(), pathlib.Path(nextstate).read_text()

    def test_outage_recovery_duration(self):
        events, state = self.update('wan 100 down 80 20 1.1.1.1\n',
                                    'wan 10 0 120 1 3 3 healthy 1.1.1.1 20 probe_ok\n')
        self.assertEqual(events.strip(), '120,wan,recovery,80,40,probe_recovered')
        self.assertIn('wan 120 healthy 120', state)

    def test_gap_cannot_claim_recovery_or_duration(self):
        for epoch, target in ((300, '1.1.1.1'), (90, '1.1.1.1'), (120, '8.8.8.8')):
            events, _ = self.update('wan 100 down 80 20 1.1.1.1\n',
                                    f'wan 10 0 {epoch} 1 3 3 healthy {target} 20 probe_ok\n')
            self.assertIn(',gap,100,-1,', events)
            self.assertNotIn('recovery', events)

    def test_disabled_not_an_outage_and_unknown_not_recovery(self):
        events, _ = self.update('', 'wan - - 120 - 0 0 disabled 1.1.1.1 20 not_tracked\n')
        self.assertIn('disabled', events)
        self.assertNotIn('outage', events)
        events, _ = self.update('wan 100 down 80 20 1.1.1.1\n',
                                'wan - - 120 - 0 0 unknown 1.1.1.1 20 probe_error\n')
        self.assertNotIn('recovery', events)

    def quality(self, samples, now=3600, hours=1, events=''):
        sf, ef = self.file('samples', samples), self.file('events', events)
        return json.loads(self.awk('quality-json.awk', variables=dict(now=now, hours=hours, samples=sf, events=ef), files=[sf, ef]))

    def test_coverage_excludes_gaps_and_stale_tail(self):
        data = self.quality('100,wan,healthy,10,0,1,3,3,20,1.1.1.1,probe_ok\n'
                            '120,wan,down,-,100,-,3,0,20,1.1.1.1,probe_failed\n'
                            '300,wan,healthy,10,0,1,3,3,20,1.1.1.1,probe_ok\n')
        wan = data['wans'][0]
        self.assertEqual(wan['state'], 'unknown')
        self.assertAlmostEqual(wan['coverage'], 20 / 3600 * 100, places=2)
        self.assertEqual(sum(p[1] + p[2] + p[3] for p in wan['points']), 20)
        self.assertEqual(wan['loss'], 33.33)

    def test_coverage_clips_window_and_fresh_tail(self):
        data = self.quality('10,wan,healthy,10,0,1,3,3,20,1.1.1.1,probe_ok\n'
                            '30,wan,healthy,10,0,1,3,3,20,1.1.1.1,probe_ok\n', now=40)
        self.assertEqual(sum(sum(p[1:4]) for p in data['wans'][0]['points']), 30)
        self.assertEqual(data['wans'][0]['state'], 'healthy')

    def test_empty_unknown_and_untrusted_tokens(self):
        self.assertEqual(self.quality('')['wans'], [])
        data = self.quality('3500,wan,disabled,-,-,-,0,0,20,1.1.1.1,not_tracked\n'
                            '3590,evil"wan,healthy,10,0,1,3,3,20,1.1.1.1,probe_ok\n')
        self.assertEqual(len(data['wans']), 1)
        self.assertEqual(data['wans'][0]['coverage'], 0)
        self.assertIsNone(data['wans'][0]['loss'])

    def test_history_merges_live_counts_and_maxima(self):
        a = self.file('persisted', '2026-09-11,wan,3,1,60,3,0,3,1,100,1,100,20,1,20\n')
        b = self.file('acc', '2026-09-11,wan,2,0,20,2,0,2,0,200,1,200,10,1,10\n')
        result = self.awk('history-merge.awk', files=[a, b]).split(',')
        self.assertEqual(result[2:6], ['5', '1', '80', '5'])
        self.assertEqual(result[11], '200')
        self.assertEqual(result[14], '20')

    def test_hostnames_strip_credentials_queries_and_paths(self):
        output = self.shell("st_host 'https://user:secret@speed.cloudflare.com/__down?token=secret#fragment'\n"
                            "st_host 'https://[2001:db8::1]:443/path'\n")
        self.assertEqual(output.splitlines(), ['speed.cloudflare.com', '[2001:db8::1]:443'])

    def test_speed_rejects_http_error_and_records_redirect_host(self):
        self.file('d1', '1000000 200 1000000 1 https://actual.example/test?token=secret\n')
        self.file('de1', '0\n')
        self.file('d2', '3000000 403 1000 1 https://denied.example/error\n')
        self.file('de2', '0\n')
        output = self.shell('st_validate . d 2; cat dstatus dhosts')
        self.assertEqual(output.splitlines()[0], '0')
        self.assertIn('http_403_exit_0', output)
        self.assertIn('actual.example;denied.example', output)
        self.assertNotIn('secret', output)

    def test_speed_rejects_transport_failure(self):
        self.file('u1', '1000000 200 1000000 1 https://upload.example/test\n')
        self.file('ue1', '28\n')
        output = self.shell('st_validate . u 1; cat ustatus')
        self.assertEqual(output.splitlines(), ['0', 'http_200_exit_28'])

    def test_source_snapshot_survives_profile_change_and_checkpoint(self):
        output = self.shell('''
collect_wans() { WANS=wan; }
g() { case "$1" in active_server) echo profile;; st_bytes) echo 1000000;; st_streams) echo 1;; busy_skip) echo 0;; *) echo "$2";; esac; }
uci() { case "$*" in *profile.down_url) echo 'https://initial.example/down?token=secret';;
    *profile.up_url) echo 'https://initial.example/up';; *profile.label) echo 'Original Cloud';; *profile) echo server;; esac; }
wan_metered() { return 1; }
wan_dev() { echo eth0; }
log() { :; }
curl() { case "$*" in *--data-binary*) cat >/dev/null;; esac
    echo '1000000 200 1000000 1 https://actual.example/test?token=secret'
}
ST_KIND=scheduled cmd_speedtest >/dev/null
uci() { case "$*" in *label) echo 'Changed Cloud';; *profile) echo server;; esac; }
hist_flush
cat "$HIST_DIR/tests.csv"
cat "$HIST_FILE"
''')
        self.assertIn(',scheduled,Original Cloud,profile,actual.example,actual.example,ok,ok', output)
        self.assertNotIn('Changed Cloud', output)
        self.assertNotIn('secret', output)
        self.assertIn(',wan,0,0,0,0,0,0,0,8,1,8,8,1,8', output)

    def test_busy_skip_does_not_add_fresh_speed_history(self):
        output = self.shell('''
collect_wans() { WANS=wan; }
g() { case "$1" in busy_skip) echo 1;; busy_mbps) echo 20;; esac; }
wan_metered() { return 1; }
wan_dev() { echo eth0; }
wan_busy_mbps() { echo 100; }
log() { :; }
hist_rollup() { :; }
echo 'wan 100 20 ok 1000' > "$SPEED_FILE"
cmd_speedtest >/dev/null
cat "$SPEED_FILE"
[ ! -s "$SPEEDHIST_FILE" ] || exit 1
''')
        self.assertIn('wan 100 20 ok 1000', output)

    def test_monitor_retention_bounds_and_disappeared_device(self):
        output = self.shell('''
collect_wans() { WANS=wan; }
g() { echo 20; }
uci() { :; }
wan_dev() { :; }
wan_track_ip() { echo 1.1.1.1; }
hist_rollup() { :; }
mkdir -p "$QUALITY_DIR"
now=$(date +%s)
awk -v now="$now" 'BEGIN{for(i=0;i<17000;i++)print now-1 ",wan,healthy,10,0,1,3,3,20,1.1.1.1,probe_ok"}' > "$QUALITY_DIR/samples"
cmd_health
wc -l < "$QUALITY_DIR/samples"
cat "$QUALITY_DIR/events"
''')
        self.assertIn('no_device', output)
        self.assertIn('16384', output)
        self.assertIn(',outage,', output)

    # --- website test + composite ranking ---------------------------------
    # curl and jsonfilter are shell functions here: the DoH lookup writes its
    # JSON body to the -o file and prints curl's -w timings; page fetches print
    # namelookup/starttransfer/total/http. Every call is logged for inspection.
    WEB_MOCKS = """
collect_wans() { WANS=wan; }
wan_dev() { echo eth0; }
wan_metered() { return 1; }
log() { :; }
jsonfilter() { case "$*" in *Status*) echo 0;; *Answer*) printf 'edge.example\\n93.184.216.34\\n';; esac; }
curl() {
    local out='' prev='' a
    echo "$*" >> curl.log
    for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done
    case "$*" in
        *dns-query*name=www.reddit.com*) printf '0.010 0.030 0.045 500';;
        *dns-query*) echo '{"Status":0}' > "$out"; printf '0.010 0.030 0.045 200';;
        *www.reddit.com*) printf '0.020 0.000 0.000 403';;
        *www.youtube.com*) printf '0.000 0.220 0.900 302';;
        *) printf '0.000 0.180 0.600 200';;
    esac
}
"""

    def test_webtest_measures_dns_and_pages_per_wan(self):
        output = self.shell(self.WEB_MOCKS + """
cmd_webtest >/dev/null
cat "$WEB_FILE"; cat "$WEBSITES_FILE"; cat curl.log
""")
        # DNS = starttransfer - appconnect = 15 ms; pages = mean first byte of the
        # three that answered (180, 220, 180) = 193; reddit's 403 is not a load.
        self.assertRegex(output, r'(?m)^wan 15 193 700 3 4 ok \d+$')
        self.assertRegex(output, r'wan www.facebook.com 15 180 600 200 ok \d+')
        self.assertRegex(output, r'wan www.youtube.com 15 220 900 302 ok \d+')
        # A failed lookup leaves DNS unknown but the page is still fetched, unpinned.
        self.assertRegex(output, r'wan www.reddit.com - 0 0 403 http_403_exit_0 \d+')
        self.assertIn('--interface eth0', output)
        self.assertIn('--resolve www.facebook.com:443:93.184.216.34', output)
        self.assertIn('accept: application/dns-json', output)
        self.assertIn('https://cloudflare-dns.com/dns-query?name=www.facebook.com&type=A', output)
        self.assertIn('-s -4 --interface eth0', output)
        self.assertNotIn('--resolve www.reddit.com', output)

    def test_webtest_busy_skip_and_explicit_targets_keep_prior_rows(self):
        output = self.shell(self.WEB_MOCKS + """
collect_wans() { WANS='wan wan2'; }
g() { case "$1" in busy_skip) echo 1;; busy_mbps) echo 20;; *) echo "$2";; esac; }
wan_busy_mbps() { echo 100; }
printf '# header\\nwan 12 150 500 4 4 ok 1000\\n' > "$WEB_FILE"
printf '# header\\nwan www.facebook.com 12 150 500 200 ok 1000\\n' > "$WEBSITES_FILE"
cmd_webtest >/dev/null
echo "--busy--"; cat "$WEB_FILE" "$WEBSITES_FILE"
wan_busy_mbps() { echo 0; }
cmd_webtest wan2 >/dev/null
echo "--explicit--"; cat "$WEB_FILE" "$WEBSITES_FILE"
""")
        busy, explicit = output.split('--explicit--')
        self.assertIn('wan 12 150 500 4 4 ok 1000', busy)
        self.assertIn('wan www.facebook.com 12 150 500 200 ok 1000', busy)
        self.assertRegex(busy, r'wan2 - - - 0 0 busy \d+')
        self.assertNotIn('wan2 www.', busy)
        # Naming wan2 measures it and leaves wan's rows exactly as they were.
        self.assertIn('wan 12 150 500 4 4 ok 1000', explicit)
        self.assertRegex(explicit, r'wan2 15 193 700 3 4 ok \d+')
        self.assertRegex(explicit, r'wan2 www.facebook.com 15 180 600 200 ok \d+')

    def test_scheduled_tests_skip_links_disabled_in_kmwan(self):
        output = self.shell(self.WEB_MOCKS + """
collect_wans() { WANS='wan wwan'; }
uci() { case "$*" in *kmwan.wwan.disabled) echo 1;; esac; }
cmd_webtest; echo "--- named:"; cmd_webtest wwan | grep wwan
echo "--- speed:"; g() { case "$1" in busy_skip) echo 0;; *) echo "$2";; esac; }
st_one() { echo "$1 1 1 ok"; }
cmd_speedtest | grep -c wwan || true
""")
        scheduled, named = output.split('--- named:')
        self.assertIn('wan 15 193 700 3 4 ok', scheduled)
        self.assertNotIn('wwan', scheduled)
        self.assertRegex(named, r'wwan 15 193 700 3 4 ok')
        self.assertTrue(named.strip().endswith('0'), named)

    def test_webtest_marks_metered_and_missing_device(self):
        output = self.shell(self.WEB_MOCKS + """
collect_wans() { WANS='lte gone'; }
wan_metered() { [ "$1" = lte ]; }
wan_dev() { [ "$1" = gone ] || echo eth0; }
cmd_webtest
""")
        self.assertRegex(output, r'lte - - - 0 0 metered \d+')
        self.assertRegex(output, r'gone - - - 0 0 nodev \d+')

    SCORE_DATA = """
printf '# h\\nfibre 100 20 ok 1\\ncable 60 20 ok 1\\nsilent 120 0 ok 1\\nbroken 500 500 fail 1\\n' > "$SPEED_FILE"
cat > "$WEBSITES_FILE" <<'X'
# h
fibre www.facebook.com 10 100 300 200 ok 1
fibre www.youtube.com 12 100 300 200 ok 1
fibre www.reddit.com 8 900 999 200 ok 1
cable www.facebook.com 20 200 400 200 ok 1
cable www.youtube.com 20 200 400 200 ok 1
cable www.reddit.com - 0 0 403 http_403_exit_0 1
X
"""

    def test_score_compares_common_sites_and_penalises_missing_web_data(self):
        output = self.shell(self.SCORE_DATA + 'cmd_score sum')
        lines = [l.split() for l in output.splitlines()]
        by = {l[1]: l for l in lines}
        self.assertEqual([l[1] for l in lines], ['fibre', 'cable', 'silent'])
        # fibre is best on all three (reddit, which cable could not load, is
        # excluded, so fibre's slow reddit page does not count against it).
        self.assertEqual(by['fibre'][0], '100.0')
        self.assertEqual(by['fibre'][6:8], ['11', '100'])
        self.assertEqual(by['fibre'][10], '2')
        # cable: speed 80/120, DNS 11/20, pages 100/200 -> 50*.667+20*.55+30*.5 = 59.3
        self.assertEqual(by['cable'][0], '59.3')
        self.assertEqual(by['cable'][2:5], ['0.667', '0.550', '0.500'])
        # silent matches fibre on throughput but has no website rows: no credit.
        self.assertEqual(by['silent'][0], '50.0')
        self.assertEqual(by['silent'][3:5], ['0.000', '0.000'])
        self.assertEqual(by['silent'][6:8], ['-', '-'])
        self.assertNotIn('broken', output)

    def test_unmeasurable_components_drop_out_of_the_weighting(self):
        output = self.shell("""
printf '# h\\na 100 20 ok 1\\nb 60 20 ok 1\\n' > "$SPEED_FILE"
cmd_score down
echo "--dns-failed-everywhere--"
printf '# h\\na www.facebook.com - 100 300 200 ok 1\\nb www.facebook.com - 400 900 200 ok 1\\n' > "$WEBSITES_FILE"
cmd_score down
""")
        nothing, nodns = output.split('--dns-failed-everywhere--')
        # No website test yet: plain throughput, still on a 0-100 scale.
        self.assertEqual([l.split()[:2] for l in nothing.splitlines()], [['100.0', 'a'], ['60.0', 'b']])
        # Pages measured but no lookup succeeded anywhere (and no latency
        # samples): 40/25 weights only, b = (40*0.6 + 25*0.25) / 65.
        self.assertEqual([l.split()[:2] for l in nodns.strip().splitlines()], [['100.0', 'a'], ['46.5', 'b']])

    def test_latency_from_monitor_window_counts_and_stale_samples_do_not(self):
        output = self.shell(self.SCORE_DATA + '''
mkdir -p "$QUALITY_DIR"; now=$(date +%s)
# fibre: 10 ms and 30 ms inside the window (mean 20), a 5 ms sample an hour
# ago must be ignored. cable: 40 ms. silent: down (no numeric RTT) -> nothing.
printf '%s,fibre,healthy,5,0,1,3,3,20,1.1.1.1,probe_ok\\n' $((now-3600)) > "$QUALITY_DIR/samples"
printf '%s,fibre,healthy,10,0,1,3,3,20,1.1.1.1,probe_ok\\n' $((now-40)) >> "$QUALITY_DIR/samples"
printf '%s,fibre,healthy,30,0,1,3,3,20,1.1.1.1,probe_ok\\n' $((now-20)) >> "$QUALITY_DIR/samples"
printf '%s,cable,healthy,40,0,1,3,3,20,1.1.1.1,probe_ok\\n' $((now-20)) >> "$QUALITY_DIR/samples"
printf '%s,silent,down,-,100,-,3,0,20,1.1.1.1,probe_failed\\n' $((now-20)) >> "$QUALITY_DIR/samples"
score_latency 300 | sort; echo ---; cmd_score sum
echo ---; rm "$QUALITY_DIR/samples"; printf 'fibre 12.5 0.0 %s 1 3 3 healthy 1.1.1.1 20 probe_ok\\n' "$now" > "$HEALTH_FILE"; cmd_score sum | head -1
''')
        window, scored, fallback = output.split('---')
        self.assertEqual(window.split(), ['cable', '40.0', 'fibre', '20.0'])
        by = {l.split()[1]: l.split() for l in scored.strip().splitlines()}
        # fibre: 100 on everything. cable: (40*.667 + 15*.55 + 25*.5 + 20*.5)/100 = 57.4.
        self.assertEqual(by['fibre'][0], '100.0'); self.assertEqual(by['fibre'][11:13], ['1.000', '20.0'])
        self.assertEqual(by['cable'][0], '57.4'); self.assertEqual(by['cable'][11:13], ['0.500', '40.0'])
        self.assertEqual(by['silent'][11:13], ['0.000', '-'])
        # No monitor window yet: the latest health line stands in.
        self.assertRegex(fallback.strip(), r'^100.0 fibre .* 1.000 12.5$')

    def test_rank_follows_composite_unless_throughput_only(self):
        output = self.shell(self.SCORE_DATA + """
printf '# h\\nfibre 100 20 ok 1\\ncable 200 20 ok 1\\n' > "$SPEED_FILE"
g() { case "$1" in rank_mode) echo "$MODE";; *) echo "$2";; esac; }
MODE=score; echo "--score--"; rank_sorted sum; _wans_by_speed desc; echo; _wans_by_speed asc; echo
MODE=speed; echo "--speed--"; rank_sorted sum; _wans_by_speed desc; echo
""")
        score, speed = output.split('--speed--')
        # cable has almost twice the throughput, fibre answers twice as fast:
        # (40*120/220+15+25)/80 = 77.3 vs (40+15*.55+25*.5)/80 = 75.9 -> fibre still leads.
        self.assertRegex(score, r'77.3 fibre 100 20\n75.9 cable 200 20\nfibre cable \ncable fibre')
        self.assertRegex(speed, r'220.00 cable 200 20\n120.00 fibre 100 20\ncable fibre')

    # --- real-content ("page") speed-test profiles ------------------------
    PAGE_HTML = (r'<script src="https://cdn.example/a.js"></script>'
                 r'{"src":"https:\/\/cdn.example\/big.css","x":1}'
                 r'"https:\\\/\\\/cdn.example\\\/b.js" '
                 r'<img src="https://cdn.example/i.png?x=1&amp;y=2"> '
                 r'<a href="https://cdn.example/a.js">dup</a> https://cdn.example/page.html')

    def test_page_assets_normalise_escapes_and_dedupe(self):
        html = self.file('page.html', self.PAGE_HTML)
        output = self.shell(f'st_page_assets {html} 10; echo ---; st_page_assets {html} 2')
        assert output.split('---')[0].split() == [
            'https://cdn.example/a.js', 'https://cdn.example/big.css',
            'https://cdn.example/b.js', 'https://cdn.example/i.png?x=1&y=2'], output
        self.assertEqual(output.split('---')[1].split(), ['https://cdn.example/a.js', 'https://cdn.example/big.css'])

    def test_page_profile_measures_real_content_throughput(self):
        html = self.file('page.html', self.PAGE_HTML)
        # Mock curl: the page fetch copies the HTML to -o; every asset transfer
        # is 1,000,000 bytes in 0.5 s. A multi-URL call with %{stderr} in -w
        # (phase 2) reports one line per URL on stderr, as curl does.
        output = self.shell(f'''
collect_wans() {{ WANS=wan; }}
g() {{ case "$1" in active_server) echo facebook;; st_bytes) echo 4000000;; st_streams) echo 2;; busy_skip) echo 0;; *) echo "$2";; esac; }}
uci() {{ case "$*" in *facebook.down_url) echo 'https://page.example/';; *facebook.kind) echo page;;
    *facebook.label) echo 'Facebook (real content)';; *facebook.up_url) ;; *facebook) echo server;; esac; }}
wan_metered() {{ return 1; }}
wan_dev() {{ echo eth0; }}
log() {{ :; }}
curl() {{
    local out='' fmt='' prev='' a urls='' n=0
    echo "$*" >> curl.log
    for a in "$@"; do
        case "$prev" in -o) out="$a";; -w) fmt="$a";; esac
        case "$a" in http://*|https://*) urls="$urls $a"; n=$((n+1));; esac
        prev="$a"
    done
    case "$*" in *--data-binary*) cat >/dev/null; echo '1000000 200 1000000 1 https://speed.cloudflare.com/__up'; return 0;; esac
    case "$urls" in *page.example*) cp {html} "$out"; return 0;; esac
    case "$fmt" in
        '%{{stderr}}'*) for a in $urls; do echo "1000000 200 0.5 $a" >&2; done;;
        *) echo "1000000 200 0.5 ${{urls# }}";;
    esac
}}
ST_KIND=manual cmd_speedtest
echo ---; cat /dev/null "$SPEEDHIST_FILE"; hist_flush; cat "$HIST_DIR/tests.csv"
grep -c 'stderr' curl.log
''')
        # 2 streams x 2 repetitions of the 1 MB asset: each stream 2 MB / 1.0 s
        # = 16 Mbps, summed 32 Mbps; upload is 2 streams x the mocked 8 Mbps.
        self.assertRegex(output, r'(?m)^wan 32.00 16.00 ok \d+$')
        self.assertIn(',wan,32.00,16.00,ok,manual,Facebook (real content),facebook,cdn.example,speed.cloudflare.com,ok,ok', output)
        self.assertTrue(output.strip().endswith('2'), output)  # one phase-2 call per stream

    def test_website_test_measures_real_content_for_every_page_profile(self):
        html = self.file('page.html', self.PAGE_HTML)
        output = self.shell(f'''
collect_wans() {{ WANS=wan; }}
g() {{ case "$1" in st_bytes) echo 4000000;; st_streams) echo 2;; busy_skip) echo 0;; *) echo "$2";; esac; }}
uci() {{ case "$*" in
    "show multikmwan") printf "multikmwan.cf=server\\nmultikmwan.cf.kind='file'\\nmultikmwan.facebook=server\\nmultikmwan.facebook.kind='page'\\nmultikmwan.facebook.down_url='https://page.example/'\\n";;
    *facebook.down_url) echo 'https://page.example/';; esac; }}
wan_metered() {{ return 1; }}
wan_dev() {{ echo eth0; }}
log() {{ :; }}
jsonfilter() {{ :; }}
curl() {{
    local out='' fmt='' prev='' a urls=''
    for a in "$@"; do
        case "$prev" in -o) out="$a";; -w) fmt="$a";; esac
        case "$a" in http://*|https://*) urls="$urls $a";; esac
        prev="$a"
    done
    case "$urls" in *page.example*) cp {html} "$out"; return 0;; esac
    case "$fmt" in
        '%{{stderr}}'*) for a in $urls; do echo "1000000 200 0.5 $a" >&2; done;;
        *) echo "1000000 200 0.5 ${{urls# }}";;
    esac
}}
cmd_webtest >/dev/null; cat "$CONTENT_FILE"
''')
        # Only the "page" profile is measured: 2 streams x 2 MB / 1 s = 32 Mbps.
        self.assertRegex(output, r'(?m)^wan facebook 32.00 ok cdn.example \d+$')
        self.assertNotIn(' cf ', output)

    RETRY_MOCKS = """
collect_wans() { WANS=wan; }
g() { case "$1" in st_streams) echo 1;; st_bytes) echo 1000000;; busy_skip) echo 0;; *) echo "$2";; esac; }
wan_metered() { return 1; }
wan_dev() { echo eth0; }
log() { echo "LOG $*" >> log.txt; }
sleep() { :; }
# Downloads fail (curl exit 28, a timeout) for the first FAIL_FIRST calls.
curl() {
    local n; n=$(cat calls 2>/dev/null || echo 0); n=$((n+1)); echo $n > calls
    case "$*" in *--data-binary*) cat >/dev/null; echo '1000000 200 1000000 1 https://up.example/x'; return 0;; esac
    if [ "$n" -le "${FAIL_FIRST:-0}" ]; then echo '0 200 100 25.0 https://dl.example/f'; return 28; fi
    echo '1000000 200 1000000 1 https://dl.example/f'
}
"""

    def test_failed_transfer_is_retried_once(self):
        output = self.shell(self.RETRY_MOCKS + """
FAIL_FIRST=1 ST_KIND=manual cmd_speedtest; echo "calls=$(cat calls)"; grep -c retrying log.txt
""")
        self.assertRegex(output, r'(?m)^wan 8.00 8.00 ok \d+$')
        self.assertIn('calls=3', output)      # download, download again, upload
        self.assertTrue(output.strip().endswith('1'))

    def test_run_that_still_fails_keeps_a_recent_result_but_not_an_old_one(self):
        output = self.shell(self.RETRY_MOCKS + """
now=$(date +%s)
printf '# h\\nwan 50.00 20.00 ok %s\\n' $((now - 600)) > "$SPEED_FILE"
FAIL_FIRST=9 ST_KIND=manual cmd_speedtest >/dev/null; echo "--- kept:"; cat "$SPEED_FILE"; hist_flush; grep ',wan,' "$HIST_DIR/tests.csv"
rm -f calls; printf '# h\\nwan 50.00 20.00 ok %s\\n' $((now - 30000)) > "$SPEED_FILE"
FAIL_FIRST=9 ST_KIND=manual cmd_speedtest >/dev/null; echo "--- dropped:"; cat "$SPEED_FILE"
""")
        kept, dropped = output.split('--- dropped:')
        # The 10-minute-old good result stands; the failed attempt is logged.
        self.assertRegex(kept, r'(?m)^wan 50.00 20.00 ok \d+$')
        self.assertIn(',wan,0.00,8.00,fail,manual,', kept)
        self.assertIn('http_200_exit_28', kept)
        # An 8-hour-old result is too old to stand in.
        self.assertRegex(dropped, r'(?m)^wan 0.00 8.00 fail \d+$')

    def test_autorank_never_demotes_a_leader_that_was_not_measured(self):
        output = self.shell("""
g() { case "$1" in rank_mode) echo speed;; auto_margin) echo 15;; *) echo "$2";; esac; }
log() { :; }
cmd_speedtest() { return 0; }
current_order() { echo "wan wan2 "; }
rank_sorted() { echo "100 wan2 50 50"; }
rank_apply() { echo APPLIED; }
cmd_autorank; cat "$AUTO_FILE"
""")
        self.assertIn('leader-unmeasured', output)
        self.assertNotIn('APPLIED', output)

    def test_page_profile_without_assets_fails_loudly(self):
        html = self.file('page.html', '<html>no assets here</html>')
        output = self.shell(f'''
collect_wans() {{ WANS=wan; }}
g() {{ case "$1" in active_server) echo blank;; st_streams) echo 2;; busy_skip) echo 0;; *) echo "$2";; esac; }}
uci() {{ case "$*" in *blank.down_url) echo 'https://page.example/';; *blank.kind) echo page;; *blank.label) echo Blank;; *blank.up_url) ;; *blank) echo server;; esac; }}
wan_metered() {{ return 1; }}
wan_dev() {{ echo eth0; }}
log() {{ :; }}
curl() {{ case "$*" in *--data-binary*) cat >/dev/null; echo '1000000 200 1000000 1 https://up.example/';; *) cp {html} "$(echo " $*" | sed 's/.* -o \\([^ ]*\\).*/\\1/')";; esac; }}
ST_KIND=manual cmd_speedtest; hist_flush; cat "$HIST_DIR/tests.csv"
''')
        self.assertRegex(output, r'(?m)^wan 0.00 16.00 fail \d+$')
        self.assertIn('http_000_exit_noassets', output)

    def test_flock_wait_polls_without_the_w_flag(self):
        # GL.iNet's BusyBox flock rejects -w; the helper must only ever use -n.
        output = self.shell('''
flock() { echo "flock $*" >> flock.log; case "$*" in *-w*) exit 99;; esac
    n=$(cat n 2>/dev/null || echo 0); n=$((n+1)); echo $n > n; [ $n -ge 3 ]; }
sleep() { :; }
flock_wait 8 5 -s && echo "locked after $(cat n) tries"
rm -f n; flock_wait 8 2 || echo "gave up after $(cat n) tries"
cat flock.log
''')
        self.assertIn('locked after 3 tries', output)
        self.assertIn('gave up after 2 tries', output)
        self.assertIn('flock -n -s 8', output)
        self.assertNotIn('-w', output)

    def test_probe_without_result_is_unknown_not_shifted(self):
        output = self.shell('''
uci() { :; }
wan_dev() { echo eth0; }
network_is_up() { return 0; }
wan_track_ip() { echo 1.1.1.1; }
ping() { :; }
awk() { :; }
health_one wan 20
''')
        self.assertRegex(output, r'^wan - - \d+ - 0 0 unknown 1.1.1.1 20 probe_error$')

    @unittest.skipUnless(os.name != 'nt' and shutil.which('flock'), 'requires native Linux flock')
    def test_health_and_speed_locks_are_independent(self):
        output = self.shell('''
collect_wans() { WANS=wan; }
g() { echo 20; }
uci() { :; }
wan_dev() { :; }
wan_track_ip() { echo 1.1.1.1; }
hist_rollup() { :; }
(flock 7; echo ready > ready; sleep 3) 7>"''' + self.dir.as_posix() + '''/multikmwan-speed.lock" &
while [ ! -f ready ]; do sleep .1; done
cmd_health
[ -s "$HEALTH_FILE" ]
wait
''', real_locks=True)
        self.assertIn('no_device', output)


if __name__ == '__main__':
    unittest.main()
