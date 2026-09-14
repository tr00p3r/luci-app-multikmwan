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
return baseclass.extend({ sourceText: sourceText, testTable: testTable });
