"""PID 1 for an isolated official WARP proxy; never register automatically."""
import signal
import os
import subprocess
import time

children = []


def stop(*_):
    for child in reversed(children):
        child.terminate()
    for child in reversed(children):
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
    raise SystemExit(0)


def cli(*args):
    return subprocess.run(['warp-cli', '--accept-tos', *args],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)


def main():
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    os.makedirs('/run/dbus', exist_ok=True)
    children.append(subprocess.Popen(['dbus-daemon', '--system', '--nofork']))
    children.append(subprocess.Popen(['warp-svc']))
    # WARP's proxy binds loopback. The container alone exposes this forwarder;
    # the host publishes it only on 127.0.0.1. Both HTTP CONNECT and SOCKS pass.
    children.append(subprocess.Popen(['socat', 'TCP-LISTEN:40001,bind=0.0.0.0,reuseaddr,fork',
                                      'TCP:127.0.0.1:40000']))
    for _ in range(30):
        if cli('registration', 'show').returncode == 0:
            for args in [('mode', 'proxy'), ('proxy', 'port', '40000'),
                         ('tunnel', 'protocol', 'set', 'MASQUE'), ('connect',)]:
                if cli(*args).returncode:
                    raise SystemExit(1)
            break
        time.sleep(1)
    while all(child.poll() is None for child in children):
        time.sleep(1)
    stop()


if __name__ == '__main__':
    main()
