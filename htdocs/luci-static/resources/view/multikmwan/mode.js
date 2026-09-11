'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require ui';

var callSetMode = rpc.declare({ object: 'luci.multikmwan', method: 'setmode',
                                params: [ 'mode' ] });
var callStServers = rpc.declare({ object: 'luci.multikmwan', method: 'stservers',
                                  params: [ 'search' ] });
var callAddServer = rpc.declare({ object: 'luci.multikmwan', method: 'add_server',
                                  params: [ 'label', 'down', 'up' ] });

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

		m = new form.Map('kmwan', _('Multi-WAN Mode & Priority'),
			_('Failover uses one WAN at a time, picking the lowest priority number ' +
			  'that is up. Load balance spreads NEW connections across the WANs in ' +
			  'proportion to their ratio — note that a single connection always ' +
			  'stays on one WAN, so one download will not exceed one line\'s speed.'));

		s = m.section(form.NamedSection, 'global', 'global', _('Global'));

		// Meta-mode. "Fastest" isn't a kmwan mode - it's failover + auto-rank,
		// translated on save. cfgvalue derives the current choice from state.
		o = s.option(form.ListValue, '_mode_pref', _('Mode'),
			_('Failover uses one link at a time by priority. Load balance shares ' +
			  'new connections by ratio. Fastest keeps the fastest link primary by ' +
			  're-testing on a schedule (failover + auto-rank).'));
		o.value('failover', _('Failover — one link at a time, by priority'));
		o.value('balancing', _('Load balance — share by ratio'));
		o.value('fastest', _('Fastest — always the fastest link (auto-tested)'));
		o.cfgvalue = function() {
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

		o = s.option(form.ListValue, '_rank_by', _('Rank by'),
			_('Which measurement decides the fastest WAN, for both the manual ' +
			  '"Rank WANs" button and auto-rank.'));
		o.value('sum', _('Download + upload'));
		o.value('down', _('Download only'));
		o.value('up', _('Upload only'));
		mkopt('rank_by', 'sum');

		o = s.option(form.Value, '_auto_rank', _('Auto-rank every'),
			_('Minutes. 0 disables. Re-tests the non-metered WANs and puts the ' +
			  'fastest first. Each applied change restarts kmwan, so see the margin below.'));
		o.datatype = 'range(0,1440)';
		o.placeholder = '15';
		mkopt('auto_rank', '0');

		o = s.option(form.Value, '_auto_margin', _('Only switch if faster by'),
			_('Percent. A new leader must beat the current one by this much before ' +
			  'kmwan is reconfigured - stops two similar lines flip-flopping.'));
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

		// --- your own speed-test servers (separate map: profiles live in the
		//     multikmwan config, not kmwan, so the grid must bind to it) ---
		var m2 = new form.Map('multikmwan');
		s = m2.section(form.GridSection, 'server', _('Speed-test servers'),
			_('Define your own servers here, then pick one above. Use the ' +
			  '"Browse speedtest.net" button to add a nearby Ookla server, or add ' +
			  'one manually — {bytes} in the download URL is replaced with the test ' +
			  'size, or point at a fixed-size file and leave {bytes} out.'));
		s.addremove = true;
		s.anonymous = false;
		s.nodescriptions = true;

		o = s.option(form.Value, 'label', _('Name'));
		o.placeholder = _('Home NAS');

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
			return E('div', {}, nodes);
		});
	},

	handleSave: function(ev) {
		return Promise.all(this.maps.map(function(mp) { return mp.save(); }));
	},

	handleReset: function(ev) {
		return Promise.all(this.maps.map(function(mp) { return mp.reset(); }));
	},

	handleSaveApply: function(ev) {
		return this.handleSave(ev).then(function() {
			// Translate the meta-mode into kmwan mode + auto-rank.
			var pref = uci.get('multikmwan', 'global', 'mode_pref') || 'failover';
			var kmMode = (pref === 'balancing') ? 'balancing' : 'failover';
			if (pref === 'fastest') {
				var ar = parseInt(uci.get('multikmwan', 'global', 'auto_rank') || '0', 10);
				if (!(ar > 0)) uci.set('multikmwan', 'global', 'auto_rank', '15');
			}
			uci.set('kmwan', 'global', 'mode', kmMode);
			return uci.apply();          // commit kmwan + multikmwan to flash
		}).then(function() {
			return callSetMode(uci.get('kmwan', 'global', 'mode') || 'failover');
		}).then(function() {
			ui.addNotification(null,
				E('p', _('Applied — kmwan restarted with the new settings.')), 'info');
		});
	}
});
