"""Validate package contents: python tests/check_package.py [path.ipk]."""
import io
import json
import pathlib
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
package = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'luci-app-multikmwan_1.1.0-1_all.ipk'
with tarfile.open(package, 'r:gz') as outer:
    assert set(outer.getnames()) == {'./debian-binary', './data.tar.gz', './control.tar.gz'}
    assert outer.extractfile('./debian-binary').read() == b'2.0\n'
    data_bytes = outer.extractfile('./data.tar.gz').read()
    control_bytes = outer.extractfile('./control.tar.gz').read()

with tarfile.open(fileobj=io.BytesIO(control_bytes), mode='r:gz') as control:
    manifest = control.extractfile('./control').read().decode()
    assert 'Version: 1.1.0-1\n' in manifest
    assert 'Depends: luci-base, curl\n' in manifest
    assert control.getmember('./postinst').mode == 0o755
    assert control.getmember('./prerm').mode == 0o755

with tarfile.open(fileobj=io.BytesIO(data_bytes), mode='r:gz') as data:
    required = [
        './usr/sbin/multikmwan', './etc/init.d/multikmwan', './usr/libexec/rpcd/luci.multikmwan',
        './usr/share/multikmwan/ping.awk', './usr/share/multikmwan/quality-update.awk',
        './usr/share/multikmwan/quality-json.awk', './usr/share/multikmwan/history-merge.awk',
        './usr/share/multikmwan/score.awk',
        './www/luci-static/resources/multikmwan.js',
        './www/luci-static/resources/view/multikmwan/quality.js',
    ]
    for name in required:
        member = data.getmember(name)
        assert member.size > 0, name
        assert member.mode == (0o755 if name in required[:3] else 0o644), name
    for member in data.getmembers():
        if member.isfile():
            content = data.extractfile(member).read()
            assert b'\r\n' not in content, f'CRLF in {member.name}'
            if member.name.endswith('.json'):
                json.loads(content)
    menu = json.loads(data.extractfile('./usr/share/luci/menu.d/luci-app-multikmwan.json').read())
    assert menu['admin/network/multikmwan/quality']['action']['path'] == 'multikmwan/quality'
    acl = json.loads(data.extractfile('./usr/share/rpcd/acl.d/luci-app-multikmwan.json').read())['luci-app-multikmwan']
    assert 'quality' in acl['read']['ubus']['luci.multikmwan']
    assert 'webtest' in acl['write']['ubus']['luci.multikmwan']
print(f'Package verified: {package.name} ({package.stat().st_size} bytes)')
