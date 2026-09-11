'use strict';
'require view';
'require rpc';

var callHistory = rpc.declare({ object: 'luci.multikmwan', method: 'history' });

var CSS = '' +
'.mh-grid{display:flex;flex-wrap:wrap;gap:12px;margin:1em 0 1.5em 0}' +
'.mh-card{flex:1 1 240px;border:1px solid rgba(128,128,128,.3);border-radius:8px;border-left-width:5px;' +
'padding:13px 16px;background:rgba(128,128,128,.05)}' +
'.mh-card h4{margin:0 0 10px 0;font-size:1.05em}' +
'.mh-row{display:flex;justify-content:space-between;font-size:.9em;padding:3px 0;' +
'border-bottom:1px solid rgba(128,128,128,.15)}' +
'.mh-row span:first-child{opacity:.65}' +
'.mh-row b{font-weight:600}' +
'.mh-up-good{color:#1f8b4c}.mh-up-warn{color:#d9a400}.mh-up-bad{color:#b3312c}' +
'.mh-legend{font-size:.82em;opacity:.85;display:flex;flex-wrap:wrap;gap:14px;margin:4px 0 10px}' +
'.mh-legend span{display:inline-flex;align-items:center;gap:5px}' +
'.mh-swatch{width:11px;height:11px;border-radius:2px;display:inline-block}' +
'.mh-table{border-collapse:collapse;width:100%;font-size:.85em;margin-top:.5em}' +
'.mh-table th,.mh-table td{text-align:left;padding:5px 10px;border-bottom:1px solid rgba(128,128,128,.15)}' +
'.mh-table th{opacity:.6;font-weight:600}' +
'.mh-empty{opacity:.6;padding:1em 0}';

var PALETTE = ['#2a6fb5', '#1f8b4c', '#d9a400', '#b3312c', '#7a4fb5', '#0f8b8b'];

function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

// Group flat day rows into { wan: [rows...] } and a sorted date list.
function group(days) {
	var byWan = {}, dates = {};
	days.forEach(function(r) {
		(byWan[r.wan] = byWan[r.wan] || []).push(r);
		dates[r.date] = true;
	});
	return { byWan: byWan, dates: Object.keys(dates).sort() };
}

function uptimePct(rows) {
	var up = 0, down = 0;
	rows.forEach(function(r) { up += num(r.up); down += num(r.down); });
	var tot = up + down;
	return tot > 0 ? (up / tot * 100) : null;
}

function upClass(p) {
	if (p === null) return '';
	if (p >= 99.5) return 'mh-up-good';
	if (p >= 97) return 'mh-up-warn';
	return 'mh-up-bad';
}

// A compact SVG line of daily average download over the retained window.
function trend(rows, dates, colorHex) {
	var SVGNS = 'http://www.w3.org/2000/svg';
	var byDate = {};
	rows.forEach(function(r) { byDate[r.date] = num(r.dl_avg); });
	var vals = dates.map(function(d) { return byDate[d] || 0; });
	var maxv = Math.max.apply(null, vals.concat([1]));
	var W = 260, H = 46, n = vals.length;
	function el(name, attrs) {
		var e = document.createElementNS(SVGNS, name);
		for (var k in attrs) e.setAttribute(k, attrs[k]);
		return e;
	}
	if (n < 2) return document.createTextNode('');
	var pts = vals.map(function(v, i) {
		var x = i / (n - 1) * (W - 2) + 1;
		var y = H - 2 - (v / maxv) * (H - 4);
		return x.toFixed(1) + ',' + y.toFixed(1);
	}).join(' ');
	var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H });
	svg.appendChild(el('polyline', { points: pts, fill: 'none',
		stroke: colorHex, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
	return svg;
}

return view.extend({
	load: function() { return callHistory().catch(function() { return { days: [] }; }); },

	render: function(data) {
		var days = (data && data.days) || [];
		var g = group(days);
		var wans = Object.keys(g.byWan);
		// Colours come from the backend so every page matches.
		var color = {};
		days.forEach(function(r) { if (r.color) color[r.wan] = r.color; });
		wans.forEach(function(n, i) { if (!color[n]) color[n] = PALETTE[i % PALETTE.length]; });

		var body = E('div', {}, [
			E('style', {}, CSS),
			E('h2', {}, _('90-Day History')),
			E('p', {}, _('Rolled up one row per WAN per day and kept for 90 days. ' +
				'Uptime is the share of health checks that answered; speeds are from ' +
				'the periodic tests.'))
		]);

		if (!wans.length) {
			body.appendChild(E('div', { 'class': 'mh-empty' },
				_('No history yet. It fills in as the background service records ' +
				  'health checks and speed tests — give it a day or so.')));
			return body;
		}

		// per-WAN summary cards
		body.appendChild(E('div', { 'class': 'mh-grid' }, wans.map(function(wn) {
			var rows = g.byWan[wn];
			var up = uptimePct(rows);
			var outages = 0, dlmax = 0, dlsum = 0, dln = 0, rttsum = 0, rttn = 0;
			rows.forEach(function(r) {
				outages += num(r.outages);
				dlmax = Math.max(dlmax, num(r.dl_max));
				if (num(r.dl_avg) > 0) { dlsum += num(r.dl_avg); dln++; }
				if (num(r.rtt_avg) > 0) { rttsum += num(r.rtt_avg); rttn++; }
			});
			function row(k, v, cls) {
				return E('div', { 'class': 'mh-row' }, [
					E('span', {}, k), E('b', { 'class': cls || '' }, v) ]);
			}
			return E('div', { 'class': 'mh-card', 'style': 'border-left:5px solid ' + color[wn] }, [
				E('h4', {}, [
					E('span', { 'class': 'mh-swatch',
						'style': 'background:' + color[wn] + ';margin-right:7px' }),
					wn ]),
				row(_('Days recorded'), String(rows.length)),
				row(_('Uptime'), up === null ? '-' : up.toFixed(2) + '%', upClass(up)),
				row(_('Outages'), String(outages)),
				row(_('Avg download'), dln ? (dlsum / dln).toFixed(1) + ' Mbps' : '-'),
				row(_('Peak download'), dlmax ? dlmax.toFixed(1) + ' Mbps' : '-'),
				row(_('Avg latency'), rttn ? (rttsum / rttn).toFixed(0) + ' ms' : '-'),
				E('div', { 'style': 'margin-top:8px' }, [ trend(rows, g.dates, color[wn]) ])
			]);
		})));

		// recent-days table (last 14, newest first)
		var recent = g.dates.slice(-14).reverse();
		var head = E('tr', {}, [ E('th', {}, _('Date')) ].concat(wans.map(function(wn) {
			return E('th', {}, [
				E('span', { 'class': 'mh-swatch', 'style': 'background:' + color[wn] +
					';border-radius:50%;margin-right:5px' }), wn ]);
		})));
		var rowsEl = recent.map(function(dt) {
			var cells = [ E('td', {}, dt) ];
			wans.forEach(function(wn) {
				var r = g.byWan[wn].filter(function(x) { return x.date === dt; })[0];
				if (!r) { cells.push(E('td', {}, '-')); return; }
				var up = uptimePct([r]);
				cells.push(E('td', {}, [
					E('span', { 'class': upClass(up) },
						up === null ? '-' : up.toFixed(1) + '%'),
					E('span', { 'class': 'mk-dim' },
						num(r.dl_avg) ? '  ·  ' + num(r.dl_avg).toFixed(0) + ' Mbps' : ''),
					num(r.outages) > 0 ? E('span', { 'class': 'mh-up-bad' },
						'  ·  ' + r.outages + _(' drop(s)')) : ''
				]));
			});
			return E('tr', {}, cells);
		});

		body.appendChild(E('h3', {}, _('Recent days')));
		body.appendChild(E('table', { 'class': 'mh-table' },
			[ E('thead', {}, head), E('tbody', {}, rowsEl) ]));

		return body;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
