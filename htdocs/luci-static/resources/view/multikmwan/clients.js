'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require ui';

var callSync    = rpc.declare({ object: 'luci.multikmwan', method: 'sync' });
var callClients = rpc.declare({ object: 'luci.multikmwan', method: 'clients' });

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('multikmwan'),
			uci.load('kmwan'),
			callClients().catch(function() { return { clients: [] }; })
		]);
	},

	render: function(data) {
		var hosts = (data[2] && data[2].clients) || [];
		var m, s, o;

		m = new form.Map('multikmwan', _('Client Preference'),
			_('Pick a device and choose which WAN it should use. If that WAN goes ' +
			  'down the device falls through to its next choice automatically. ' +
			  'Anything not listed here just follows the router\'s normal mode.'));

		s = m.section(form.NamedSection, 'global', 'global');
		o = s.option(form.Flag, 'enabled', _('Enable client preference'),
			_('Off means every device follows the normal multi-WAN mode.'));
		o.default = '0';
		o.rmempty = false;

		s = m.section(form.GridSection, 'client', _('Devices'));
		s.addremove = true;
		s.anonymous = true;
		s.nodescriptions = true;
		s.sortable = true;

		o = s.option(form.Flag, 'enabled', _('On'));
		o.default = '1';
		o.editable = true;
		o.width = '60px';

		o = s.option(form.Value, 'src', _('Device'),
			_('Choose a known device, or type an address / range such as ' +
			  '192.168.0.64/28.'));
		o.datatype = 'or(ipaddr,cidr4)';
		o.rmempty = false;
		o.placeholder = '192.168.0.50';

		// Known hosts: static reservations first, then current DHCP leases.
		// A dynamic lease can change address and silently stop matching, so
		// it is labelled as such.
		var seen = {};
		hosts.forEach(function(h) {
			if (!h.ip || seen[h.ip]) return;
			seen[h.ip] = true;
			var nm = (h.name && h.name !== '*') ? h.name : (h.mac || h.ip);
			o.value(h.ip, nm + ' — ' + h.ip + (h.static ? '' : _(' (dynamic lease)')));
		});

		o = s.option(form.DynamicList, 'order', _('Use these WANs, in order'),
			_('First one that is up wins.'));
		var members = uci.sections('kmwan', 'member');
		for (var i = 0; i < members.length; i++) {
			var n = members[i]['.name'];
			if (members[i].addr_type === '4')
				o.value(n, n + (members[i].disabled === '1' ? _(' (not tracked)') : ''));
		}

		o = s.option(form.Value, 'label', _('Note'));
		o.modalonly = true;
		o.placeholder = _('optional');

		o = s.option(form.Value, 'interval', _('Re-check interval'),
			_('Seconds between route re-syncs.'));
		o.datatype = 'range(5,300)';
		o.default = '20';
		o.modalonly = true;
		o.cfgvalue = function() { return uci.get('multikmwan', 'global', 'interval'); };
		o.write = function(sid, v) { uci.set('multikmwan', 'global', 'interval', v); };

		return m.render();
	},

	// handleSave() only STAGES changes in /tmp/.uci; uci.apply() is what
	// commits them to flash. Skipping it is how client rows got lost.
	handleSaveApply: function(ev) {
		return this.handleSave(ev).then(function() {
			return uci.apply();
		}).then(function() {
			return callSync();
		}).then(function() {
			ui.addNotification(null,
				E('p', _('Saved to flash — rules rebuilt.')), 'info');
		});
	}
});
