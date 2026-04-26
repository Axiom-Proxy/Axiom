import subprocess
import time
import sys

def main():
    cmd = ["node", "index.js"]
    
    print(f"Monitoring: {' '.join(cmd)}")

    while True:
        process = subprocess.Popen(cmd)

        try:
            process.wait()

            if process.returncode == 0:
                print("Process exited successfully (code 0).Stopping restarter.")
                break
            else:
                print(f"Process crashed with code {process.returncode}. Restarting in 1 second...")
                time.sleep(1)

        except KeyboardInterrupt:
            print("\nStopping...")
            process.terminate()
            process.wait()
            sys.exit()

if __name__ == "__main__":
    main()