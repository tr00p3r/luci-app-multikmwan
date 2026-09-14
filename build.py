"""Build the OpenWrt package on Windows or Unix: python build.py."""
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent


def main():
    control = (ROOT / 'control/control').read_text(encoding='utf-8')
    version = re.search(r'^Version: (.+)$', control, re.MULTILINE).group(1)
    output = ROOT / ('luci-app-multikmwan_' + version + '_all.ipk')
    with tempfile.TemporaryDirectory(prefix='multikmwan-build-') as temp:
        stage = pathlib.Path(temp)
        shutil.copytree(ROOT / 'root', stage / 'data')
        shutil.copytree(ROOT / 'htdocs', stage / 'data/www')
        shutil.copytree(ROOT / 'control', stage / 'control')
        # Archives must contain LF scripts even from an older Windows checkout.
        for path in stage.rglob('*'):
            if path.is_file():
                content = path.read_bytes()
                if (content.startswith(b'#!') or path.suffix in ('.js', '.json', '.awk')
                        or path.parent.name == 'control'):
                    path.write_bytes(content.replace(b'\r\n', b'\n'))
        subprocess.run([sys.executable, str(ROOT / 'pack_ipk.py'), str(stage), str(output)], check=True)


if __name__ == '__main__':
    main()
