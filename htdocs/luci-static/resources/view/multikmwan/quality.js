'use strict';
'require view';
'require rpc';
'require poll';
'require ui';

var callQuality = rpc.declare({ object: 'luci.multikmwan', method: 'quality', params: ['hours'] });
var CSS = '.mq-card{border:1px solid rgba(128,128,128,.3);border-radius:8px;padding:16px;margin:16px 0}' +
	'.mq-heading,.mq-metrics{display:flex;gap:16px;flex-wrap:wrap;align-items:center;justify-content:space-between}' +
	'.mq-metrics{justify-content:flex-start;font-size:.9em;margin:12px 0}.mq-note{opacity:.75;font-size:.9em}' +
	'.mq-chart{width:100%;height:140px;display:block}.mq-table{width:100%;border-collapse:collapse;font-size:.9em}' +
	'.mq-table td,.mq-table th{padding:8px;text-align:left;border-bottom:1px solid rgba(128,128,128,.2)}' +
	'.mq-scroll{overflow-x:auto}.mq-badge{padding:3px 10px;border-radius:12px;font-size:.9em}' +
	'.mq-healthy{background:#1f8b4c;color:white}.mq-degraded{background:#916000;color:white}' +
	'.mq-down{background:#b3312c;color:white}.mq-unknown,.mq-disabled{background:#666;color:white}';
var LABELS = { healthy: _('Responsive'), degraded: _('Degraded'), down: _('Unresponsive'),
	unknown: _('Unknown'), disabled: _('Not tracked') };
var REASONS = { no_device: _('WAN device disappeared'), link_down: _('Interface is down'),
	probe_failed: _('Probe target did not respond'), loss_or_latency: _('Packet loss or elevated latency'),
	probe_ok: _('Probe target responded'), probe_error: _('Probe could not be measured'),
	not_tracked: _('Disabled in kmwan'), stale: _('No fresh measurements'),
	sampling_gap: _('Sampling gap or clock change'), target_changed: _('Probe target changed'),
	probe_recovered: _('Probe responded again'), quality_recovered: _('Quality returned to normal') };
var EVENTS = { outage: _('Outage observed'), recovery: _('Recovered'), degraded: _('Degradation observed'),
	gap: _('Monitoring gap'), disabled: _('Tracking disabled') };
function when(t) { return new Date(t * 1000).toLocaleString(); }
function duration(s) { return s < 0 ? _('Unknown') : (s < 60 ? Math.round(s) + ' s' : Math.round(s / 60) + ' min'); }
function metric(v, suffix) { return v == null ? _('Unavailable') : Number(v).toFixed(1) + suffix; }

function chart(w, data) {
	var ns = 'http://www.w3.org/2000/svg', width = 900, height = 140, left = 42;
	var start = data.now - data.hours * 3600, span = data.hours * 3600;
	function el(tag, attrs, text) {
		var node = document.createElementNS(ns, tag);
		Object.keys(attrs).forEach(function(k) { node.setAttribute(k, attrs[k]); });
		if (text != null) node.textContent = text;
		return node;
	}
	var svg = el('svg', { viewBox: '0 0 900 140', 'class': 'mq-chart', role: 'img',
		'aria-label': _('Latency and connection state for ') + w.name });
	svg.appendChild(el('title', {}, _('Latency in milliseconds; color indicates connection state. Empty periods have no observations.')));
	var max = Math.max.apply(null, [50].concat(w.points.map(function(p) { return p[4] || 0; })));
	[0, 0.5, 1].forEach(function(f) {
		var y = 100 - 80 * f;
		svg.appendChild(el('line', { x1: left, x2: width, y1: y, y2: y, stroke: '#888', opacity: 0.25 }));
		svg.appendChild(el('text', { x: left - 5, y: y + 3, 'text-anchor': 'end', fill: 'currentColor', 'font-size': 10 }, Math.round(max * f)));
	});
	w.points.forEach(function(p) {
		var begin = Math.max(start, p[0]), end = Math.min(data.now, p[0] + data.bucket_seconds);
		var x = left + (begin - start) / span * (width - left), bw = (end - begin) / span * (width - left);
		var coverage = Math.min(1, (p[1] + p[2] + p[3]) / (end - begin));
		var color = p[3] ? '#b3312c' : (p[2] ? '#bf8300' : '#1f8b4c');
		var bar = el('rect', { x: x, y: 104, width: Math.max(0, bw - .4), height: 8,
			fill: color, opacity: 0.25 + coverage * .75 });
		bar.appendChild(el('title', {}, when(p[0]) + '\n' + _('Observed: ') + Math.round(coverage * 100) + '%' +
			'\n' + _('Latency: ') + metric(p[4], ' ms') + '\n' + _('Loss: ') + metric(p[5], '%') +
			'\n' + _('Jitter: ') + metric(p[6], ' ms')));
		svg.appendChild(bar);
		if (p[4] != null) svg.appendChild(el('rect', { x: x, y: 100 - p[4] / max * 80,
			width: Math.max(.5, bw - .4), height: Math.max(1, p[4] / max * 80), fill: color, opacity: .8 }));
	});
	svg.appendChild(el('text', { x: left, y: 132, fill: 'currentColor', 'font-size': 11 }, new Date(start * 1000).toLocaleTimeString()));
	svg.appendChild(el('text', { x: width, y: 132, fill: 'currentColor', 'font-size': 11, 'text-anchor': 'end' }, _('Now')));
	return svg;
}

return view.extend({
	hours: 24,
	load: function() { return callQuality(24); },
	renderData: function(data) {
		if (data.error) return E('p', { role: 'alert' }, data.error);
		var cards = (data.wans || []).sort(function(a, b) { return a.name.localeCompare(b.name); }).map(function(w) {
			var age = Math.max(0, data.now - w.epoch), latest = w.points[w.points.length - 1];
			return E('section', { 'class': 'mq-card' }, [
				E('div', { 'class': 'mq-heading' }, [ E('h3', {}, w.name),
					E('span', { 'class': 'mq-badge mq-' + (LABELS[w.state] ? w.state : 'unknown') }, LABELS[w.state] || LABELS.unknown) ]),
				E('div', { 'class': 'mq-note' }, (REASONS[w.reason] || w.reason) + ' · ' + _('Target: ') + w.target),
				E('div', { 'class': 'mq-metrics' }, [
					E('span', {}, _('Coverage: ') + metric(w.coverage, '%')),
					E('span', {}, _('Sampled packet loss: ') + metric(w.loss, '%')),
					E('span', {}, _('Last observation: ') + duration(age) + _(' ago')),
					E('span', {}, _('Probe interval: ') + w.interval + ' s') ]),
				chart(w, data),
				E('div', { 'class': 'mq-note' }, latest ? _('Latest chart bucket — latency: ') + metric(latest[4], ' ms') +
					' · ' + _('jitter: ') + metric(latest[6], ' ms') : _('Waiting for consecutive observations.'))
			]);
		});
		if (!cards.length) cards.push(E('p', {}, _('No observations yet. The background monitor will populate this page.')));
		var rows = (data.events || []).map(function(e) {
			return E('tr', {}, [ E('td', {}, when(e[0])), E('td', {}, e[1]),
				E('td', {}, EVENTS[e[2]] || e[2]), E('td', {}, REASONS[e[5]] || e[5]),
				E('td', {}, e[2] === 'recovery' ? duration(e[4]) : (e[2] === 'gap' ? _('Unknown') : '—')) ]);
		});
		cards.push(E('h3', {}, _('Outages and recovery')));
		cards.push(E('p', { 'class': 'mq-note' }, _('An outage means the interface or its configured probe failed. A single target cannot prove the entire internet is unreachable. Durations are estimates between observations.')));
		cards.push(rows.length ? E('div', { 'class': 'mq-scroll' }, E('table', { 'class': 'mq-table' }, [
			E('thead', {}, E('tr', {}, [_('Time'), _('WAN'), _('Event'), _('Evidence'), _('Recovered after')].map(function(t) { return E('th', {}, t); }))),
			E('tbody', {}, rows) ])) : E('p', {}, _('No events in this period.')));
		return E('div', {}, cards);
	},
	render: function(data) {
		var self = this, content = E('div', {}, this.renderData(data)), status = E('p', { role: 'status', 'class': 'mq-note' });
		function refresh() {
			var hours = self.hours;
			return callQuality(hours).then(function(next) {
				if (hours !== self.hours) return;
				if (next.error) throw new Error(next.error);
				content.textContent = ''; content.appendChild(self.renderData(next)); status.textContent = '';
			}).catch(function(err) { status.textContent = _('Refresh failed; displayed data may be stale. ') + err.message; });
		}
		var select = E('select', { 'aria-label': _('Time window'), change: function(ev) {
			self.hours = Number(ev.target.value); refresh();
		} }, [ E('option', { value: '1' }, _('Last hour')), E('option', { value: '24', selected: true }, _('Last 24 hours')) ]);
		poll.add(refresh, 10);
		return E('div', {}, [ E('style', {}, CSS), E('div', { 'class': 'mq-heading' }, [E('h2', {}, _('Quality & Events')), select]),
			E('p', {}, _('Continuous WAN monitoring. Green: responsive · Amber: degraded · Red: unresponsive · Empty: unknown.')),
			E('p', { 'class': 'mq-note' }, _('Coverage is the observed fraction of the selected window. Sampling gaps are excluded. Recent detail is kept in bounded RAM for up to 24 hours and resets on reboot; daily totals remain in 90-day History. Jitter is the mean RTT change between consecutive replies in a probe batch.')),
			status, content ]);
	},
	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
