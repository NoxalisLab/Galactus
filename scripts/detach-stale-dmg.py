#!/usr/bin/env python3
"""Detach every disk image this project left mounted.

WHY IT IS ITS OWN SCRIPT. The shell version paired a device with a name by
running `hdiutil info | grep -A5 <device>`, which is wrong twice: /dev/disk1 is
a prefix of /dev/disk10, and a five line window assumes a layout hdiutil does
not promise. The failure is not theoretical, it is the one that stops a build:
bundle_dmg.sh cannot create an image while a previous one is still attached,
and the message it gives says nothing about volumes.

The plist output pairs image-path with dev-entry exactly, which is the whole
point.
"""
import plistlib
import subprocess
import sys


def mounted() -> list[dict]:
    out = subprocess.run(
        ["hdiutil", "info", "-plist"], capture_output=True, check=False
    )
    if out.returncode != 0:
        return []
    try:
        return plistlib.loads(out.stdout).get("images", [])
    except Exception:
        return []


def main() -> int:
    # Anything whose backing file belongs to this project: the rw.*.dmg the
    # bundler works in, and the finished artifact if someone opened it.
    needle = "galactus"
    detached = 0
    for image in mounted():
        path = str(image.get("image-path", "")).lower()
        if needle not in path:
            continue
        for entity in image.get("system-entities", []):
            dev = entity.get("dev-entry")
            if not dev:
                continue
            done = subprocess.run(
                ["hdiutil", "detach", dev, "-force"], capture_output=True, check=False
            )
            if done.returncode == 0:
                print(f"detached {dev} ({image.get('image-path')})")
                detached += 1
            break
    if detached == 0:
        print("no stale image was mounted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
