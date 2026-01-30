# run_dev.py Instance Management Fix

## Summary

Fixed `run_dev.py` to use a reliable PID-based instance management system instead of port-based process killing.

## Changes Made

### 1. Added Dependencies
- **psutil** (v5.9.0+): Cross-platform process management library
- Added to `requirements.txt`

### 2. Instance Tracking System
- **Environment Marker**: `NOTEES_DEV_ENVIRONMENT=1` set on all dev processes
- **PID File**: `.dev_pids.json` tracks frontend and backend PIDs
- **Process Detection**: Scans for processes with the dev environment marker

### 3. Key Features

#### Single Instance Enforcement
- On startup, kills any previous Notees dev instance
- Detects both:
  - Processes tracked in PID file
  - Orphaned processes with the dev environment marker

#### Clean Shutdown
- PID file is cleaned up on graceful shutdown (Ctrl+C)
- Process tree termination using psutil (cross-platform)

#### Port Validation
- No longer kills arbitrary processes on ports 5173/8000
- Only prevents startup if **non-Notees** processes are using those ports
- Improved port checking to ignore TIME_WAIT connections

### 4. Files Modified

- `run_dev.py`: Complete rewrite of instance management
- `requirements.txt`: Added psutil dependency
- `.gitignore`: Added `.dev_pids.json` exclusion

### 5. Testing

Created `test_instance.py` which validates:
- ✅ PID file creation with correct marker
- ✅ Second instance terminates the first
- ✅ Clean shutdown and PID file cleanup
- ✅ Orphaned process detection

## Usage

```bash
# Start dev environment (kills any previous instance)
python run_dev.py

# Stop with Ctrl+C - cleans up automatically
```

## Technical Details

### Process Identification
```python
# Each dev process has this in its environment
DEV_ENV_MARKER = "NOTEES_DEV_ENVIRONMENT"

# Checked via psutil
def is_notees_dev_process(pid):
    proc = psutil.Process(pid)
    return proc.environ().get(DEV_ENV_MARKER) == "1"
```

### PID File Format
```json
{
  "frontend": 26484,
  "backend": 12456,
  "marker": "NOTEES_DEV_ENVIRONMENT"
}
```

### Safety Features
- Will NOT kill processes without the marker
- Validates PIDs exist before attempting termination
- Graceful termination with 5-second timeout, then force kill
- 2-second wait after killing to ensure port release

## Benefits

1. **No collateral damage**: Won't kill unrelated apps on ports 5173/8000
2. **Reliable cleanup**: Finds orphaned processes from crashed sessions
3. **Cross-platform**: Works on Windows, Linux, macOS via psutil
4. **Single instance**: Only one dev environment can run at a time
5. **Clear identification**: Easy to identify Notees dev processes
