import subprocess
import sys
import os
import time
import signal
import socket
import webbrowser
import json
import psutil
from threading import Thread, Event
from pathlib import Path

# -------------------------
# Configuration
# -------------------------

FRONTEND_PORT = 5173
BACKEND_PORT = 8000
BACKEND_HOST = '0.0.0.0'
POSTGRES_PORT = 5432

# Unique identifier for this dev environment
DEV_ENV_MARKER = "NOTEES_DEV_ENVIRONMENT"
PID_FILE = Path(".dev_pids.json")

# Default PostgreSQL connection for local dev
# Uses 'postgres' superuser by default (change if you configured differently)
DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/notees'

COLORS = {
    'frontend': '\033[36m',  # Cyan
    'backend': '\033[35m',   # Magenta
    'postgres': '\033[34m',  # Blue
    'info': '\033[32m',      # Green
    'warn': '\033[33m',      # Yellow
    'error': '\033[31m',     # Red
    'reset': '\033[0m'
}

# -------------------------
# Helper functions
# -------------------------

def log(message, level='info'):
    """Print a colored log message."""
    color = COLORS.get(level, COLORS['reset'])
    print(f"{color}[{level.upper()}]{COLORS['reset']} {message}")

def find_postgres_bin():
    """Find PostgreSQL bin directory on Windows."""
    if sys.platform != 'win32':
        # On Unix, assume PostgreSQL is in PATH
        try:
            result = subprocess.run(['psql', '--version'], capture_output=True, timeout=5)
            return result.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False
    
    # Common PostgreSQL installation paths on Windows
    possible_paths = [
        Path(os.environ.get('PROGRAMFILES', 'C:\\Program Files')) / 'PostgreSQL',
        Path(os.environ.get('PROGRAMFILES(X86)', 'C:\\Program Files (x86)')) / 'PostgreSQL',
    ]
    
    for base_path in possible_paths:
        if base_path.exists():
            # Look for version directories (18, 17, 16, etc.)
            for version_dir in sorted(base_path.iterdir(), reverse=True):
                if version_dir.is_dir():
                    bin_dir = version_dir / 'bin'
                    if (bin_dir / 'psql.exe').exists():
                        return str(bin_dir)
    
    # Check if pg_ctl is in PATH
    try:
        result = subprocess.run(['pg_ctl', '--version'], capture_output=True, timeout=5)
        if result.returncode == 0:
            return 'PATH'  # PostgreSQL is in PATH
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    
    return None

def is_port_in_use(port):
    """Check if a port is actively listening (not just TIME_WAIT)."""
    # On Windows, check netstat for LISTENING state
    if sys.platform == 'win32':
        try:
            result = subprocess.run(
                ['netstat', '-ano'],
                capture_output=True,
                text=True,
                timeout=5
            )
            for line in result.stdout.splitlines():
                if f':{port}' in line and 'LISTENING' in line:
                    # Extract PID
                    parts = line.split()
                    if parts:
                        try:
                            pid = int(parts[-1])
                            if pid != 0:  # Skip system process
                                # Check if process exists
                                try:
                                    psutil.Process(pid)
                                    return True
                                except psutil.NoSuchProcess:
                                    pass
                        except (ValueError, IndexError):
                            pass
            return False
        except Exception:
            pass
    
    # Fallback to socket-based check
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1)
            if s.connect_ex(('127.0.0.1', port)) == 0:
                return True
    except:
        pass
    
    # Try IPv6
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as s:
            s.settimeout(1)
            if s.connect_ex(('::1', port)) == 0:
                return True
    except:
        pass
    
    return False

def read_pid_file():
    """Read PIDs from the PID file."""
    if not PID_FILE.exists():
        return None
    try:
        with open(PID_FILE, 'r') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return None

def write_pid_file(frontend_pid, backend_pid):
    """Write PIDs to the PID file."""
    try:
        with open(PID_FILE, 'w') as f:
            json.dump({
                'frontend': frontend_pid,
                'backend': backend_pid,
                'marker': DEV_ENV_MARKER
            }, f)
    except IOError as e:
        log(f"Failed to write PID file: {e}", 'warn')

def cleanup_pid_file():
    """Remove the PID file."""
    try:
        if PID_FILE.exists():
            PID_FILE.unlink()
    except IOError:
        pass

def is_notees_dev_process(pid):
    """Check if a PID is a Notees dev environment process."""
    try:
        proc = psutil.Process(pid)
        # Check if process exists and has our marker in environment
        env = proc.environ()
        return env.get(DEV_ENV_MARKER) == "1"
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        return False

def kill_previous_instance():
    """Kill any previous instance of the dev environment."""
    # First, try to use PID file
    pid_data = read_pid_file()
    killed_from_pid_file = False
    
    if pid_data:
        for name, pid in [('Frontend', pid_data.get('frontend')), ('Backend', pid_data.get('backend'))]:
            if not pid:
                continue
            
            try:
                proc = psutil.Process(pid)
                if is_notees_dev_process(pid):
                    log(f"Found previous {name} instance (PID {pid}), terminating...", 'warn')
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except psutil.TimeoutExpired:
                        log(f"Force killing {name} (PID {pid})", 'warn')
                        proc.kill()
                    killed_from_pid_file = True
                else:
                    log(f"PID {pid} exists but is not a Notees dev process, skipping", 'info')
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        
        cleanup_pid_file()
    
    # Also scan for any orphaned processes with our marker
    killed_orphans = False
    for proc in psutil.process_iter(['pid', 'name']):
        try:
            if is_notees_dev_process(proc.pid):
                log(f"Found orphaned Notees dev process: {proc.info['name']} (PID {proc.pid}), terminating...", 'warn')
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except psutil.TimeoutExpired:
                    log(f"Force killing orphaned process (PID {proc.pid})", 'warn')
                    proc.kill()
                killed_orphans = True
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass
    
    if killed_from_pid_file or killed_orphans:
        time.sleep(2)  # Give processes time to fully terminate and release ports
        log("Previous instance(s) terminated", 'info')

def wait_for_http(port, timeout=30):
    """Wait for an HTTP server to respond on the port."""
    import urllib.request
    import urllib.error
    start = time.time()
    while time.time() - start < timeout:
        try:
            # Use GET instead of HEAD - Vite doesn't handle HEAD well
            req = urllib.request.Request(f'http://127.0.0.1:{port}/')
            urllib.request.urlopen(req, timeout=2)
            return True
        except urllib.error.HTTPError as e:
            # Any HTTP response (even errors like 404, 405) means the server is up
            return True
        except (urllib.error.URLError, ConnectionRefusedError, OSError):
            pass
        time.sleep(0.5)
    return False

def check_prerequisites():
    """Verify all prerequisites are met before starting."""
    errors = []
    
    # Check directories exist
    if not Path('frontend').exists():
        errors.append("'frontend' directory not found")
    if not Path('app').exists():
        errors.append("'app' directory not found")
    
    # Check node_modules exists
    if not Path('frontend/node_modules').exists():
        errors.append("frontend/node_modules not found - run 'npm install' in frontend/")
    
    # Kill any previous instance
    kill_previous_instance()
    
    # Check if ports are still in use (by non-Notees processes)
    if is_port_in_use(FRONTEND_PORT):
        errors.append(f"Port {FRONTEND_PORT} is in use by another application. Please free it manually.")
    
    if is_port_in_use(BACKEND_PORT):
        errors.append(f"Port {BACKEND_PORT} is in use by another application. Please free it manually.")
    
    # Check PostgreSQL is installed
    pg_bin = find_postgres_bin()
    if not pg_bin:
        errors.append("PostgreSQL not found. Install with: winget install PostgreSQL.PostgreSQL.18")
    
    return errors


def get_pg_command(command):
    """Get full path to PostgreSQL command."""
    pg_bin = find_postgres_bin()
    if not pg_bin:
        return None
    
    if pg_bin == 'PATH':
        return command
    
    if sys.platform == 'win32':
        return str(Path(pg_bin) / f'{command}.exe')
    return str(Path(pg_bin) / command)

def check_postgres_running():
    """Check if PostgreSQL is running."""
    # On Windows, check the service
    if sys.platform == 'win32':
        try:
            result = subprocess.run(
                ['sc', 'query', 'postgresql-x64-18'],
                capture_output=True,
                timeout=5
            )
            return b'RUNNING' in result.stdout
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return False
    
    # On Unix, try psql
    psql = get_pg_command('psql')
    if not psql:
        return False
    
    try:
        result = subprocess.run(
            [psql, '-U', 'postgres', '-d', 'postgres', '-c', 'SELECT 1;'],
            capture_output=True,
            timeout=5,
            env={**os.environ, 'PGPASSWORD': 'postgres'},
            input=b'\n'  # Send newline in case of password prompt
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False

def ensure_database_exists():
    """Ensure the 'notees' database exists."""
    # Since database is already created, just verify service is running
    # We'll let the backend handle schema initialization
    if sys.platform == 'win32':
        log("Database 'notees' should exist (create manually if needed)", 'postgres')
        return True
    
    psql = get_pg_command('psql')
    if not psql:
        return False
    
    try:
        # Check if database exists
        result = subprocess.run(
            [psql, '-U', 'postgres', '-d', 'postgres', '-tAc', "SELECT 1 FROM pg_database WHERE datname='notees'"],
            capture_output=True,
            timeout=5,
            env={**os.environ, 'PGPASSWORD': 'postgres'},
            input=b'\n'
        )
        
        if result.returncode == 0 and b'1' in result.stdout:
            log("Database 'notees' already exists", 'postgres')
            return True
        
        # Create database
        log("Creating database 'notees'...", 'postgres')
        result = subprocess.run(
            [psql, '-U', 'postgres', '-d', 'postgres', '-c', 'CREATE DATABASE notees;'],
            capture_output=True,
            timeout=5,
            env={**os.environ, 'PGPASSWORD': 'postgres'},
            input=b'\n'
        )
        
        if result.returncode == 0:
            log("Database 'notees' created successfully", 'postgres')
            return True
        else:
            log(f"Failed to create database: {result.stderr.decode()}", 'error')
            return False
            
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        log(f"Error checking/creating database: {e}", 'error')
        return False

def start_postgres():
    """Ensure PostgreSQL service is running and database exists."""
    # Check if PostgreSQL is already running
    if check_postgres_running():
        log("PostgreSQL is already running", 'postgres')
        return ensure_database_exists()
    
    # On Windows, try to start the service
    if sys.platform == 'win32':
        log("Starting PostgreSQL service...", 'postgres')
        result = subprocess.run(
            ['sc', 'start', 'postgresql-x64-18'],  # Standard service name for PostgreSQL 18
            capture_output=True,
            timeout=30
        )
        
        # Wait for service to be ready
        log("Waiting for PostgreSQL to be ready...", 'postgres')
        for i in range(30):
            time.sleep(1)
            if check_postgres_running():
                log("PostgreSQL is ready", 'postgres')
                return ensure_database_exists()
        
        log("PostgreSQL service started but not accepting connections", 'warn')
        log("Try running 'sc start postgresql-x64-18' manually or check Services", 'warn')
        return False
    else:
        log("Please start PostgreSQL manually on your system", 'warn')
        return False

def kill_process_tree(proc):
    """Kill a process and all its children."""
    if proc.poll() is not None:
        return  # already stopped

    try:
        # Use psutil for cross-platform process tree killing
        parent = psutil.Process(proc.pid)
        children = parent.children(recursive=True)
        
        # Terminate children first
        for child in children:
            try:
                child.terminate()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        
        # Terminate parent
        parent.terminate()
        
        # Wait for termination
        gone, alive = psutil.wait_procs([parent] + children, timeout=5)
        
        # Force kill any that didn't terminate
        for p in alive:
            try:
                p.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
                
    except (psutil.NoSuchProcess, psutil.AccessDenied) as e:
        log(f"Error terminating process tree: {e}", 'warn')
        # Fallback to basic kill
        try:
            proc.kill()
        except:
            pass

def stream_output(process, name, prefix_color, stop_event):
    """Stream stdout and stderr from a process until stopped."""
    def read_stream(stream, is_err=False):
        while not stop_event.is_set():
            try:
                line = stream.readline()
                if not line:
                    break
                text = line.decode(errors='ignore').rstrip()
                if text:
                    color = COLORS.get(prefix_color, '')
                    output = f"{color}{name}:{COLORS['reset']} {text}"
                    print(output, file=sys.stderr if is_err else sys.stdout, flush=True)
            except Exception:
                break

    threads = [
        Thread(target=read_stream, args=(process.stdout, False), daemon=True),
        Thread(target=read_stream, args=(process.stderr, True), daemon=True),
    ]

    for t in threads:
        t.start()
    for t in threads:
        t.join()

def start_process(cmd, cwd=None, use_shell=False, env=None):
    """Start a process with proper process group handling and environment marker."""
    # Add our unique marker to the environment
    if env is None:
        env = os.environ.copy()
    else:
        env = env.copy()
    env[DEV_ENV_MARKER] = "1"
    
    if sys.platform == 'win32':
        return subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=use_shell,
            env=env,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
        )
    else:
        return subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            preexec_fn=os.setsid
        )

def wait_for_port(port, timeout=30):
    """Wait for a port to become available."""
    start = time.time()
    while time.time() - start < timeout:
        if is_port_in_use(port):
            # Double-check after a brief delay to ensure stability
            time.sleep(0.5)
            if is_port_in_use(port):
                return True
        time.sleep(0.5)
    return False

# -------------------------
# Main
# -------------------------

def main():
    print("\n" + "=" * 50)
    print("  Development Environment Launcher")
    print("=" * 50 + "\n")

    # Check prerequisites
    errors = check_prerequisites()
    if errors:
        log("Prerequisites check failed:", 'error')
        for err in errors:
            print(f"  • {err}")
        sys.exit(1)
    
    log("Prerequisites check passed", 'info')

    # Start PostgreSQL
    if not start_postgres():
        log("Failed to start PostgreSQL. Exiting.", 'error')
        sys.exit(1)

    # Set DATABASE_URL environment variable for backend
    os.environ['DATABASE_URL'] = DEFAULT_DATABASE_URL

    # Check if we have a virtual environment and use it
    venv_python = None
    if Path('.venv').exists():
        if sys.platform == 'win32':
            venv_python = Path('.venv/Scripts/python.exe')
        else:
            venv_python = Path('.venv/bin/python')
        if venv_python.exists():
            log(f"Using virtual environment at {venv_python}", 'info')
        else:
            venv_python = None
    
    python_exe = str(venv_python) if venv_python else 'python'

    processes = []

    try:
        # --- Frontend ---
        log(f"Starting frontend on port {FRONTEND_PORT}...")
        frontend = start_process(
            ['npm', 'run', 'dev'],
            cwd='frontend',
            use_shell=(sys.platform == 'win32')  # Only use shell on Windows for npm
        )
        frontend_stop = Event()
        frontend_thread = Thread(
            target=stream_output,
            args=(frontend, 'Frontend', 'frontend', frontend_stop),
            daemon=True
        )
        frontend_thread.start()
        processes.append((frontend, frontend_stop, frontend_thread, 'Frontend'))

        # --- Backend ---
        log(f"Starting backend on port {BACKEND_PORT}...")
        # Create environment with DATABASE_URL
        backend_env = os.environ.copy()
        backend_env['DATABASE_URL'] = DEFAULT_DATABASE_URL
        
        backend = start_process([
            python_exe, '-m', 'uvicorn',
            'app.main:app',
            '--reload',
            '--host', BACKEND_HOST,
            '--port', str(BACKEND_PORT)
        ], env=backend_env)
        backend_stop = Event()
        backend_thread = Thread(
            target=stream_output,
            args=(backend, 'Backend', 'backend', backend_stop),
            daemon=True
        )
        backend_thread.start()
        processes.append((backend, backend_stop, backend_thread, 'Backend'))

        # Write PID file for instance tracking
        write_pid_file(frontend.pid, backend.pid)
        log(f"Instance marker written (Frontend PID: {frontend.pid}, Backend PID: {backend.pid})", 'info')

        # Wait for services to be ready
        log("Waiting for services to start...")
        backend_ready = wait_for_http(BACKEND_PORT, timeout=30)
        # Frontend (Vite) - use port check since HTTP check can be flaky
        frontend_ready = wait_for_port(FRONTEND_PORT, timeout=30)

        if frontend_ready and backend_ready:
            print()
            log("All services running!", 'info')
            print(f"\n  Frontend:  {COLORS['frontend']}http://localhost:{FRONTEND_PORT}{COLORS['reset']}")
            print(f"  Backend:   {COLORS['backend']}http://localhost:{BACKEND_PORT}{COLORS['reset']}")
            print(f"  API Docs:  {COLORS['backend']}http://localhost:{BACKEND_PORT}/docs{COLORS['reset']}")
            print(f"  PostgreSQL:{COLORS['postgres']}localhost:{POSTGRES_PORT}{COLORS['reset']}")
            print(f"\n  Press {COLORS['warn']}Ctrl+C{COLORS['reset']} to stop all services.\n")
            
            # Optionally open browser (uncomment if desired)
            # webbrowser.open(f'http://localhost:{FRONTEND_PORT}')
        else:
            if not frontend_ready:
                log(f"Frontend failed to start on port {FRONTEND_PORT}", 'error')
            if not backend_ready:
                log(f"Backend failed to start on port {BACKEND_PORT}", 'error')

        # --- Wait loop ---
        while True:
            for proc, _, _, name in processes:
                if proc.poll() is not None:
                    log(f"{name} exited unexpectedly (code: {proc.returncode})", 'error')
                    raise KeyboardInterrupt
            time.sleep(1)

    except KeyboardInterrupt:
        print()
        log("Shutting down services...", 'warn')

        for proc, stop_event, thread, name in processes:
            log(f"Stopping {name}...", 'info')
            stop_event.set()
            kill_process_tree(proc)
            thread.join(timeout=3)

        # Clean up PID file
        cleanup_pid_file()
        
        # Note: PostgreSQL service is left running for faster restarts
        log("Development environment stopped (PostgreSQL still running)", 'info')
        if sys.platform == 'win32':
            log("To stop PostgreSQL: sc stop postgresql-x64-18", 'info')
        sys.exit(0)

if __name__ == "__main__":
    main()
