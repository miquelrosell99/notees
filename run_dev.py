import subprocess
import sys
import os
import time
import signal
import socket
import webbrowser
from threading import Thread, Event
from pathlib import Path

# -------------------------
# Configuration
# -------------------------

FRONTEND_PORT = 5173
BACKEND_PORT = 8000
BACKEND_HOST = '0.0.0.0'
POSTGRES_PORT = 5432
POSTGRES_CONTAINER = 'notees-postgres-local'

# Default PostgreSQL connection for local dev
DEFAULT_DATABASE_URL = 'postgresql://notees:change_me_dev_password@localhost:5432/notees'

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

def is_port_in_use(port):
    """Check if a port is already in use."""
    # Try IPv4
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(('127.0.0.1', port)) == 0:
            return True
    # Try IPv6 (Vite often binds to ::1)
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as s:
            if s.connect_ex(('::1', port)) == 0:
                return True
    except OSError:
        pass
    # Try localhost (let OS resolve)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            if s.connect_ex(('localhost', port)) == 0:
                return True
        except OSError:
            pass
    return False

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
    
    # Check ports are available (excluding postgres, we'll start it)
    if is_port_in_use(FRONTEND_PORT):
        errors.append(f"Port {FRONTEND_PORT} is already in use (frontend)")
    if is_port_in_use(BACKEND_PORT):
        errors.append(f"Port {BACKEND_PORT} is already in use (backend)")
    
    # Check Docker is available for PostgreSQL
    try:
        result = subprocess.run(['docker', '--version'], capture_output=True, timeout=5)
        if result.returncode != 0:
            errors.append("Docker is required for PostgreSQL. Install Docker Desktop.")
    except FileNotFoundError:
        errors.append("Docker is required for PostgreSQL. Install Docker Desktop.")
    except subprocess.TimeoutExpired:
        errors.append("Docker check timed out. Is Docker running?")
    
    return errors


def start_postgres():
    """Start PostgreSQL container if not running."""
    # Check if container exists and is running
    result = subprocess.run(
        ['docker', 'ps', '-q', '-f', f'name={POSTGRES_CONTAINER}'],
        capture_output=True, text=True
    )
    
    if result.stdout.strip():
        log(f"PostgreSQL container '{POSTGRES_CONTAINER}' is already running", 'postgres')
        return True
    
    # Check if container exists but is stopped
    result = subprocess.run(
        ['docker', 'ps', '-aq', '-f', f'name={POSTGRES_CONTAINER}'],
        capture_output=True, text=True
    )
    
    if result.stdout.strip():
        log(f"Starting existing PostgreSQL container '{POSTGRES_CONTAINER}'...", 'postgres')
        result = subprocess.run(['docker', 'start', POSTGRES_CONTAINER], capture_output=True)
        if result.returncode != 0:
            log(f"Failed to start PostgreSQL container: {result.stderr.decode()}", 'error')
            return False
    else:
        # Create new container
        log(f"Creating PostgreSQL container '{POSTGRES_CONTAINER}'...", 'postgres')
        result = subprocess.run([
            'docker', 'run', '-d',
            '--name', POSTGRES_CONTAINER,
            '-e', 'POSTGRES_USER=notees',
            '-e', 'POSTGRES_PASSWORD=change_me_dev_password',
            '-e', 'POSTGRES_DB=notees',
            '-p', f'{POSTGRES_PORT}:5432',
            'postgres:16-alpine'
        ], capture_output=True)
        
        if result.returncode != 0:
            log(f"Failed to create PostgreSQL container: {result.stderr.decode()}", 'error')
            return False
    
    # Wait for PostgreSQL to be ready
    log("Waiting for PostgreSQL to be ready...", 'postgres')
    for i in range(30):
        time.sleep(1)
        result = subprocess.run([
            'docker', 'exec', POSTGRES_CONTAINER,
            'pg_isready', '-U', 'notees', '-d', 'notees'
        ], capture_output=True)
        if result.returncode == 0:
            log("PostgreSQL is ready", 'postgres')
            return True
    
    log("PostgreSQL failed to start within timeout", 'error')
    return False


def stop_postgres():
    """Stop PostgreSQL container."""
    log(f"Stopping PostgreSQL container '{POSTGRES_CONTAINER}'...", 'postgres')
    subprocess.run(['docker', 'stop', POSTGRES_CONTAINER], capture_output=True)

def kill_process_tree(proc):
    """Kill a process and all its children."""
    if proc.poll() is not None:
        return  # already stopped

    try:
        if sys.platform == 'win32':
            # Use taskkill to kill the entire process tree on Windows
            subprocess.run(
                ['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                capture_output=True
            )
        else:
            # Unix: terminate the whole process group
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception as e:
        log(f"Error sending termination signal: {e}", 'warn')

    # Wait a bit, then force kill if still running
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        log(f"Process didn't stop gracefully, forcing kill...", 'warn')
        proc.kill()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
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

def start_process(cmd, cwd=None, use_shell=False):
    """Start a process with proper process group handling."""
    if sys.platform == 'win32':
        return subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=use_shell,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
        )
    else:
        return subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
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
        backend = start_process([
            'python', '-m', 'uvicorn',
            'app.main:app',
            '--reload',
            '--host', BACKEND_HOST,
            '--port', str(BACKEND_PORT)
        ])
        backend_stop = Event()
        backend_thread = Thread(
            target=stream_output,
            args=(backend, 'Backend', 'backend', backend_stop),
            daemon=True
        )
        backend_thread.start()
        processes.append((backend, backend_stop, backend_thread, 'Backend'))

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

        # Note: PostgreSQL container is left running for faster restarts
        # To stop it, run: docker stop notees-postgres-local
        log("Development environment stopped (PostgreSQL still running)", 'info')
        log(f"To stop PostgreSQL: docker stop {POSTGRES_CONTAINER}", 'info')
        sys.exit(0)

if __name__ == "__main__":
    main()
