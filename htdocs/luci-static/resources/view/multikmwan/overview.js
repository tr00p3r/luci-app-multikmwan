'use strict';
'require view';
'require rpc';
'require multikmwan';
'require ui';
'require poll';

var callStatus = rpc.declare({ object: 'luci.multikmwan', method: 'status' });
var callSync   = rpc.declare({ object: 'luci.multikmwan', method: 'sync' });
var callSpeed  = rpc.declare({ object: 'luci.multikmwan', method: 'speedtest' });
var callWeb    = rpc.declare({ object: 'luci.multikmwan', method: 'webtest' });
var callGeo    = rpc.declare({ object: 'luci.multikmwan', method: 'geo' });
var callHealth = rpc.declare({ object: 'luci.multikmwan', method: 'health' });
var callRank   = rpc.declare({ object: 'luci.multikmwan', method: 'rank',
                               params: [ 'by', 'what' ] });

// The page reads top-down: a verdict in words, one comparison table, then
// the per-link cards. Raw measurements live in tooltips and collapsed
// sections so the first screen stays readable.
var CSS = '' +
'.mk-grid{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:1.2em}' +
'.mk-card{flex:1 1 280px;border:1px solid rgba(128,128,128,.3);border-left-width:5px;' +
'border-radius:8px;padding:13px 16px;background:rgba(128,128,128,.05)}' +
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
'.mk-stat.mk-score b{font-size:1.25em}' +
'.mk-speed{font-size:.88em;display:flex;gap:12px;align-items:baseline;margin-top:4px;flex-wrap:wrap}' +
'.mk-speed b{font-weight:600}' +
'.mk-dim{opacity:.55;font-size:.9em}' +
'.mk-bar{height:6px;border-radius:4px;background:rgba(128,128,128,.25);' +
'margin-top:7px;overflow:hidden}.mk-bar span{display:block;height:100%;background:#2a6fb5}' +
'.mk-foot{font-size:.78em;opacity:.6;margin-top:7px}' +
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
'.mk-mode{font-size:.9em;margin-bottom:.8em;opacity:.85}' +
'.mk-rank td,.mk-rank th,.mk-sites td,.mk-sites th{white-space:nowrap}' +
'.mk-lead{color:#1f8b4c;font-weight:600}' +
'.mk-verdict{font-size:1.05em;margin:.2em 0 .8em 0}' +
'.mk-list{list-style:none;padding:0;margin:.4em 0 .8em 0;font-size:.95em;line-height:1.8}' +
'.mk-list b{font-weight:600}' +
'details.mk-more{margin:.6em 0 1.2em 0}details.mk-more summary{cursor:pointer;opacity:.7;font-size:.9em}';

// previous byte counters per WAN, for live throughput between polls
var prev = {};

function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
function fmt1(v) { var n = num(v); return n === null ? '-' : n.toFixed(1); }
function fmtMs(v) { var n = num(v); return n === null ? '-' : String(Math.round(n)); }
// Speeds: whole numbers at 10 Mbps and up, one decimal below 10.
function fmtSpeed(v) {
	var n = num(v);
	if (n === null) return '-';
	return n >= 10 ? String(Math.round(n)) : n.toFixed(1);
}

// The composite is on unless the user picked "Throughput only".
function compositeOn(d) { return !d.rank || d.rank.mode !== 'speed'; }

// Tooltip spelling out how a link's score was built.
function scoreTitle(sc, rank) {
	var r = rank || {};
	function part(label, pts, w) { return label + ' ' + (num(pts) === null ? '-' : num(pts).toFixed(2)) + ' × ' + (w || '?') + '%'; }
	return part(_('throughput'), sc.speed_pts, r.w_speed) + ' + ' +
		part(_('websites'), sc.web_pts, r.w_web) + ' + ' + part(_('latency'), sc.lat_pts, r.w_latency) +
		' + ' + part(_('DNS'), sc.dns_pts, r.w_dns) +
		(num(sc.sites) ? '  (' + sc.sites + _(' sites compared') + ')' : '') +
		(num(sc.latency) !== null ? '  ' + _('ping ') + fmtMs(sc.latency) + ' ms' : '');
}

// How a value compares with the column's best, in words: "12% slower".
// Differences under 2% read as "about the same" so noise is not a verdict.
function slower(v, best, lower) {
	if (v === null || best === null || best <= 0) return '-';
	var pct = lower ? (v - best) / best * 100 : (best - v) / best * 100;
	if (pct < 2) return _('about the same');
	return Math.round(pct) + _('% slower');
}

// Friendly site names for the lines under the table.
function siteName(host) {
	var h = String(host || '').replace(/^www\./, '');
	var known = { 'facebook.com': 'Facebook', 'youtube.com': 'YouTube', 'drive.google.com': 'Google Drive',
		'reddit.com': 'Reddit', 'google.com': 'Google', 'netflix.com': 'Netflix', 'twitter.com': 'Twitter', 'x.com': 'X' };
	return known[h] || h;
}
// "Facebook (real content)" -> "Facebook".
function shortLabel(label, fallback) { return String(label || fallback || '').replace(/\s*\(.*$/, ''); }

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
function grade(w, now, interval) {
	if (w.disabled === '1') return { cls: 'idle', label: _('not tracked'), note: _('disabled in kmwan') };
	if (!w.link)          return { cls: 'down', label: _('down'),        note: _('interface is down') };
	if (!w.up)            return { cls: 'down', label: _('no route'),    note: _('no default route on this link') };
	var age = now - (num(w.health_epoch) || 0);
	if (!num(w.health_epoch) || age < 0 || age > 3 * interval || num(w.loss) === null)
		return { cls: 'idle', label: _('unknown'), note: _('Health measurements are missing or stale') };
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

// Real-content rows (Facebook and any other "page" profile) grouped as
// profiles[] in first-seen order and by[wan][profile].
function contentIndex(d) {
	var profiles = [], seen = {}, by = {};
	(d.content || []).forEach(function(r) {
		if (!seen[r.profile]) { seen[r.profile] = true; profiles.push({ id: r.profile, label: shortLabel(r.label, r.profile) }); }
		(by[r.name] = by[r.name] || {})[r.profile] = r;
	});
	return { profiles: profiles, by: by };
}

return view.extend({
	load: function() { return callStatus(); },

	renderWans: function(d) {
		var now = num(d.now) || Math.floor(Date.now() / 1000);
		var tnow = Date.now() / 1000;
		var speeds = {}, maxd = 0, webs = {}, scores = {}, composite = compositeOn(d), content = contentIndex(d);
		(d.speed || []).forEach(function(s) {
			speeds[s.name] = s;
			if (s.status === 'ok') maxd = Math.max(maxd, num(s.down) || 0);
		});
		(d.web || []).forEach(function(x) { webs[x.name] = x; });
		(d.scores || []).forEach(function(x) { scores[x.name] = x; });

		// Links disabled in kmwan are not tracked, tested or routed to: no card.
		var hidden = (d.wans || []).filter(function(w) { return w.disabled === '1'; }).map(function(w) { return w.name; });
		var grid = E('div', { 'class': 'mk-grid' }, (d.wans || []).filter(function(w) { return w.disabled !== '1'; }).map(function(w) {
			w.mode = d.mode;
			var g  = grade(w, now, num(d.health_interval) || 20);
			var sp = speeds[w.name], spNote = null;
			if (sp && sp.status !== 'ok') {
				spNote = (sp.status === 'metered') ? _('metered: not speed-tested') : _('last speed test failed');
				sp = null;
			}
			if (!spNote) spNote = (w.metered === '1') ? _('metered: not speed-tested') : _('no speed test yet');
			var pct = (sp && maxd > 0) ? (num(sp.down) || 0) / maxd * 100 : 0;

			var wb = webs[w.name], wbNote = null;
			if (wb && wb.status !== 'ok') {
				wbNote = (wb.status === 'metered') ? _('metered: websites not tested')
					: (wb.status === 'busy') ? _('website test skipped, link was busy')
					: (wb.status === 'nodev') ? _('no device: websites not tested')
					: _('last website test failed');
				wb = null;
			}
			if (!wbNote) wbNote = (w.metered === '1') ? _('metered: websites not tested') : _('no website test yet');
			var sc = scores[w.name];

			var rx = num(w.rx_bytes) || 0, tx = num(w.tx_bytes) || 0, live = null, p = prev[w.name];
			if (p && tnow > p.t + 0.5)
				live = { down: mbps(rx - p.rx, tnow - p.t), up: mbps(tx - p.tx, tnow - p.t) };
			prev[w.name] = { rx: rx, tx: tx, t: tnow };

			var where = [];
			if (w.isp)  where.push(w.isp);
			if (w.city) where.push(w.city + (w.country ? ', ' + w.country : ''));

			var meta = [
				E('div', { 'class': 'mk-geo' }, w.pubip
					? [ E('b', {}, w.pubip), '   ' + where.join('  ·  ') ]
					: E('span', { 'class': 'mk-dim' }, _('location not looked up yet'))),
				E('div', { 'class': 'mk-dim' }, (w.device || '?') + '  ·  ' +
					(w.gateway ? 'gw ' + w.gateway : _('no gateway')) +
					(w.link ? '  ·  ' + _('up ') + dur(w.uptime) : ''))
			];
			if (g.note) meta.push(E('div', { 'class': 'mk-note' }, g.note));

			// Websites line: mean first byte, DNS, then each real-content figure.
			var sites = wb ? [
				E('span', {}, [ _('Websites '), E('b', {}, fmtMs(wb.ttfb)), ' ms' ]),
				E('span', {}, [ _('DNS '), E('b', {}, fmtMs(wb.dns)), ' ms' ]) ] : [ E('span', { 'class': 'mk-dim' }, wbNote) ];
			content.profiles.forEach(function(pf) {
				var r = content.by[w.name] && content.by[w.name][pf.id];
				if (!r) return;
				sites.push(r.status === 'ok'
					? E('span', { 'title': _('real-content download from ') + (r.host || '') }, [ pf.label + ' ', E('b', {}, fmtSpeed(r.down)), ' Mbps' ])
					: E('span', { 'class': 'mk-dim' }, pf.label + _(': failed')));
			});
			if (wb) sites.push(E('span', { 'class': 'mk-dim' }, ago(wb.epoch, now)));

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
					E('div', { 'class': 'mk-stat mk-score', 'title': (sc && composite) ? scoreTitle(sc, d.rank) : '' }, [
						E('span', {}, _('score')),
						E('b', {}, (sc && composite && num(sc.score) !== null) ? String(Math.round(num(sc.score))) : '-') ]),
					E('div', { 'class': 'mk-stat' }, [ E('span', {}, _('latency')),
						E('b', {}, num(w.rtt) !== null ? fmt1(w.rtt) + ' ms' : '-') ]),
					E('div', { 'class': 'mk-stat' }, [ E('span', {}, _('loss')),
						E('b', {}, num(w.loss) !== null ? w.loss + '%' : '-') ]),
					E('div', { 'class': 'mk-stat' }, [ E('span', {}, _('live now')),
						E('b', {}, live
							? '↓' + fmtSpeed(live.down) + '  ↑' + fmtSpeed(live.up) + ' Mbps'
							: '…') ])
				]),
				E('div', { 'class': 'mk-speed' }, sp
					? [ E('span', {}, [ '↓ ', E('b', {}, fmtSpeed(sp.down)), '  ↑ ', E('b', {}, fmtSpeed(sp.up)), ' Mbps' ]),
					    E('span', { 'class': 'mk-dim' }, ago(sp.epoch, now)) ]
					: [ E('span', { 'class': 'mk-dim' }, spNote) ]),
				E('div', { 'class': 'mk-bar' }, [
					E('span', { 'style': 'width:' + pct.toFixed(0) + '%' })
				]),
				E('div', { 'class': 'mk-speed' }, sites),
				E('div', { 'class': 'mk-foot' }, _('priority ') + (w.metric || '?') + '  ·  ' + _('ratio ') + (w.weight || '1'))
			]);
		}));
		if (!hidden.length) return grid;
		return E('div', {}, [ grid, E('p', { 'class': 'mk-dim' },
			_('Not shown (disabled in kmwan): ') + hidden.join(', ') + '.') ]);
	},

	renderRules: function(d) {
		var clients = d.clients || [];
		var wanColor = {};
		(d.wans || []).forEach(function(w) { wanColor[w.name] = w.color; });

		if (!clients.length)
			return E('div', { 'class': 'mk-dim' },
				_('No device rules. Add devices on the Devices page.'));

		var prefOff = (d.enabled !== '1');
		var roleLabel = { fastest: _('Fastest link'), slowest: _('Slowest link'), backup: _('Backup link') };
		var rows = clients.map(function(c) {
			var role = c.mode && c.mode !== 'order' ? c.mode : null;
			var order = (c.order || '').trim().split(/\s+/).filter(Boolean);
			// enabled defaults to on: only an explicit '0' means off (matches the
			// engine's config_get_bool default and the Devices page).
			var off = (c.enabled === '0');
			var badge = off
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
				_('Device preference is off, so these rules are not applied. Turn it on on the Devices page.')));
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
					width: Math.max(2, barW - 1), height: h, fill: color[wn], rx: 1 }, [
					el('title', {}, [document.createTextNode(wn + ': ' + fmtSpeed(v) + ' Mbps · ' +
						multikmwan.sourceText(rec && rec.source))]) ]));
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

	// Download + upload charts of the last few speed runs; the attributed log
	// (profile, actual hosts, per-direction status) sits collapsed beneath.
	renderGraph: function(d) {
		var runs = (d.speedhist || []);
		var off = {};
		(d.wans || []).forEach(function(w) { if (w.disabled === '1') off[w.name] = true; });
		d.testhistory = (d.testhistory || []).filter(function(t) { return !off[t.wan]; });
		runs.forEach(function(run) {
			(run.wans || []).forEach(function(test) {
				test.source = (d.testhistory || []).filter(function(t) { return t.wan === test.name && t.epoch === test.epoch; }).pop();
			});
		});
		var log = E('details', { 'class': 'mk-more' }, [
			E('summary', {}, _('Speed test log')),
			E('p', { 'class': 'mk-dim' }, _('Transfers made by MultiKmwan against the listed service or host, not official provider scores. Daily averages can mix sources.')),
			multikmwan.testTable(d.testhistory, 10) ]);
		if (!runs.length)
			return E('div', {}, [ E('p', { 'class': 'mk-dim' }, _('No successful speed tests yet.')), log ]);
		var now = num(d.now) || Math.floor(Date.now() / 1000);
		var palette = ['#2a6fb5', '#1f8b4c', '#d9a400', '#b3312c', '#7a4fb5', '#0f8b8b'];
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
			legend,
			log
		]);
	},

	// Raw per-site grid: one row per site, one column per link. Collapsed
	// under the ranking; the summary lines above it carry the message.
	renderSites: function(d) {
		var rows = d.websites || [];
		if (!rows.length) return E('p', { 'class': 'mk-dim' }, _('No website test yet.'));
		var wans = [], seen = {}, hosts = [], hseen = {}, cell = {};
		(d.wans || []).forEach(function(w) { if (w.disabled === '1') seen[w.name] = true; });
		(d.wans || []).forEach(function(w) { if (!seen[w.name]) { seen[w.name] = true; wans.push(w.name); } });
		rows.forEach(function(r) {
			if (!seen[r.name]) { seen[r.name] = true; wans.push(r.name); }
			if (!hseen[r.host]) { hseen[r.host] = true; hosts.push(r.host); }
			cell[r.name + '|' + r.host] = r;
		});
		var head = E('tr', {}, [ E('th', {}, _('Site')) ].concat(wans.map(function(n) { return E('th', {}, n); })));
		var body = hosts.map(function(h) {
			var best = null;
			wans.forEach(function(n) {
				var r = cell[n + '|' + h], v = r && r.status === 'ok' ? num(r.ttfb) : null;
				if (v !== null && (best === null || v < best)) best = v;
			});
			return E('tr', {}, [ E('td', { 'title': h }, siteName(h)) ].concat(wans.map(function(n) {
				var r = cell[n + '|' + h];
				if (!r) return E('td', { 'class': 'mk-dim' }, '-');
				if (r.status !== 'ok') return E('td', { 'class': 'mk-note' }, _('failed') + ' (' + r.status + ')');
				var lead = best !== null && num(r.ttfb) === best && wans.length > 1;
				return E('td', { 'class': lead ? 'mk-lead' : '' }, _('DNS ') + fmtMs(r.dns) + '  ·  ' + _('first byte ') + fmtMs(r.ttfb) +
					'  ·  ' + _('page ') + fmtMs(r.load) + ' ms' + (lead ? ' ✓' : ''));
			})));
		});
		return E('div', {}, [
			E('div', { 'style': 'overflow-x:auto' }, E('table', { 'class': 'table mk-sites' }, [
				E('thead', {}, head), E('tbody', {}, body) ])),
			E('p', { 'class': 'mk-dim' }, _('Per site and link, from the router: DNS is the resolver round trip, ' +
				'first byte is connect, TLS and the server\'s answer, page is the full HTML. A redirect counts. ' +
				'Only sites every link loaded count towards the score.'))
		]);
	},

	// "Which line loads the internet faster?" A verdict in words, one table
	// (the leader shows its figure, the others how far behind they are), and
	// one line per site. Raw numbers sit in tooltips and the collapsed grid.
	renderRanking: function(d) {
		var scores = (d.scores || []).slice().sort(function(a, b) { return (num(b.score) || 0) - (num(a.score) || 0); });
		var composite = compositeOn(d), content = contentIndex(d);
		if (!scores.length)
			return E('p', { 'class': 'mk-dim' }, _('No ranking yet. Run a speed test, then a website test.'));
		var speeds = {}, color = {};
		(d.speed || []).forEach(function(s) { speeds[s.name] = s; });
		(d.wans || []).forEach(function(w) { color[w.name] = w.color; });
		// Columns: get() -> number or null; fmt() -> the leader's cell text.
		var cols = [
			{ key: 'down', label: _('Download'), noun: _('downloads'), lower: false,
			  get: function(s) { var sp = speeds[s.name]; return sp && sp.status === 'ok' ? num(sp.down) : null; },
			  fmt: function(v) { return fmtSpeed(v) + ' Mbps'; } },
			{ key: 'up', label: _('Upload'), noun: _('uploads'), lower: false,
			  get: function(s) { var sp = speeds[s.name]; return sp && sp.status === 'ok' ? num(sp.up) : null; },
			  fmt: function(v) { return fmtSpeed(v) + ' Mbps'; } },
			{ key: 'web', label: _('Websites'), noun: _('website response'), lower: true,
			  get: function(s) { return num(s.web); }, fmt: function(v) { return fmtMs(v) + ' ms'; } },
			{ key: 'latency', label: _('Latency'), noun: _('latency'), lower: true,
			  get: function(s) { return num(s.latency); }, fmt: function(v) { return fmtMs(v) + ' ms'; } },
			{ key: 'dns', label: _('DNS'), noun: _('DNS'), lower: true,
			  get: function(s) { return num(s.dns); }, fmt: function(v) { return fmtMs(v) + ' ms'; } }
		];
		content.profiles.forEach(function(pf) {
			cols.push({ key: 'content:' + pf.id, label: pf.label, noun: pf.label + _(' downloads'), lower: false,
				get: function(s) { var r = content.by[s.name] && content.by[s.name][pf.id]; return r && r.status === 'ok' ? num(r.down) : null; },
				fmt: function(v) { return fmtSpeed(v) + ' Mbps'; } });
		});
		// A column leads only where at least two links were measured.
		var bests = {}, counts = {};
		cols.forEach(function(c) {
			var b = null, n = 0;
			scores.forEach(function(s) { var v = c.get(s); if (v === null) return; n++; if (b === null || (c.lower ? v < b : v > b)) b = v; });
			bests[c.key] = n > 1 ? b : null; counts[c.key] = n;
		});
		function leads(s, c) { var v = c.get(s); return v !== null && bests[c.key] !== null && v === bests[c.key]; }
		var many = scores.length > 1;
		var head = E('tr', {}, [ E('th', {}, _('Link')), E('th', {}, _('Score')) ].concat(cols.map(function(c) { return E('th', {}, c.label); })));
		var body = scores.map(function(s, i) {
			return E('tr', {}, [
				E('td', {}, [ E('span', { 'class': 'mk-dot', 'style': 'background:' + (color[s.name] || '#888') }),
					E('b', {}, s.name), i === 0 && many ? E('span', { 'class': 'mk-tag' }, _('fastest')) : '' ]),
				E('td', { 'title': composite ? scoreTitle(s, d.rank) : '' },
					composite && num(s.score) !== null ? E('b', {}, String(Math.round(num(s.score)))) : '-')
			].concat(cols.map(function(c) {
				var v = c.get(s);
				if (v === null) return E('td', { 'class': 'mk-dim' }, '-');
				if (bests[c.key] === null) return E('td', {}, c.fmt(v));
				if (leads(s, c)) return E('td', { 'class': 'mk-lead' }, c.fmt(v) + ' ✓');
				return E('td', { 'title': c.fmt(v) }, slower(v, bests[c.key], c.lower));
			})));
		});

		// Verdict: who wins overall, what it wins on, where a rival is ahead.
		var top = scores[0], wins = [], behind = [], verdict;
		cols.forEach(function(c) {
			if (bests[c.key] === null || c.get(top) === null || !many) return;
			if (leads(top, c)) wins.push(c.noun);
			else {
				var who = scores.filter(function(s) { return leads(s, c); }).map(function(s) { return s.name; }).join(', ');
				if (slower(c.get(top), bests[c.key], c.lower) !== _('about the same')) behind.push(who + _(' is ahead on ') + c.noun);
			}
		});
		function list(a) { return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + _(' and ') + a[a.length - 1]; }
		if (!many) {
			verdict = top.name + _(' is the only line with a measurement, so there is nothing to compare yet.');
		} else {
			verdict = E('span', {}, [ E('b', {}, top.name), _(' is the faster line right now') +
				(composite ? ' (' + _('score ') + Math.round(num(top.score)) + _(' vs ') +
					scores.slice(1).map(function(s) { return s.name + ' ' + Math.round(num(s.score)); }).join(', ') + ')' : '') + '. ' +
				(wins.length ? _('It wins on ') + list(wins) + '. ' : '') +
				(behind.length ? behind.join('; ') + '.' : '') ]);
		}

		// One line per site: who answered it soonest, and how the others compare.
		var siteLines = [], hosts = [], cell = {}, hseen = {};
		(d.websites || []).forEach(function(r) {
			if (!hseen[r.host]) { hseen[r.host] = true; hosts.push(r.host); }
			cell[r.name + '|' + r.host] = r;
		});
		var names = scores.map(function(s) { return s.name; });
		hosts.forEach(function(h) {
			var best = null, bestName = null;
			names.forEach(function(n) {
				var r = cell[n + '|' + h], v = r && r.status === 'ok' ? num(r.ttfb) : null;
				if (v !== null && (best === null || v < best)) { best = v; bestName = n; }
			});
			if (best === null) return;
			var rest = names.filter(function(n) { return n !== bestName; }).map(function(n) {
				var r = cell[n + '|' + h];
				return n + ' ' + (r && r.status === 'ok' ? slower(num(r.ttfb), best, true) : _('failed'));
			});
			siteLines.push(E('li', { 'title': _('first byte ') + fmtMs(best) + ' ms' }, [
				E('b', {}, siteName(h)), '  ·  ', E('span', { 'class': 'mk-lead' }, bestName + ' ✓'),
				rest.length ? '  ·  ' + rest.join('  ·  ') : '' ]));
		});

		var r = d.rank || {}, ar = num(d.autorank && d.autorank.interval) || 0, margin = num(d.autorank && d.autorank.margin);
		var foot = composite
			? _('Score: throughput ') + (r.w_speed || 40) + '%, ' + _('websites ') + (r.w_web || 25) + '%, ' +
			  _('latency ') + (r.w_latency || 20) + '%, ' + _('DNS ') + (r.w_dns || 15) + _('%, each against the best line.')
			: _('Ranking by throughput only.');
		if (ar > 0 && margin !== null) foot += _(' Auto-rank switches only when a rival beats the leader by ') + margin + '%.';

		return E('div', {}, [
			E('p', { 'class': 'mk-verdict' }, verdict),
			E('div', { 'style': 'overflow-x:auto' }, E('table', { 'class': 'table mk-rank' }, [ E('thead', {}, head), E('tbody', {}, body) ])),
			siteLines.length ? E('ul', { 'class': 'mk-list' }, siteLines) : '',
			E('details', { 'class': 'mk-more' }, [ E('summary', {}, _('Measurements')),
				E('p', { 'class': 'mk-dim' }, foot), this.renderSites(d) ])
		]);
	},

	modeText: function(d) {
		var now = num(d.now) || Math.floor(Date.now() / 1000);
		var a = d.autorank || {}, ar = num(a.interval) || 0, t;
		var mode = (d.mode !== 'failover') ? _('Load balance') : (ar > 0 ? _('Fastest') : _('Failover'));
		var decision = { unchanged: _('no change'), 'same-leader': _('no change'), 'within-margin': _('within margin, no change'),
			applied: _('leader changed'), 'no-results': _('no result') }[a.decision] || a.decision;
		t = mode + _(' mode');
		if (ar > 0) t += '  ·  ' + _('re-checked every ') + ar + _(' min') + (a.epoch ? '  ·  ' + _('last check ') + ago(a.epoch, now) + ': ' + decision : '');
		if (d.enabled !== '1') t += '  ·  ' + _('device preference off');
		return t;
	},

	// What the tests run against, in one dim line.
	sourceText: function(d) {
		var ts = d.test_source || {}, sites = [], seen = {};
		(d.websites || []).forEach(function(r) { if (!seen[r.host]) { seen[r.host] = true; sites.push(siteName(r.host)); } });
		return _('Speed tests: ') + (ts.label || _('not set')) + (sites.length ? '  ·  ' + _('Websites: ') + sites.join(', ') : '');
	},

	render: function(d) {
		var self = this;

		var body = E('div', {}, [
			E('style', {}, CSS),
			E('h2', {}, _('MultiKmwan')),
			E('div', { 'class': 'mk-mode', 'id': 'mk-mode' }, this.modeText(d)),
			E('h3', {}, _('Which line loads the internet faster?')),
			E('div', { 'id': 'mk-ranking' }, this.renderRanking(d)),
			E('div', { 'id': 'mk-cards' }, this.renderWans(d)),

			E('div', { 'class': 'mk-actions' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, function() {
						ui.addNotification(null, E('p', _('Speed test running, up to a minute per link.')), 'info');
						return callSpeed();
					})
				}, _('Run speed test')),
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, function() {
						ui.addNotification(null, E('p', _('Website test running.')), 'info');
						return callWeb();
					})
				}, _('Test websites')),
				E('button', {
					'class': 'cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, function() {
						// Empty "by" = the configured measure, the same one auto-rank uses.
						return callRank('', 'both').then(function(r) {
							ui.addNotification(null, E('pre', (r && r.result) || _('ranked')), 'info');
						});
					})
				}, _('Rank now')),
				E('button', {
					'class': 'cbi-button cbi-button-neutral',
					'click': ui.createHandlerFn(this, function() {
						return callHealth().then(function() {
							ui.addNotification(null, E('p', _('Health probe started.')), 'info');
						});
					})
				}, _('Check health')),
				E('button', {
					'class': 'cbi-button cbi-button-neutral',
					'click': ui.createHandlerFn(this, function() {
						return callGeo().then(function() {
							ui.addNotification(null, E('p', _('Looking up each link\'s public address and location.')), 'info');
						});
					})
				}, _('Refresh location')),
				E('button', {
					'class': 'cbi-button cbi-button-neutral',
					'click': ui.createHandlerFn(this, function() {
						return callSync().then(function() {
							ui.addNotification(null, E('p', _('Device rules re-applied.')), 'info');
						});
					})
				}, _('Sync device rules'))
			]),
			E('p', { 'id': 'mk-test-source', 'class': 'mk-dim' }, this.sourceText(d)),

			E('h3', {}, _('Recent speed tests')),
			E('div', { 'id': 'mk-graph' }, this.renderGraph(d)),

			E('h3', {}, _('Device rules')),
			E('div', { 'id': 'mk-rules' }, this.renderRules(d))
		]);

		poll.add(function() {
			return callStatus().then(function(nd) {
				var c = document.getElementById('mk-cards');
				var r = document.getElementById('mk-rules');
				var m = document.getElementById('mk-mode');
				var g = document.getElementById('mk-graph');
				var k = document.getElementById('mk-ranking');
				var source = document.getElementById('mk-test-source');
				// Keep an opened "Measurements" / "Speed test log" open across refreshes.
				var open = {};
				document.querySelectorAll('details.mk-more').forEach(function(el) { open[el.querySelector('summary').textContent] = el.open; });
				if (source) source.textContent = self.sourceText(nd);
				if (k) { k.innerHTML = ''; k.appendChild(self.renderRanking(nd)); }
				if (c) { c.innerHTML = ''; c.appendChild(self.renderWans(nd)); }
				if (r) { r.innerHTML = ''; r.appendChild(self.renderRules(nd)); }
				if (m) m.textContent = self.modeText(nd);
				if (g) { g.innerHTML = ''; g.appendChild(self.renderGraph(nd)); }
				document.querySelectorAll('details.mk-more').forEach(function(el) { if (open[el.querySelector('summary').textContent]) el.open = true; });
			});
		}, 5);

		return body;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
