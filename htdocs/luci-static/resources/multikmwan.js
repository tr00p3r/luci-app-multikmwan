'use strict';
'require baseclass';

function sourceText(test) {
	if (!test) return _('Source not recorded');
	return (test.label || test.profile || _('Custom endpoint')) + ' · ↓ ' +
		(test.download_host || _('Unknown host')) + ' · ↑ ' + (test.upload_host || _('Unknown host'));
}

function testTable(tests, limit) {
	var rows = (tests || []).slice().reverse().slice(0, limit || 256).map(function(t) {
		function result(direction) {
			var status = t[direction + '_status'];
			return status === 'ok' ? Number(t[direction === 'download' ? 'down' : 'up']).toFixed(1) + ' Mbps' :
				_('Failed / not measured') + ' (' + (status || _('Unknown')) + ')';
		}
		return E('tr', {}, [
			E('td', {}, new Date(Number(t.epoch) * 1000).toLocaleString()), E('td', {}, t.wan),
			E('td', {}, t.kind === 'scheduled' ? _('Scheduled transfer') : _('Manual transfer')),
			E('td', {}, sourceText(t)), E('td', {}, result('download')), E('td', {}, result('upload'))
		]);
	});
	if (!rows.length) return E('p', {}, _('No attributed speed tests yet. New runs record their source; older results have no source metadata.'));
	return E('div', { style: 'overflow-x:auto' }, E('table', { 'class': 'table' }, [
		E('thead', {}, E('tr', {}, [_('Test started'), _('WAN'), _('Type'), _('Profile and actual hosts'), _('Download'), _('Upload')].map(function(h) {
			return E('th', {}, h);
		}))), E('tbody', {}, rows)
	]));
}

// LuCI's loader only accepts a class from a module factory (a plain object
// throws "factory yields invalid constructor"), so export via baseclass.
// Privacy mode: blur addresses, ISP names, locations, device names and
// custom server URLs on every MultiKmwan page so a screenshot can be shared
// as-is. The choice lives in this browser (localStorage) and applies to all
// tabs; elements opt in with the mk-private class, and LuCI grid cells are
// matched by their data-name. Nothing leaves the browser.
var PRIVACY_KEY = 'multikmwan.privacy';
var PRIVACY_CSS = '.mk-privacy .mk-private,' +
	'.mk-privacy td[data-name="src"],.mk-privacy td[data-name="label"],' +
	'.mk-privacy td[data-name="down_url"],.mk-privacy td[data-name="up_url"]' +
	'{filter:blur(6px);user-select:none}' +
	'.mk-topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}' +
	'.mk-topbar h2{margin:0}.mk-privacy-btn{white-space:nowrap}';

function privacyOn() {
	try { return window.localStorage.getItem(PRIVACY_KEY) === '1'; } catch (e) { return false; }
}
function applyPrivacy() {
	try {
		if (document.documentElement && document.documentElement.classList)
			document.documentElement.classList.toggle('mk-privacy', privacyOn());
	} catch (e) { }
}
function privacyLabel() { return privacyOn() ? _('Privacy: on') : _('Privacy: off'); }

// A toggle button plus the style it needs; put it in a page header.
function privacyButton() {
	var btn = E('button', { 'class': 'cbi-button cbi-button-neutral mk-privacy-btn',
		'title': _('Blur addresses, providers, locations and device names for screenshots'),
		'click': function(ev) {
			if (ev && ev.preventDefault) ev.preventDefault();
			try { window.localStorage.setItem(PRIVACY_KEY, privacyOn() ? '0' : '1'); } catch (e) { }
			applyPrivacy();
			btn.textContent = privacyLabel();
		} }, privacyLabel());
	applyPrivacy();
	return E('span', {}, [ E('style', {}, PRIVACY_CSS), btn ]);
}

// "<h2>Title</h2> [Privacy]" as one row, for the top of each page.
function topbar(title, extra) {
	return E('div', { 'class': 'mk-topbar' }, [ E('h2', {}, title), E('span', {}, [ extra || '', privacyButton() ]) ]);
}

return baseclass.extend({ sourceText: sourceText, testTable: testTable,
	privacyOn: privacyOn, privacyButton: privacyButton, topbar: topbar });
