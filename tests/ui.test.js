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
function titles(n, out) { if (n instanceof Element) { if (n.attrs.title) out.push(n.attrs.title); n.children.forEach(c => titles(c, out)); } return out; }
function moduleView(relative, extra = {}) {
	const code = fs.readFileSync(path.join(root, relative), 'utf8');
	return vm.runInNewContext('(function(){' + code + '\n})()', {
		E, _: s => s, Date, Math, Number, String,
		document: { createElementNS: (ns, tag) => new Element(tag), createTextNode: text => String(text) },
		view: { extend: obj => obj }, baseclass: { extend: obj => obj }, rpc: { declare: () => () => Promise.resolve({}) },
		poll: { add: () => {} }, ui: {}, ...extra
	});
}
const shared = moduleView('htdocs/luci-static/resources/multikmwan.js');
const quality = moduleView('htdocs/luci-static/resources/view/multikmwan/quality.js');
const overview = moduleView('htdocs/luci-static/resources/view/multikmwan/overview.js', { multikmwan: shared });

// A two-link router: wan has more throughput, lower latency and quicker DNS;
// wan2 answers websites sooner and pulls more from Facebook's CDN.
const TWO = {
	now: 1000, health_interval: 20,
	rank: { mode: 'score', w_speed: '40', w_web: '25', w_latency: '20', w_dns: '15' },
	autorank: { interval: '15', margin: '15' },
	wans: [{ name: 'wan', color: '#2a6fb5', link: true, up: true, health_epoch: '990', rtt: '10', loss: '0', kmwan: 'online' },
		{ name: 'wan2', color: '#1f8b4c', link: true, up: true, health_epoch: '990', rtt: '17', loss: '0', kmwan: 'online' }],
	speed: [{ name: 'wan', down: '559', up: '225', status: 'ok', epoch: '900' }, { name: 'wan2', down: '537', up: '121', status: 'ok', epoch: '900' }],
	web: [{ name: 'wan', dns: '14', ttfb: '401', load: '620', ok: '4', total: '4', status: 'ok', epoch: '900' },
		{ name: 'wan2', dns: '28', ttfb: '350', load: '600', ok: '4', total: '4', status: 'ok', epoch: '900' }],
	websites: [{ name: 'wan', host: 'www.facebook.com', dns: '14', ttfb: '476', load: '686', http: '200', status: 'ok' },
		{ name: 'wan2', host: 'www.facebook.com', dns: '28', ttfb: '471', load: '693', http: '200', status: 'ok' },
		{ name: 'wan', host: 'www.youtube.com', dns: '15', ttfb: '360', load: '666', http: '200', status: 'ok' },
		{ name: 'wan2', host: 'www.youtube.com', dns: '28', ttfb: '320', load: '469', http: '200', status: 'ok' },
		{ name: 'wan', host: 'www.reddit.com', dns: '15', ttfb: '313', load: '314', http: '200', status: 'ok' },
		{ name: 'wan2', host: 'www.reddit.com', dns: '-', ttfb: '0', load: '0', http: '403', status: 'http_403_exit_0' }],
	content: [{ name: 'wan', profile: 'facebook', label: 'Facebook (real content)', down: '474.27', status: 'ok', host: 'static.xx.fbcdn.net', epoch: '900' },
		{ name: 'wan2', profile: 'facebook', label: 'Facebook (real content)', down: '539.20', status: 'ok', host: 'static.xx.fbcdn.net', epoch: '900' }],
	scores: [{ name: 'wan2', score: '82.0', speed: '658', web: '350', latency: '17.3', dns: '28', sites: '2', speed_pts: '0.839', web_pts: '1.000', lat_pts: '0.740', dns_pts: '0.500' },
		{ name: 'wan', score: '100.0', speed: '784', web: '401', latency: '12.8', dns: '14', sites: '2', speed_pts: '1.000', web_pts: '0.873', lat_pts: '1.000', dns_pts: '1.000' }]
};

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

test('first failed speed test still exposes its source in the log', () => {
	const node = overview.renderGraph({ speedhist: [], testhistory: [{ epoch: '1000', wan: 'wan',
		label: 'Cloudflare', download_host: 'speed.cloudflare.com', upload_host: 'speed.cloudflare.com',
		download_status: 'http_403_exit_0', upload_status: 'not_run' }] });
	assert.match(node.textContent, /Speed test log/);
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

test('cards show score, websites, DNS and real-content figures, with the breakdown in a tooltip', () => {
	const node = overview.renderWans(TWO), text = node.textContent;
	assert.match(text, /score100/);
	assert.match(text, /score82/);
	assert.match(text, /Websites 401 ms/);
	assert.match(text, /DNS 14 ms/);
	assert.match(text, /Facebook 474 Mbps/);
	assert.match(text, /Facebook 539 Mbps/);
	assert.match(text, /↓ 559  ↑ 225 Mbps/);
	assert.doesNotMatch(text, /Test source/);
	assert.match(titles(node, []).join('\n'),
		/throughput 1.00 × 40% \+ websites 0.87 × 25% \+ latency 1.00 × 20% \+ DNS 1.00 × 15%.*ping 13 ms/);
});

test('links disabled in kmwan are left off the cards and the site table, with a footnote', () => {
	const cards = overview.renderWans({ now: 1000, health_interval: 20,
		wans: [{ name: 'wan', link: true, up: true }, { name: 'wwan', disabled: '1' }, { name: 'modem', disabled: '1' }] });
	assert.match(cards.textContent, /wan/);
	assert.doesNotMatch(cards.textContent, /not tracked/);
	assert.match(cards.textContent, /Not shown \(disabled in kmwan\): wwan, modem\./);
	const table = overview.renderSites({ wans: [{ name: 'wan' }, { name: 'wwan', disabled: '1' }],
		websites: [{ name: 'wan', host: 'www.facebook.com', dns: '14', ttfb: '180', load: '620', http: '200', status: 'ok' }] });
	assert.doesNotMatch(table.textContent, /wwan/);
	assert.doesNotMatch(overview.renderWans({ wans: [{ name: 'wan', link: true, up: true }] }).textContent, /Not shown/);
});

test('throughput-only mode hides the score; failed website tests stay visible', () => {
	const node = overview.renderWans({ now: 1000, health_interval: 20, rank: { mode: 'speed', by: 'down' },
		wans: [{ name: 'wan', link: true, up: true }, { name: 'lte', link: true, up: true, metered: '1' }],
		web: [{ name: 'wan', dns: '-', ttfb: '-', load: '-', ok: '0', total: '4', status: 'fail', epoch: '900' }],
		scores: [{ name: 'wan', score: '100.0' }] });
	assert.match(node.textContent, /score-/);
	assert.match(node.textContent, /last website test failed/);
	assert.match(node.textContent, /metered: websites not tested/);
	const ranking = overview.renderRanking({ rank: { mode: 'speed', by: 'down' }, scores: [{ name: 'wan', score: '100.0' }],
		speed: [{ name: 'wan', down: '10', up: '1', status: 'ok' }] });
	assert.match(ranking.textContent, /Ranking by throughput only/);
	assert.match(ranking.textContent, /only line with a measurement/);
});

test('ranking panel gives a verdict, marks leaders, states how far behind the others are', () => {
	const node = overview.renderRanking(TWO), text = node.textContent;
	assert.match(text, /wan is the faster line right now \(score 100 vs wan2 82\)\. It wins on downloads, uploads, latency and DNS\. wan2 is ahead on website response; wan2 is ahead on Facebook downloads\./);
	assert.match(text, /wanfastest/);
	assert.match(text, /559 Mbps ✓/);
	assert.match(text, /4% slower/);        // wan2 download 537 vs 559
	assert.match(text, /46% slower/);       // wan2 upload 121 vs 225
	assert.match(text, /350 ms ✓/);         // wan2 websites
	assert.match(text, /15% slower/);       // wan websites 401 vs 350
	assert.match(text, /539 Mbps ✓/);       // wan2 Facebook
	assert.match(text, /12% slower/);       // wan Facebook 474 vs 539
	assert.match(titles(node, []).join('\n'), /401 ms/);   // raw value behind "15% slower"
	// Per-site lines: friendly names, the leader, and the rest relative to it.
	assert.match(text, /Facebook  ·  wan2 ✓  ·  wan about the same/);
	assert.match(text, /YouTube  ·  wan2 ✓  ·  wan 13% slower/);
	assert.match(text, /Reddit  ·  wan ✓  ·  wan2 failed/);
	assert.match(text, /Score: throughput 40%, websites 25%, latency 20%, DNS 15%, each against the best line\. Auto-rank switches only when a rival beats the leader by 15%\./);
	assert.match(overview.renderRanking({ scores: [] }).textContent, /No ranking yet/);
});

test('raw site grid keeps every measurement and marks the soonest answer', () => {
	const node = overview.renderSites(TWO), text = node.textContent;
	assert.match(text, /Facebook/);
	assert.match(text, /DNS 14  ·  first byte 476  ·  page 686 ms/);
	assert.match(text, /DNS 28  ·  first byte 471  ·  page 693 ms ✓/);
	assert.match(text, /failed \(http_403_exit_0\)/);
	assert.match(titles(node, []).join('\n'), /www.facebook.com/);
	assert.match(overview.renderSites({ websites: [] }).textContent, /No website test yet/);
});

test('progress and carried-forward results are visible on the page', () => {
	const busy = Object.assign({}, TWO, { testing: { active: true, kind: 'speed', wan: 'wan2', step: 'download-retry', index: '2', total: '2' } });
	assert.match(overview.renderWans(busy).textContent, /wan2testing…/);
	assert.equal(overview.progressText(busy, { profiles: [] }), 'Speed test: wan2, download, retry (2 of 2)…');
	assert.equal(overview.progressText({ testing: { active: true, kind: 'web', wan: 'wan', step: 'facebook', index: '1', total: '1' } },
		{ profiles: [{ id: 'facebook', label: 'Facebook' }] }), 'Website test: wan, Facebook…');
	assert.equal(overview.progressText({ testing: { active: false } }, { profiles: [] }), '');
	const stale = Object.assign({}, TWO, { testhistory: [{ epoch: '950', wan: 'wan', status: 'fail', download_status: 'http_200_exit_28', upload_status: 'ok' }] });
	assert.match(overview.renderWans(stale).textContent, /↓ 559  ↑ 225 Mbps2 min agolast test failed, showing the previous result/);
	assert.doesNotMatch(overview.renderWans(TWO).textContent, /previous result/);
});

test('mode and source lines stay short', () => {
	assert.equal(overview.modeText({ now: 1000, mode: 'failover', enabled: '1',
		autorank: { interval: '15', epoch: '700', decision: 'same-leader' } }),
		'Fastest mode  ·  re-checked every 15 min  ·  last check 5 min ago: no change');
	assert.equal(overview.sourceText(TWO), 'Speed tests: not set  ·  Websites: Facebook, YouTube, Reddit');
});

test('empty timeline and server errors are visible', () => {
	assert.match(quality.renderData({ wans: [], events: [] }).textContent, /No observations yet/);
	assert.match(quality.renderData({ error: 'Monitor unavailable' }).textContent, /Monitor unavailable/);
});
