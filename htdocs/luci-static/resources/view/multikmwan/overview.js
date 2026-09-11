'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

var callStatus = rpc.declare({ object: 'luci.multikmwan', method: 'status' });
var callSync   = rpc.declare({ object: 'luci.multikmwan', method: 'sync' });
var callSpeed  = rpc.declare({ object: 'luci.multikmwan', method: 'speedtest' });
var callGeo    = rpc.declare({ object: 'luci.multikmwan', method: 'geo' });
var callHealth = rpc.declare({ object: 'luci.multikmwan', method: 'health' });
var callRank   = rpc.declare({ object: 'luci.multikmwan', method: 'rank',
                               params: [ 'by', 'what' ] });

var CSS = '' +
'.mk-grid{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:1.2em}' +
'.mk-card{flex:1 1 280px;border:1px solid rgba(128,128,128,.3);border-left-width:5px;' +
'border-radius:8px;padding:13px 16px;background:rgba(128,128,128,.05)}' +
'.mk-card.b-ok{border-left-color:#1f8b4c}.mk-card.b-warn{border-left-color:#d9a400}' +
'.mk-card.b-down{border-left-color:#b3312c}.mk-card.b-idle{border-left-color:#8a8a8a}' +
'.mk-card h4{margin:0 0 6px 0;font-size:1.05em;display:flex;' +
'justify-content:space-between;align-items:center;gap:8px}' +
'.mk-pill{font-size:.7em;font-weight:600;padding:2px 9px;border-radius:10px;' +
'text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;color:#fff}' +
'.mk-ok{background:#1f8b4c}.mk-warn{background:#d9a400}' +
'.mk-down{background:#b3312c}.mk-idle{background:#8a8a8a}' +
'.mk-meta{font-size:.84em;opacity:.8;line-height:1.6}' +
'.mk-geo b{font-weight:600}' +
'.mk-note{color:#d9a400;font-weight:600}' +
'.mk-tag{font-size:.65em;font-weight:600;margin-left:8px;padding:1px 7px;border-radius:8px;border:1px solid rgba(128,128,128,.5);opacity:.75;text-transform:uppercase;letter-spacing:.04em}' +
'.mk-stats{display:flex;gap:16px;margin:9px 0 4px 0}' +
'.mk-stat span{display:block;font-size:.7em;text-transform:uppercase;' +
'letter-spacing:.05em;opacity:.6}' +
'.mk-stat b{font-size:1.05em;font-weight:600}' +
'.mk-speed{font-size:.88em;display:flex;gap:12px;align-items:baseline;margin-top:4px}' +
'.mk-speed b{font-weight:600}' +
'.mk-dim{opacity:.55;font-size:.9em}' +
'.mk-bar{height:6px;border-radius:4px;background:rgba(128,128,128,.25);' +
'margin-top:7px;overflow:hidden}.mk-bar span{display:block;height:100%;background:#2a6fb5}' +
'.mk-foot{font-size:.78em;opacity:.6;margin-top:7px}' +
'.mk-rules{font-family:monospace;font-size:.85em;line-height:1.7}' +
'.mk-dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:6px;vertical-align:middle}' +
'.mk-clients{display:flex;flex-direction:column;gap:6px}' +
'.mk-client{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:.9em}' +
'.mk-charts{display:flex;flex-wrap:wrap;gap:20px}' +
'.mk-chart{flex:1 1 320px;min-width:280px}' +
'.mk-chart-h{font-size:.85em;font-weight:600;opacity:.8;margin-bottom:2px}' +
'.mk-legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:6px;font-size:.82em;opacity:.85}' +
'.mk-legend span{display:inline-flex;align-items:center;gap:5px}' +
'.mk-swatch{width:11px;height:11px;border-radius:2px;display:inline-block}' +
'.mk-actions{display:flex;flex-wrap:wrap;gap:8px;margin:.8em 0 1.2em 0}' +
'.mk-mode{font-size:.9em;margin-bottom:.8em;opacity:.85}';

// previous byte counters per WAN, for live throughput between polls
var prev = {};

function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
function fmt1(v) { var n = num(v); return n === null ? '-' : n.toFixed(1); }

function ago(epoch, now) {
	var e = num(epoch);
	if (!e) return _('never');
	var d = Math.max(0, now - e);
	if (d < 60) return _('just now');
	if (d < 3600) return Math.round(d / 60) + _(' min ago');
	if (d < 86400) return (d / 3600).toFixed(1) + _(' h ago');
	return Math.round(d / 86400) + _(' d ago');
}

function dur(sec) {
	var s = num(sec) || 0;
	var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
	if (d) return d + 'd ' + h + 'h';
	if (h) return h + 'h ' + m + 'm';
	return m + 'm';
}

function mbps(bytes, secs) { return secs > 0 ? bytes * 8 / secs / 1e6 : 0; }

// Grade a WAN from several signals so kmwan's transient DEAD (it re-probes
// for ~7s after every restart) shows as "checking", not an outage.
function grade(w) {
	if (!w.link)          return { cls: 'down', label: _('down'),        note: _('interface is down') };
	if (!w.up)            return { cls: 'down', label: _('no route'),    note: _('no default route on this link') };
	if (w.disabled === '1') return { cls: 'idle', label: _('not tracked'), note: _('disabled in kmwan - enable it on Mode & Priority') };
	if (w.metered === '1' && w.mode === 'balancing' && num(w.weight) === 0)
		return { cls: 'idle', label: _('backup - unused'), note: _('ratio 0 is never used in balance mode; switch to failover for a last resort') };
	var loss = num(w.loss), rtt = num(w.rtt);
	if (loss !== null && loss >= 50)
		return { cls: 'down', label: _('failing'), note: loss + _('% packet loss') };
	if (w.kmwan !== 'online' || w.state === 'DEAD')
		return { cls: 'warn', label: _('checking'), note: _('kmwan is re-probing this link') };
	if ((loss !== null && loss > 0) || (rtt !== null && rtt > 250))
		return { cls: 'warn', label: _('degraded'), note: (loss || 0) + _('% loss, ') + fmt1(rtt) + ' ms' };
	return { cls: 'ok', label: _('healthy'), note: '' };
}

return view.extend({
	load: function() { return callStatus(); },

	renderWans: function(d) {
		var now = num(d.now) || Math.floor(Date.now() / 1000);
		var tnow = Date.now() / 1000;
		var speeds = {}, maxd = 0;
		(d.speed || []).forEach(function(s) {
			speeds[s.name] = s;
			if (s.status === 'ok') maxd = Math.max(maxd, num(s.down) || 0);
		});

		return E('div', { 'class': 'mk-grid' }, (d.wans || []).map(function(w) {
			w.mode = d.mode;
			var g  = grade(w);
			var sp = speeds[w.name], spNote = null;
			if (sp && sp.status !== 'ok') {
				spNote = (sp.status === 'metered') ? _('metered - not speed tested') : _('last speed test failed');
				sp = null;
			}
			if (!spNote) spNote = (w.metered === '1') ? _('metered - not speed tested') : _('no speed test yet');
			var pct = (sp && maxd > 0) ? (num(sp.down) || 0) / maxd * 100 : 0;

			var rx = num(w.rx_bytes) || 0, tx = num(w.tx_bytes) || 0, live = null, p = prev[w.name];
			if (p && tnow > p.t + 0.5)
				live = { down: mbps(rx - p.rx, tnow - p.t), up: mbps(tx - p.tx, tnow - p.t) };
			prev[w.name] = { rx: rx, tx: tx, t: tnow };

			var where = [];
			if (w.isp)  where.push(w.isp);
			if (w.city) where.push(w.city + (w.country ? ', ' + w.country : ''));

			var meta = [
				E('div', {}, (w.device || '?') + '  ·  ' +
					(w.gateway ? 'gw ' + w.gateway : _('no gateway')) +
					(w.link ? '  ·  ' + _('up ') + dur(w.uptime) : '')),
				E('div', { 'class': 'mk-geo' }, w.pubip
					? [ E('b', {}, w.pubip), '   ' + where.join('  ·  ') ]
					: E('span', { 'class': 'mk-dim' }, _('location not looked up yet')))
			];
			if (g.note) meta.push(E('div', { 'class': 'mk-note' }, g.note));

			return E('div', { 'class': 'mk-card',
				'style': 'border-left-color:' + (w.color || '#888') }, [
				E('h4', {}, [
					E('span', {}, [
						E('span', { 'class': 'mk-dot', 'style': 'background:' + (w.color || '#888') }),
						w.name, w.metered === '1'
							? E('span', { 'class': 'mk-tag' }, _('metered')) : '' ]),
					E('span', { 'class': 'mk-pill mk-' + g.cls }, g.label)
				]),
				E('div', { 'class': 'mk-meta' }, meta),
				E('div', { 'class': 'mk-stats' }, [
					E('div', { 'class': 'mk-stat' }, [ E('span', {}, _('latency')),
						E('b', {}, num(w.rtt) !== null ? fmt1(w.rtt) + ' ms' : '-') ]),
					E('div', { 'class': 'mk-stat' }, [ E('span', {}, _('loss')),
						E('b', {}, num(w.loss) !== null ? w.loss + '%' : '-') ]),
					E('div', { 'class': 'mk-stat' }, [ E('span', {}, _('live now')),
						E('b', {}, live
							? '↓' + fmt1(live.down) + '  ↑' + fmt1(live.up) + ' Mbps'
							: '…') ])
				]),
				E('div', { 'class': 'mk-speed' }, sp
					? [ E('span', {}, [ E('b', {}, fmt1(sp.down)), _(' down') ]),
					    E('span', {}, [ E('b', {}, fmt1(sp.up)), _(' up Mbps') ]),
					    E('span', { 'class': 'mk-dim' }, _('tested ') + ago(sp.epoch, now)) ]
					: [ E('span', { 'class': 'mk-dim' }, spNote) ]),
				E('div', { 'class': 'mk-bar' }, [
					E('span', { 'style': 'width:' + pct.toFixed(0) + '%' })
				]),
				E('div', { 'class': 'mk-foot' },
					_('priority ') + (w.metric || '?') + '  ·  ' + _('ratio ') + (w.weight || '1') +
					(w.probe_tx ? '  ·  ' + _('kmwan probes ') + w.probe_rx + '/' + w.probe_tx : '') +
					(w.health_epoch ? '  ·  ' + _('checked ') + ago(w.health_epoch, now) : ''))
			]);
		}));
	},

	renderRules: function(d) {
		var clients = d.clients || [];
		var wanColor = {};
		(d.wans || []).forEach(function(w) { wanColor[w.name] = w.color; });

		if (!clients.length)
			return E('div', { 'class': 'mk-dim' },
				_('No client rules configured. Add devices on the Client Preference page.'));

		var prefOff = (d.enabled !== '1');
		var roleLabel = { fastest: _('Fastest link'), slowest: _('Slowest link'), backup: _('Backup link') };
		var rows = clients.map(function(c) {
			var role = c.mode && c.mode !== 'order' ? c.mode : null;
			var order = (c.order || '').trim().split(/\s+/).filter(Boolean);
			var live = c.live && !prefOff;
			var badge = c.enabled !== '1'
				? { t: _('off'), cls: 'mk-idle' }
				: (prefOff ? { t: _('preference off'), cls: 'mk-warn' }
				           : (c.live ? { t: _('active'), cls: 'mk-ok' }
				                     : { t: _('pending'), cls: 'mk-warn' }));
			return E('div', { 'class': 'mk-client' }, [
				E('span', { 'class': 'mk-pill mk-' + badge.cls }, badge.t),
				E('b', {}, (c.label && c.label !== '') ? c.label : c.src),
				E('span', { 'class': 'mk-dim' }, ' ' + c.src + '  →  '),
				role
					? E('b', {}, roleLabel[role] || role)
					: E('span', {}, order.map(function(w, i) {
						return E('span', {}, [
							E('span', { 'class': 'mk-dot',
								'style': 'background:' + (wanColor[w] || '#888') }),
							w + (i < order.length - 1 ? '  ›  ' : '') ]);
					}))
			]);
		});
		var kids = [];
		if (prefOff)
			kids.push(E('div', { 'class': 'mk-note' },
				_('Client preference is OFF — these rules are not applied. Turn it on on the Client Preference page.')));
		kids.push(E('div', { 'class': 'mk-clients' }, rows));
		return E('div', {}, kids);
	},

	// One grouped-bar chart for a metric (down or up) across recent runs.
	// SVG namespace matters - createElement('svg') renders nothing.
	_barChart: function(runs, metric, unitLabel, color, wans, now) {
		var SVGNS = 'http://www.w3.org/2000/svg';
		var maxv = 1;
		runs.forEach(function(r) {
			(r.wans || []).forEach(function(x) { maxv = Math.max(maxv, num(x[metric]) || 0); });
		});
		var W = 640, H = 170, padL = 40, padB = 30, padT = 8, padR = 10;
		var plotW = W - padL - padR, plotH = H - padT - padB;
		var groupW = plotW / runs.length, barW = Math.max(3, (groupW - 6) / wans.length);
		function el(name, attrs, kids) {
			var n = document.createElementNS(SVGNS, name);
			for (var k in attrs) n.setAttribute(k, attrs[k]);
			(kids || []).forEach(function(c) { n.appendChild(c); });
			return n;
		}
		var kids = [];
		[0, 0.5, 1].forEach(function(f) {
			var y = padT + plotH - f * plotH;
			kids.push(el('line', { x1: padL, y1: y, x2: W - padR, y2: y,
				stroke: 'rgba(128,128,128,.25)', 'stroke-width': 1 }));
			kids.push(el('text', { x: padL - 5, y: y + 3, 'text-anchor': 'end',
				'font-size': 9, fill: 'currentColor', 'fill-opacity': .6 },
				[ document.createTextNode(Math.round(f * maxv)) ]));
		});
		runs.forEach(function(r, gi) {
			var gx = padL + gi * groupW + 3;
			wans.forEach(function(wn, bi) {
				var rec = (r.wans || []).filter(function(x) { return x.name === wn; })[0];
				var v = rec ? (num(rec[metric]) || 0) : 0;
				var h = v / maxv * plotH;
				kids.push(el('rect', { x: gx + bi * barW, y: padT + plotH - h,
					width: Math.max(2, barW - 1), height: h, fill: color[wn], rx: 1 }, []));
			});
			var lbl = ago(r.epoch, now).replace(_(' min ago'), 'm')
				.replace(_(' h ago'), 'h').replace(_(' d ago'), 'd').replace(_('just now'), 'now');
			kids.push(el('text', { x: gx + (wans.length * barW) / 2, y: H - padB + 13,
				'text-anchor': 'middle', 'font-size': 9, fill: 'currentColor',
				'fill-opacity': .6 }, [ document.createTextNode(lbl) ]));
		});
		kids.push(el('text', { 'font-size': 9, fill: 'currentColor', 'fill-opacity': .6,
			transform: 'rotate(-90 10,' + (padT + plotH / 2) + ')',
			x: 10, y: padT + plotH / 2 }, [ document.createTextNode(unitLabel) ]));
		return el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H,
			preserveAspectRatio: 'xMidYMid meet' }, kids);
	},

	// Download + upload charts of the last few speed runs, side by side.
	renderGraph: function(d) {
		var runs = (d.speedhist || []);
		if (!runs.length)
			return E('div', { 'class': 'mk-dim' },
				_('No speed tests recorded yet. Run one above; the last 10 appear here.'));
		var now = num(d.now) || Math.floor(Date.now() / 1000);
		var palette = ['#2a6fb5', '#1f8b4c', '#d9a400', '#b3312c', '#7a4fb5', '#0f8b8b'];
		// Colours come from the backend (stable per WAN across every page).
		var color = {};
		(d.wans || []).forEach(function(w) { if (w.color) color[w.name] = w.color; });
		var wans = [], seen = {};
		runs.forEach(function(r) {
			(r.wans || []).forEach(function(x) {
				if (!seen[x.name]) { seen[x.name] = true; wans.push(x.name); }
			});
		});
		wans.forEach(function(n, i) { if (!color[n]) color[n] = palette[i % palette.length]; });

		var legend = E('div', { 'class': 'mk-legend' }, wans.map(function(n) {
			return E('span', {}, [
				E('span', { 'class': 'mk-swatch', 'style': 'background:' + color[n] }), n ]);
		}));

		return E('div', {}, [
			E('div', { 'class': 'mk-charts' }, [
				E('div', { 'class': 'mk-chart' }, [
					E('div', { 'class': 'mk-chart-h' }, _('Download')),
					this._barChart(runs, 'down', _('Mbps'), color, wans, now) ]),
				E('div', { 'class': 'mk-chart' }, [
					E('div', { 'class': 'mk-chart-h' }, _('Upload')),
					this._barChart(runs, 'up', _('Mbps'), color, wans, now) ])
			]),
			legend
		]);
	},

	modeText: function(d) {
		var now = num(d.now) || Math.floor(Date.now() / 1000);
		var a = d.autorank || {}, ar = num(a.interval) || 0, t;
		// The user-facing mode: Fastest = failover + auto-rank on.
		var mode = (d.mode !== 'failover') ? _('Load balance')
			: (ar > 0 ? _('Fastest (auto)') : _('Failover'));
		t = _('Mode: ') + mode;
		if (ar > 0)
			t += '   ·   ' + _('auto-rank every ') + ar + _(' min')
				+ (a.epoch ? ' (' + _('last: ') + (a.decision || '?') + ', ' + ago(a.epoch, now) + ')' : '');
		if (d.enabled !== '1') t += '   ·   ' + _('client preference off');
		return t;
	},

	render: function(d) {
		var self = this;

		var body = E('div', {}, [
			E('style', {}, CSS),
			E('h2', {}, _('MultiKmwan')),
			E('div', { 'class': 'mk-mode', 'id': 'mk-mode' }, this.modeText(d)),
			E('div', { 'id': 'mk-cards' }, this.renderWans(d)),

			E('div', { 'class': 'mk-actions' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, function() {
						ui.addNotification(null, E('p', _('Speed test running - up to a minute ' +
							'per WAN. Results appear on the cards as they finish.')), 'info');
						return callSpeed();
					})
				}, _('Run speed test')),
				E('button', {
					'class': 'cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, function() {
						return callRank('sum', 'both').then(function(r) {
							ui.addNotification(null, E('pre', (r && r.result) || _('ranked')), 'info');
						});
					})
				}, _('Rank WANs by measured speed')),
				E('button', {
					'class': 'cbi-button cbi-button-neutral',
					'click': ui.createHandlerFn(this, function() {
						return callHealth().then(function() {
							ui.addNotification(null, E('p', _('Health probe started.')), 'info');
						});
					})
				}, _('Check health now')),
				E('button', {
					'class': 'cbi-button cbi-button-neutral',
					'click': ui.createHandlerFn(this, function() {
						return callGeo().then(function() {
							ui.addNotification(null, E('p', _('Looking up public IP / ISP / ' +
								'location for each WAN...')), 'info');
						});
					})
				}, _('Refresh location')),
				E('button', {
					'class': 'cbi-button cbi-button-neutral',
					'click': ui.createHandlerFn(this, function() {
						return callSync().then(function() {
							ui.addNotification(null, E('p', _('Client rules re-applied.')), 'info');
						});
					})
				}, _('Sync client rules'))
			]),

			E('h3', {}, _('Recent speed tests')),
			E('div', { 'id': 'mk-graph' }, this.renderGraph(d)),

			E('h3', {}, _('Active client rules')),
			E('div', { 'id': 'mk-rules' }, this.renderRules(d))
		]);

		poll.add(function() {
			return callStatus().then(function(nd) {
				var c = document.getElementById('mk-cards');
				var r = document.getElementById('mk-rules');
				var m = document.getElementById('mk-mode');
				var g = document.getElementById('mk-graph');
				if (c) { c.innerHTML = ''; c.appendChild(self.renderWans(nd)); }
				if (r) { r.innerHTML = ''; r.appendChild(self.renderRules(nd)); }
				if (m) m.textContent = self.modeText(nd);
				if (g) { g.innerHTML = ''; g.appendChild(self.renderGraph(nd)); }
			});
		}, 5);

		return body;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
