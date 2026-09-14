// Exercise LuCI view rendering without a router. node --test tests/ui.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

class Element {
	constructor(tag, attrs = {}, children = []) {
		this.tag = tag; this.attrs = attrs; this.children = [];
		(Array.isArray(children) ? children : [children]).forEach(c => this.appendChild(c));
	}
	appendChild(c) { if (c != null) this.children.push(c); return c; }
	setAttribute(k, v) { this.attrs[k] = v; }
	set textContent(v) { this.children = [String(v)]; }
	get textContent() { return this.children.map(c => c instanceof Element ? c.textContent : c).join(''); }
}
function E(tag, attrs, children) {
	if (typeof attrs === 'string' || Array.isArray(attrs) || attrs instanceof Element) return new Element(tag, {}, attrs);
	return new Element(tag, attrs || {}, children || []);
}
function moduleView(relative, extra = {}) {
	const code = fs.readFileSync(path.join(root, relative), 'utf8');
	return vm.runInNewContext('(function(){' + code + '\n})()', {
		E, _: s => s, Date, Math, Number,
		document: { createElementNS: (ns, tag) => new Element(tag), createTextNode: text => String(text) },
		view: { extend: obj => obj }, baseclass: { extend: obj => obj }, rpc: { declare: () => () => Promise.resolve({}) },
		poll: { add: () => {} }, ui: {}, ...extra
	});
}
const shared = moduleView('htdocs/luci-static/resources/multikmwan.js');
const quality = moduleView('htdocs/luci-static/resources/view/multikmwan/quality.js');
const overview = moduleView('htdocs/luci-static/resources/view/multikmwan/overview.js', { multikmwan: shared });

test('source table preserves providers, hostnames and direction failures as text', () => {
	const table = shared.testTable([{ epoch: '1000', wan: 'wan', kind: 'scheduled', label: '<Cloud & Co>',
		profile: 'original', download_host: 'download.example', upload_host: 'upload.example',
		down: '50', up: '0', download_status: 'ok', upload_status: 'http_403_exit_0' }]);
	assert.match(table.textContent, /<Cloud & Co>/);
	assert.match(table.textContent, /download.example/);
	assert.match(table.textContent, /upload.example/);
	assert.match(table.textContent, /50.0 Mbps/);
	assert.match(table.textContent, /Failed \/ not measured \(http_403_exit_0\)/);
});

test('stale health cannot appear healthy', () => {
	const node = overview.renderWans({ now: 1000, health_interval: 20, wans: [{ name: 'wan', link: true,
		up: true, health_epoch: '100', rtt: '10', loss: '0', kmwan: 'online' }] });
	assert.match(node.textContent, /unknown/);
	assert.match(node.textContent, /missing or stale/);
});

test('first failed speed test still exposes its source', () => {
	const node = overview.renderGraph({ speedhist: [], testhistory: [{ epoch: '1000', wan: 'wan',
		label: 'Cloudflare', download_host: 'speed.cloudflare.com', upload_host: 'speed.cloudflare.com',
		download_status: 'http_403_exit_0', upload_status: 'not_run' }] });
	assert.match(node.textContent, /Cloudflare/);
	assert.match(node.textContent, /http_403_exit_0/);
});

test('timeline renders unknown metrics, coverage and incident evidence', () => {
	const node = quality.renderData({ now: 3600, hours: 1, bucket_seconds: 60,
		wans: [{ name: 'wan', state: 'unknown', epoch: 120, interval: 20, target: '1.1.1.1', reason: 'stale',
			coverage: .56, loss: null, points: [[60, 20, 0, 0, 10, 0, null]] }],
		events: [[300, 'wan', 'gap', 120, -1, 'sampling_gap']] });
	assert.match(node.textContent, /Coverage: 0.6%/);
	assert.match(node.textContent, /Sampled packet loss: Unavailable/);
	assert.match(node.textContent, /Sampling gap or clock change/);
	function check(n) {
		if (!(n instanceof Element)) return;
		if (n.tag === 'rect') assert.ok(Number(n.attrs.width) >= 0 && Number(n.attrs.height) >= 0);
		n.children.forEach(check);
	}
	check(node);
});

test('cards show the composite score, DNS and site response', () => {
	const node = overview.renderWans({ now: 1000, health_interval: 20,
		rank: { mode: 'score', w_speed: '40', w_web: '25', w_latency: '20', w_dns: '15' },
		wans: [{ name: 'wan', link: true, up: true, health_epoch: '990', rtt: '10', loss: '0', kmwan: 'online' }],
		web: [{ name: 'wan', dns: '14', ttfb: '180', load: '620', ok: '3', total: '4', status: 'ok', epoch: '900' }],
		scores: [{ name: 'wan', score: '87.5', speed_pts: '1.000', dns_pts: '0.700', web_pts: '0.900', sites: '3',
			lat_pts: '0.800', latency: '17.5' }] });
	assert.match(node.textContent, /score88/);
	assert.match(node.textContent, /DNS 14 ms/);
	assert.match(node.textContent, /sites 180 ms to first byte/);
	assert.match(node.textContent, /3\/4 sites, 2 min ago/);
	function titles(n, out) { if (n instanceof Element) { if (n.attrs.title) out.push(n.attrs.title); n.children.forEach(c => titles(c, out)); } return out; }
	assert.match(titles(node, []).join('\n'),
		/throughput 1.00 × 40% \+ website 0.90 × 25% \+ latency 0.80 × 20% \+ DNS 0.70 × 15%.*ping 18 ms/);
});

test('links disabled in kmwan are left off the cards and the site table, with a footnote', () => {
	const cards = overview.renderWans({ now: 1000, health_interval: 20,
		wans: [{ name: 'wan', link: true, up: true }, { name: 'wwan', disabled: '1' }, { name: 'modem', disabled: '1' }] });
	assert.match(cards.textContent, /wan/);
	assert.doesNotMatch(cards.textContent, /not tracked/);
	assert.match(cards.textContent, /Disabled in kmwan and not shown: wwan, modem\./);
	const table = overview.renderSites({ wans: [{ name: 'wan' }, { name: 'wwan', disabled: '1' }],
		websites: [{ name: 'wan', host: 'www.facebook.com', dns: '14', ttfb: '180', load: '620', http: '200', status: 'ok' }] });
	assert.doesNotMatch(table.textContent, /wwan/);
	assert.doesNotMatch(overview.renderWans({ wans: [{ name: 'wan', link: true, up: true }] }).textContent, /not shown/);
});

test('throughput-only mode hides the score and failed website tests stay visible', () => {
	const node = overview.renderWans({ now: 1000, health_interval: 20, rank: { mode: 'speed', by: 'down' },
		wans: [{ name: 'wan', link: true, up: true }, { name: 'lte', link: true, up: true, metered: '1' }],
		web: [{ name: 'wan', dns: '-', ttfb: '-', load: '-', ok: '0', total: '4', status: 'fail', epoch: '900' }],
		scores: [{ name: 'wan', score: '100.0' }] });
	assert.match(node.textContent, /score-/);
	assert.match(node.textContent, /last website test failed/);
	assert.match(node.textContent, /metered - websites not tested/);
	assert.match(overview.rankText({ rank: { mode: 'speed', by: 'down' } }), /throughput only \(download\)/);
	assert.match(overview.rankText({ rank: { mode: 'score', w_speed: '40', w_web: '25', w_latency: '20', w_dns: '15' } }),
		/throughput 40%.*website response 25%.*latency 20%.*DNS 15%/);
});

test('website table shows every site per WAN and keeps failures readable', () => {
	const node = overview.renderSites({ wans: [{ name: 'wan' }, { name: 'wan2' }], websites: [
		{ name: 'wan', host: 'www.facebook.com', dns: '14', ttfb: '180', load: '620', http: '200', status: 'ok' },
		{ name: 'wan2', host: 'www.facebook.com', dns: '-', ttfb: '0', load: '0', http: '403', status: 'http_403_exit_0' } ] });
	assert.match(node.textContent, /www.facebook.com/);
	assert.match(node.textContent, /DNS 14  ·  first byte 180  ·  page 620 ms/);
	assert.match(node.textContent, /failed \(http_403_exit_0\)/);
	assert.match(overview.renderSites({ websites: [] }).textContent, /No website test yet/);
});

test('empty timeline and server errors are visible', () => {
	assert.match(quality.renderData({ wans: [], events: [] }).textContent, /No observations yet/);
	assert.match(quality.renderData({ error: 'Monitor unavailable' }).textContent, /Monitor unavailable/);
});
