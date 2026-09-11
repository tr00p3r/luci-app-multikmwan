"""Pack a control/ + data/ tree into a tar.gz-style OpenWrt .ipk.

    python3 pack_ipk.py <dir-containing-control-and-data> <out.ipk>

Why not `tar` + `ar`?  Two reasons, both learned the hard way:

* Modern opkg (OpenWrt 21+, GL.iNet 4.x) expects the .ipk to be a *gzipped
  tar* of debian-binary + control.tar.gz + data.tar.gz.  The older Debian
  `ar` container is rejected with "Malformed package file".
* Windows can't represent the Unix exec bit, so tarring from the filesystem
  there ships 0644 scripts that opkg installs un-runnable.  Modes are set
  here explicitly, by path.
"""
import gzip
import io
import os
import sys
import tarfile
import time

# Paths under these prefixes (data tree) or with these names (control tree)
# ship 0755.  Everything else ships 0644.
EXEC_PREFIXES = (
    "./usr/sbin/",
    "./usr/bin/",
    "./usr/libexec/",
    "./etc/init.d/",
    "./etc/hotplug.d/",
    "./etc/uci-defaults/",
)
EXEC_NAMES = {"./preinst", "./postinst", "./postinst-pkg", "./prerm", "./postrm"}

# One timestamp for the whole build. NOT zero: uhttpd serves LuCI's JS with
# Last-Modified from the file mtime, so an all-zero mtime means browsers keep
# the previous release's views after an upgrade. SOURCE_DATE_EPOCH is honoured
# for reproducible builds.
STAMP = int(os.environ.get("SOURCE_DATE_EPOCH", time.time()))


def _is_exec(arc):
    return arc in EXEC_NAMES or any(arc.startswith(p) for p in EXEC_PREFIXES)


def _norm(ti, arc):
    ti.uid = ti.gid = 0
    ti.uname = ti.gname = "root"
    ti.mtime = STAMP
    ti.mode = 0o755 if (ti.isdir() or _is_exec(arc)) else 0o644
    return ti


def build_tar_gz(src_dir):
    """Tar the *contents* of src_dir with ./-prefixed paths, then gzip."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.GNU_FORMAT) as tf:
        for dirpath, dirnames, filenames in os.walk(src_dir):
            dirnames.sort()
            filenames.sort()
            for name in dirnames + filenames:
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, src_dir).replace(os.sep, "/")
                arc = "./" + rel
                ti = _norm(tf.gettarinfo(full, arcname=arc), arc)
                if ti.isreg():
                    with open(full, "rb") as fh:
                        tf.addfile(ti, fh)
                else:
                    tf.addfile(ti)
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", mtime=STAMP) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    root, outfile = sys.argv[1], sys.argv[2]
    ctl_dir, data_dir = os.path.join(root, "control"), os.path.join(root, "data")

    data_gz = build_tar_gz(data_dir)

    # Installed-Size is conventionally the data.tar.gz size; fill it in.
    ctl_path = os.path.join(ctl_dir, "control")
    with open(ctl_path, "r", encoding="utf-8", newline="") as fh:
        lines = fh.read().splitlines()
    lines = ["Installed-Size: %d" % len(data_gz) if l.startswith("Installed-Size:") else l
             for l in lines]
    with open(ctl_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")

    ctl_gz = build_tar_gz(ctl_dir)

    members = [
        ("./debian-binary", b"2.0\n"),
        ("./data.tar.gz", data_gz),
        ("./control.tar.gz", ctl_gz),
    ]
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.GNU_FORMAT) as tf:
        for name, blob in members:
            ti = tarfile.TarInfo(name)
            ti.size, ti.mode, ti.mtime = len(blob), 0o644, STAMP
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = "root"
            tf.addfile(ti, io.BytesIO(blob))
    with open(outfile, "wb") as fh:
        with gzip.GzipFile(fileobj=fh, mode="wb", mtime=STAMP) as gz:
            gz.write(raw.getvalue())

    print("built %s (%d bytes; data %d, control %d)"
          % (outfile, os.path.getsize(outfile), len(data_gz), len(ctl_gz)))


if __name__ == "__main__":
    main()
