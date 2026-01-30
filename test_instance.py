"""Test script to verify single instance behavior."""
import subprocess
import time
import sys
from pathlib import Path

print("=" * 60)
print("Testing Single Instance Management")
print("=" * 60)

# Start first instance
print("\n[1] Starting first instance...")
proc1 = subprocess.Popen(
    [sys.executable, 'run_dev.py'],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True
)

# Wait for it to initialize
print("    Waiting for initialization (5 seconds)...")
time.sleep(5)

# Check if PID file was created
pid_file = Path('.dev_pids.json')
if pid_file.exists():
    print(f"    ✓ PID file created: {pid_file}")
    import json
    with open(pid_file) as f:
        data = json.load(f)
        print(f"    ✓ Frontend PID: {data.get('frontend')}")
        print(f"    ✓ Backend PID: {data.get('backend')}")
        print(f"    ✓ Marker: {data.get('marker')}")
else:
    print("    ✗ PID file NOT created")

# Try to start second instance
print("\n[2] Attempting to start second instance...")
result = subprocess.run(
    [sys.executable, 'run_dev.py'],
    capture_output=True,
    text=True,
    timeout=30
)

print("    Second instance output:")
for line in result.stdout.splitlines():
    if 'Found previous' in line or 'terminating' in line or 'Prerequisites' in line:
        print(f"    {line}")

# Check if second instance killed the first
time.sleep(2)
if proc1.poll() is None:
    print("\n    ✓ First instance still running (good!)")
    print("\n[3] Terminating first instance...")
    proc1.terminate()
    try:
        proc1.wait(timeout=10)
        print("    ✓ First instance terminated cleanly")
    except subprocess.TimeoutExpired:
        proc1.kill()
        print("    ! First instance force killed")
else:
    print(f"\n    ✗ First instance died (exit code: {proc1.returncode})")
    print("    Second instance should have taken over...")

# Check if PID file was cleaned up
time.sleep(1)
if pid_file.exists():
    print("\n[4] Checking PID file after shutdown...")
    print(f"    ⚠ PID file still exists (will be cleaned on next proper shutdown)")
else:
    print("\n[4] PID file cleaned up properly ✓")

print("\n" + "=" * 60)
print("Test complete!")
print("=" * 60)
