import subprocess
import time
import sys
import urllib.request
import urllib.error


HEALTH_URL = "http://127.0.0.1:8080/health"
HEALTH_INTERVAL = 30  # seconds between health checks
HEALTH_TIMEOUT = 10   # seconds before health check is considered failed
HEALTH_MAX_FAILURES = 3  # consecutive failures before force-restart


def run_watcher(name, cmd):
    print(f"Monitoring {name}: {' '.join(cmd)}")

    # Only health-check the main server (index.js), not the bot.
    do_health = name == "index.js"
    consecutive_failures = 0

    while True:
        process = subprocess.Popen(cmd)
        startup_grace = time.time() + 30  # give it 30 s to start before health checks

        while True:
            try:
                returncode = process.poll()
                if returncode is not None:
                    # Process exited on its own.
                    if returncode == 0:
                        print(f"{name} exited successfully (code 0). Stopping restarter.")
                        return
                    else:
                        print(
                            f"{name} crashed with code {returncode}. Restarting in 1 second..."
                        )
                        time.sleep(1)
                        break  # break inner loop → outer loop spawns a new process

                # Process is still alive — run health check if enabled.
                if do_health and time.time() > startup_grace:
                    try:
                        req = urllib.request.Request(HEALTH_URL)
                        with urllib.request.urlopen(req, timeout=HEALTH_TIMEOUT) as resp:
                            if resp.status == 200:
                                consecutive_failures = 0
                            else:
                                raise urllib.error.URLError(f"status {resp.status}")
                    except Exception as e:
                        consecutive_failures += 1
                        print(
                            f"[health] {name} check {consecutive_failures}/{HEALTH_MAX_FAILURES} "
                            f"failed: {e}"
                        )
                        if consecutive_failures >= HEALTH_MAX_FAILURES:
                            print(
                                f"[health] {name} unresponsive after {HEALTH_MAX_FAILURES} "
                                f"checks — force-killing and restarting..."
                            )
                            process.kill()
                            try:
                                process.wait(timeout=5)
                            except subprocess.TimeoutExpired:
                                print(f"[health] {name} did not die, sending SIGKILL...")
                                process.kill()
                            time.sleep(1)
                            break  # break inner loop → outer loop spawns a new process

                time.sleep(HEALTH_INTERVAL if do_health else 15)

            except KeyboardInterrupt:
                print(f"\nStopping {name}...")
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                return


def main():
    cmds = {
        "index.js": ["bun", "index.js"],
        "bot.js": ["bun", "bot.js"],
    }

    print(f"Monitoring: {', '.join(' '.join(c) for c in cmds.values())}")

    procs = []
    for name, cmd in cmds.items():
        procs.append(subprocess.Popen(["python3", __file__, name]))

    try:
        for p in procs:
            p.wait()
    except KeyboardInterrupt:
        print("\nStopping...")
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
        sys.exit()


if __name__ == "__main__":
    if len(sys.argv) == 2:
        name = sys.argv[1]
        cmds = {
            "index.js": ["bun", "index.js"],
            "bot.js": ["bun", "bot.js"],
        }
        if name in cmds:
            run_watcher(name, cmds[name])
        else:
            print(f"Unknown process: {name}")
            sys.exit(1)
    else:
        main()