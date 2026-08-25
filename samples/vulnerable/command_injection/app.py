"""Intentionally vulnerable fixture demonstrating unsafe subprocess usage."""

import subprocess
import sys


def run_user_command(command: str) -> None:
    """Run input unsafely for the local AIKavach demonstration only."""

    subprocess.run(command, shell=True, check=False)


if __name__ == "__main__":
    run_user_command(" ".join(sys.argv[1:]))
