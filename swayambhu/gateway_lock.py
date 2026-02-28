"""Gateway singleton lock using port binding.

The OS kernel guarantees only one process can bind a given port.
On crash/kill the socket is released automatically — no stale locks.
"""

import socket

_lock_socket: socket.socket | None = None


def acquire_gateway_lock(port: int) -> bool:
    """Bind 127.0.0.1:{port} as a singleton lock. Returns True if acquired."""
    global _lock_socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("127.0.0.1", port))
        sock.listen(1)
        _lock_socket = sock
        return True
    except OSError:
        sock.close()
        return False


def release_gateway_lock() -> None:
    """Close the lock socket if held."""
    global _lock_socket
    if _lock_socket is not None:
        _lock_socket.close()
        _lock_socket = None
