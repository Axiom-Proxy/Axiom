import subprocess
import time
import sys


def run_watcher(name, cmd):
    print(f"Monitoring {name}: {' '.join(cmd)}")

    while True:
        process = subprocess.Popen(cmd)

        try:
            process.wait()

            if process.returncode == 0:
                print(f"{name} exited successfully (code 0). Stopping restarter.")
                return
            else:
                print(
                    f"{name} crashed with code {process.returncode}. Restarting in 1 second..."
                )
                time.sleep(1)

        except KeyboardInterrupt:
            print(f"\nStopping {name}...")
            process.terminate()
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
