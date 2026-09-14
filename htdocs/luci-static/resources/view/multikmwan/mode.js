'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require ui';
'require multikmwan';

var callSetMode = rpc.declare({ object: 'luci.multikmwan', method: 'setmode',
                                params: [ 'mode' ] });
var callApplyMode = rpc.declare({ object: 'luci.multikmwan', method: 'applymode' });
var callStServers = rpc.declare({ object: 'luci.multikmwan', method: 'stservers',
                                  params: [ 'search' ] });
var callAddServer = rpc.declare({ object: 'luci.multikmwan', method: 'add_server',
                                  params: [ 'label', 'down', 'up' ] });

// Mirrors WEB_DEFAULT_SITES / WEB_DEFAULT_DNS in the backend: what runs when
// nothing is configured, so the form shows the real defaults, not blanks.
var DEFAULT_SITES = [ 'https://www.facebook.com/', 'https://www.youtube.com/',
                      'https://drive.google.com/', 'https://www.reddit.com/' ];
var DEFAULT_DNS = 'https://cloudflare-dns.com/dns-query?name={name}&type=A';

// Modal: search/browse speedtest.net (Ookla) servers and add one as a profile.
// Each Ookla server speaks the classic HTTP protocol (random*.jpg download +
// upload.php), which our fixed-file test handles.
function browseSpeedtestNet() {
	var listBox = E('div', { 'style': 'max-height:48vh;overflow:auto;margin-top:8px' });
	var input = E('input', { 'type': 'text', 'class': 'cbi-input-text',
		'style': 'flex:1',
		'placeholder': _('Search by city, ISP or name — blank for nearest') });

	function rowFor(sv) {
		var title = sv.sponsor + ' — ' + sv.name +
			(sv.cc ? ', ' + sv.cc : '') + (sv.dist ? '  (' + sv.dist + ' km)' : '');
		return E('div', { 'style': 'display:flex;justify-content:space-between;' +
			'align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(128,128,128,.15)' }, [
			E('span', {}, title),
			E('button', { 'class': 'cbi-button cbi-button-add',
				'click': function() {
					callAddServer(sv.sponsor + ' (' + sv.name + ')', sv.down, sv.up).then(function() {
						ui.hideModal();
						ui.addNotification(null, E('p', _('Added ') + sv.sponsor +
							_('. It is now in the Speed-test server list.')), 'info');
						window.setTimeout(function() { location.reload(); }, 800);
					});
				} }, _('Add'))
		]);
	}

	function load(q) {
		listBox.innerHTML = '';
		listBox.appendChild(E('p', { 'class': 'spinning' },
			q ? _('Searching…') : _('Finding nearby servers…')));
		callStServers(q || '').then(function(res) {
			var servers = (res && res.servers) || [];
			listBox.innerHTML = '';
			if (!servers.length) {
				listBox.appendChild(E('p', {}, _('No servers found. Try another ' +
					'search term, or check the router has internet.')));
				return;
			}
			servers.forEach(function(sv) { listBox.appendChild(rowFor(sv)); });
		}).catch(function(e) {
			listBox.innerHTML = '';
			listBox.appendChild(E('p', {}, _('Could not fetch the list: ') + (e.message || e)));
		});
	}

	input.addEventListener('keydown', function(ev) {
		if (ev.key === 'Enter') { ev.preventDefault(); load(input.value.trim()); }
	});

	ui.showModal(_('Add a speedtest.net server'), [
		E('p', {}, _('Search Ookla servers by city, ISP or name, or leave blank ' +
			'for the nearest. Add one, then pick it as the Speed-test server above.')),
		E('div', { 'style': 'display:flex;gap:8px' }, [
			input,
			E('button', { 'class': 'cbi-button cbi-button-action',
				'click': function() { load(input.value.trim()); } }, _('Search'))
		]),
		listBox,
		E('div', { 'class': 'right', 'style': 'margin-top:10px' }, [
			E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Close'))
		])
	]);
	load('');
}

return view.extend({
	load: function() { return Promise.all([ uci.load('kmwan'), uci.load('multikmwan') ]); },

	render: function() {
		var m, s, o;

		m = new form.Map('kmwan', _('Multi-WAN Settings'),
			_('Failover uses one WAN at a time, picking the lowest priority number ' +
			  'that is up. Load balance spreads NEW connections across the WANs in ' +
			  'proportion to their ratio — note that a single connection always ' +
			  'stays on one WAN, so one download will not exceed one line\'s speed.'));

		s = m.section(form.NamedSection, 'global', 'global', _('Global'));

		// Meta-mode. "Fastest" isn't a kmwan mode - it's failover + auto-rank,
		// translated on save. cfgvalue derives the current choice from state.
		o = s.option(form.ListValue, '_mode_pref', _('Mode'),
			_('Failover uses one link at a time by priority. Load balance shares ' +
			  'new connections by ratio. Fastest keeps the best link primary by ' +
			  're-testing throughput, website response, latency and DNS on a ' +
			  'schedule (failover + auto-rank).'));
		o.value('failover', _('Failover — one link at a time, by priority'));
		o.value('balancing', _('Load balance — share by ratio'));
		o.value('fastest', _('Fastest — always the best-scoring link (auto-tested)'));
		o.cfgvalue = function() {
			// The user's stored choice is the source of truth; fall back to a
			// derivation only for configs from before mode_pref existed.
			var mp = uci.get('multikmwan', 'global', 'mode_pref');
			if (mp) return mp;
			var km = uci.get('kmwan', 'global', 'mode') || 'failover';
			var ar = parseInt(uci.get('multikmwan', 'global', 'auto_rank') || '0', 10);
			if (km !== 'failover') return 'balancing';
			return ar > 0 ? 'fastest' : 'failover';
		};
		o.write = function(sid, v) { uci.set('multikmwan', 'global', 'mode_pref', v); };
		o.rmempty = false;

		o = s.option(form.Value, 'sensitivity', _('Sensitivity'),
			_('Detection interval in ms. Lower switches faster but is more jittery.'));
		o.datatype = 'uinteger';
		o.default = '5000';

		// --- scheduled ranking (stored in multikmwan.global, shown here) ---
		function mkopt(name, def) {
			var opt = o;
			opt.cfgvalue = function() { return uci.get('multikmwan', 'global', name) || def; };
			opt.write = function(sid, v) { uci.set('multikmwan', 'global', name, v); };
			opt.remove = function() { uci.set('multikmwan', 'global', name, def); };
			opt.rmempty = false;
		}

		o = s.option(form.ListValue, '_rank_mode', _('Fastest means'),
			_('Composite scores every link against the best one on four things: ' +
			  'throughput from the speed test, website response (time to first ' +
			  'byte of real pages, fetched over each link), ping latency from the ' +
			  'background monitor, and DNS lookup time. Throughput only ignores ' +
			  'the rest. Used by auto-rank, the "Rank WANs" button and the ' +
			  'Fastest / Slowest client roles.'));
		o.value('score', _('Composite — throughput + website response + latency + DNS'));
		o.value('speed', _('Throughput only'));
		mkopt('rank_mode', 'score');

		o = s.option(form.ListValue, '_rank_by', _('Throughput measure'),
			_('Which speed-test figure stands for throughput.'));
		o.value('sum', _('Download + upload'));
		o.value('down', _('Download only'));
		o.value('up', _('Upload only'));
		mkopt('rank_by', 'sum');

		o = s.option(form.Value, '_score_w_speed', _('Weight: throughput'),
			_('Share of the composite score. The four weights are normalised, ' +
			  'so they need not add up to 100.'));
		o.datatype = 'range(0,100)';
		mkopt('score_w_speed', '40');

		o = s.option(form.Value, '_score_w_web', _('Weight: website response'),
			_('Time to first byte of each test page, averaged. Latency to the big ' +
			  'CDNs is what makes browsing feel fast, so this is worth a large share.'));
		o.datatype = 'range(0,100)';
		mkopt('score_w_web', '25');

		o = s.option(form.Value, '_score_w_latency', _('Weight: latency'),
			_('Mean ping round trip to each link\'s probe target over the last ' +
			  '5 minutes, from the background monitor. Costs no extra traffic.'));
		o.datatype = 'range(0,100)';
		mkopt('score_w_latency', '20');

		o = s.option(form.Value, '_score_w_dns', _('Weight: DNS lookup'),
			_('Median lookup time for the test pages\' hostnames, measured over ' +
			  'each link.'));
		o.datatype = 'range(0,100)';
		mkopt('score_w_dns', '15');

		o = s.option(form.DynamicList, '_web_sites', _('Test websites'),
			_('Pages fetched over each WAN in every website test: one DNS lookup ' +
			  'and one page download (a few hundred KB) each. Redirects count as ' +
			  'a response, so a login or consent page is fine.'));
		o.placeholder = 'https://www.example.com/';
		o.cfgvalue = function() {
			var v = uci.get('multikmwan', 'global', 'web_sites');
			if (!v || !v.length) return DEFAULT_SITES.slice();
			return Array.isArray(v) ? v : String(v).trim().split(/\s+/);
		};
		o.write = function(sid, v) { uci.set('multikmwan', 'global', 'web_sites', v); };
		o.remove = function(sid) { uci.unset('multikmwan', 'global', 'web_sites'); };

		o = s.option(form.Value, '_dns_url', _('DNS test resolver'),
			_('A DNS-over-HTTPS JSON endpoint; {name} is replaced with each ' +
			  'hostname. A plain UDP lookup cannot be pinned to one WAN, this can. ' +
			  'Only the query round trip is timed, so the resolver\'s own name ' +
			  'costs nothing. Cloudflare (default) and Google ' +
			  'https://dns.google/resolve?name={name} both work.'));
		o.placeholder = DEFAULT_DNS;
		mkopt('dns_url', DEFAULT_DNS);

		o = s.option(form.Value, '_web_timeout', _('Website test timeout'),
			_('Seconds allowed per lookup and per page.'));
		o.datatype = 'range(3,60)';
		mkopt('web_timeout', '10');

		o = s.option(form.Value, '_auto_rank', _('Auto-rank every'),
			_('Minutes. 0 disables. Re-tests the non-metered WANs (speed, then ' +
			  'websites) and puts the best first. Each applied change restarts ' +
			  'kmwan, so see the margin below.'));
		o.datatype = 'range(0,1440)';
		o.placeholder = '15';
		mkopt('auto_rank', '0');

		o = s.option(form.Value, '_auto_margin', _('Only switch if faster by'),
			_('Percent of the score. A new leader must beat the current one by ' +
			  'this much before kmwan is reconfigured - stops two similar lines ' +
			  'flip-flopping.'));
		o.datatype = 'range(0,100)';
		mkopt('auto_margin', '15');

		function sizes(opt) {
			[ 5, 10, 25, 50, 100, 250 ].forEach(function(mb) {
				opt.value(String(mb * 1000000), mb + ' MB');
			});
		}

		o = s.option(form.ListValue, '_auto_bytes', _('Scheduled test size'),
			_('Per direction, per WAN, each scheduled run. Metered links are never tested.'));
		sizes(o);
		mkopt('auto_bytes', '10000000');

		// --- active speed-test server ---
		o = s.option(form.ListValue, '_active_server', _('Speed-test server'),
			_('Which server the tests run against. Add your own below to avoid ' +
			  'public servers.'));
		o.value('', _('Fallback URLs (below)'));
		uci.sections('multikmwan', 'server').forEach(function(sv) {
			o.value(sv['.name'], (sv.label || sv['.name']) + ' — ' + sv['.name']);
		});
		mkopt('active_server', '');

		// --- fallback URLs, used when no server profile is active ---
		o = s.option(form.Value, '_st_down_url', _('Fallback download URL'),
			_('Used when no server is selected above. {bytes} = the test size, or ' +
			  'point at a fixed-size file (e.g. https://my-server/100MB.bin).'));
		o.placeholder = 'https://speed.cloudflare.com/__down?bytes={bytes}';
		mkopt('st_down_url', 'https://speed.cloudflare.com/__down?bytes={bytes}');

		o = s.option(form.Value, '_st_up_url', _('Fallback upload URL'),
			_('Must accept a raw POST body. Leave as-is if you only care about download.'));
		o.placeholder = 'https://speed.cloudflare.com/__up';
		mkopt('st_up_url', 'https://speed.cloudflare.com/__up');

		o = s.option(form.ListValue, '_st_bytes', _('Manual test size'),
			_('Per direction, per WAN, for the Run speed test button.'));
		sizes(o);
		mkopt('st_bytes', '25000000');

		o = s.option(form.Value, '_st_timeout', _('Test timeout'),
			_('Seconds per direction. The rate achieved before the cut-off is still recorded.'));
		o.datatype = 'range(5,300)';
		mkopt('st_timeout', '25');

		o = s.option(form.ListValue, '_st_streams', _('Parallel streams'),
			_('Simultaneous connections per test. A single stream cannot fill a ' +
			  'fast link over real latency, so raise this for accurate results on ' +
			  'fast lines or distant servers (like real speed tests do).'));
		[ 1, 2, 4, 8, 16 ].forEach(function(n) { o.value(String(n), String(n)); });
		mkopt('st_streams', '4');

		o = s.option(form.Flag, '_busy_skip', _('Skip when busy'),
			_('Skip a test on a link that is already carrying traffic, and keep ' +
			  'its last result. A test under load would under-report and disrupt ' +
			  'what is running. Applies to scheduled runs and the Status page ' +
			  'buttons; a link named on the command line is always tested.'));
		mkopt('busy_skip', '1');

		o = s.option(form.Value, '_busy_mbps', _('Busy threshold'),
			_('Mbps of current traffic (down+up) above which a link counts as busy ' +
			  'and its scheduled test is skipped.'));
		o.datatype = 'range(1,10000)';
		mkopt('busy_mbps', '20');

		// --- your own speed-test servers (separate map: profiles live in the
		//     multikmwan config, not kmwan, so the grid must bind to it) ---
		var m2 = new form.Map('multikmwan');
		s = m2.section(form.GridSection, 'server', _('Speed-test servers'),
			_('Define your own servers here, then pick one above. Use the ' +
			  '"Browse speedtest.net" button to add a nearby Ookla server, or add ' +
			  'one manually — {bytes} in the download URL is replaced with the test ' +
			  'size, or point at a fixed-size file and leave {bytes} out. A "Web ' +
			  'page" server downloads a real site\'s own scripts and images from its ' +
			  'CDN instead (e.g. https://www.facebook.com/), which shows what a line ' +
			  'actually delivers for that site — ISPs often give speedtest servers ' +
			  'a fast lane that real content never gets. Upload always uses the ' +
			  'profile\'s upload URL or the fallback.'));
		s.addremove = true;
		s.anonymous = false;
		s.nodescriptions = true;

		o = s.option(form.Value, 'label', _('Name'));
		o.placeholder = _('Home NAS');

		o = s.option(form.ListValue, 'kind', _('Type'));
		o.value('file', _('File or sized endpoint'));
		o.value('page', _('Web page — its real content'));
		o.default = 'file';
		// The grid shows the raw key otherwise.
		o.textvalue = function(sid) {
			return this.cfgvalue(sid) === 'page' ? _('Web page') : _('File');
		};

		o = s.option(form.Value, 'down_url', _('Download URL'));
		o.placeholder = 'http://192.168.0.50/100MB.bin';

		o = s.option(form.Value, 'up_url', _('Upload URL'));
		o.placeholder = _('(optional)');
		o.modalonly = true;

		// --- WAN interfaces (kmwan members): its own kmwan map ---
		var m3 = new form.Map('kmwan');
		s = m3.section(form.GridSection, 'member', _('WAN Interfaces'),
			_('Priority orders failover (lower wins). Ratio weights load balance.'));
		s.addremove = false;
		s.anonymous = false;
		s.nodescriptions = true;
		s.filter = function(section_id) {
			return uci.get('kmwan', section_id, 'addr_type') === '4';
		};

		o = s.option(form.Flag, 'disabled', _('Disabled'),
			_('A disabled member is not health-tracked by kmwan.'));
		o.editable = true;

		// Stored in /etc/config/multikmwan (config wan '<iface>'), not in
		// kmwan's own config, which GL's UI owns and may rewrite.
		o = s.option(form.Flag, 'metered', _('Backup only'),
			_('Metered / capped link. Never speed-tested (a test costs ~50 MB), ' +
			  'ranked last, and given ratio 0. NOTE: kmwan never routes through a ' +
			  'ratio-0 WAN in load-balance mode, not even when everything else is ' +
			  'down - use failover mode if this link must be a last resort.'));
		o.editable = true;
		o.rmempty = false;
		o.cfgvalue = function(sid) {
			return uci.get('multikmwan', sid, 'metered') || '0';
		};
		o.write = function(sid, v) {
			if (!uci.get('multikmwan', sid))
				uci.add('multikmwan', 'wan', sid);
			uci.set('multikmwan', sid, 'metered', v);
		};
		o.remove = function(sid) {
			if (uci.get('multikmwan', sid))
				uci.set('multikmwan', sid, 'metered', '0');
		};

		o = s.option(form.Value, 'interface', _('Interface'));
		o.readonly = true;

		o = s.option(form.Value, 'metric', _('Priority'),
			_('Lower number = preferred in failover mode.'));
		o.datatype = 'range(1,255)';

		o = s.option(form.Value, 'weight', _('Ratio'),
			_('Relative share in load-balance mode.'));
		o.datatype = 'range(1,100)';

		o = s.option(form.ListValue, 'track_mode', _('Detection'));
		o.value('strict', _('Strict'));
		o.value('force', _('Normal'));
		o.modalonly = true;

		o = s.option(form.DynamicList, 'tracks', _('Track targets'),
			_('Format: ping,1.1.1.1'));
		o.modalonly = true;

		// Three maps: kmwan globals (m), multikmwan servers (m2), kmwan members (m3).
		this.maps = [ m, m2, m3 ];
		return Promise.all([ m.render(), m2.render(), m3.render() ]).then(function(nodes) {
			// Add the "Browse speedtest.net" button to the servers map (nodes[1]).
			var host = nodes[1].querySelector('.cbi-section-create');
			if (host)
				host.appendChild(E('button', {
					'class': 'cbi-button cbi-button-action',
					'style': 'margin-left:8px',
					'click': function(ev) { ev.preventDefault(); browseSpeedtestNet(); }
				}, _('Browse speedtest.net')));
			return E('div', {}, [ E('div', { 'class': 'right' }, multikmwan.privacyButton()) ].concat(nodes));
		});
	},

	handleSave: function(ev) {
		return Promise.all(this.maps.map(function(mp) { return mp.save(); }));
	},

	handleReset: function(ev) {
		return Promise.all(this.maps.map(function(mp) { return mp.reset(); }));
	},

	handleSaveApply: function(ev) {
		// Save + commit the maps, then let the backend translate mode_pref into
		// kmwan settings (reads the committed value, so no stale-uci races) and
		// restart kmwan. uci.apply here can report "no data" on this firmware
		// even though it commits, so its error is swallowed; applymode is the
		// authoritative step and reloads state.
		return this.handleSave(ev).then(function() {
			return uci.apply().catch(function() {});
		}).then(function() {
			return callApplyMode();
		}).then(function() {
			ui.addNotification(null,
				E('p', _('Applied — kmwan restarted with the new settings.')), 'info');
			window.setTimeout(function() { location.reload(); }, 700);
		}).catch(function(e) {
			ui.addNotification(null, E('p', _('Save failed: ') + (e.message || e)), 'error');
		});
	}
});
