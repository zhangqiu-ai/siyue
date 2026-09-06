#!/usr/bin/python3
"""Opt-in workaround for the locally observed Xcode 26.6 probe pipe deadlock."""
import os
from pathlib import Path
import signal
import subprocess
import sys


def find_tool(name):
    tool = subprocess.check_output(['/usr/bin/xcrun', '--find', name], text=True).strip()
    if not os.path.isabs(tool) or Path(tool).resolve() == Path(__file__).resolve():
        raise RuntimeError('xcrun resolved an invalid or recursive tool path')
    return tool


def build_args(args, directory):
    actions = {'build', 'test', 'archive', 'analyze', 'install', 'build-for-testing', 'test-without-building'}
    if not actions.intersection(args):
        return args
    result = list(args)
    for key, driver in [('CC', 'clang'), ('CXX', 'clang++')]:
        if not any(arg.startswith(key + '=') for arg in result):
            result.append(key + '=' + str(directory / driver))
    return result


def is_probe(args):
    return all(flag in args for flag in ['-v', '-E', '-dM']) and args[-2:] == ['-c', '/dev/null']


def main():
    name = Path(sys.argv[0]).name
    if name not in {'clang', 'clang++', 'xcodebuild'}:
        raise RuntimeError('Invoke this tool through clang, clang++, or xcodebuild')
    tool = find_tool(name)
    args = sys.argv[1:]
    if name == 'xcodebuild':
        args = build_args(args, Path(__file__).resolve().parent)
        os.execv(tool, [tool, *args])
    if not is_probe(args):
        os.execv(tool, [tool, *args])
    result = subprocess.run([tool, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for fd, data in [(1, result.stdout), (2, result.stderr)]:
            remaining = memoryview(data)
            while remaining:
                remaining = remaining[os.write(fd, remaining):]
            # EOF lets readers that drain stdout first proceed to stderr.
            os.close(fd)
    except BrokenPipeError:
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
        os.kill(os.getpid(), signal.SIGPIPE)
    if result.returncode < 0:
        signal.signal(-result.returncode, signal.SIG_DFL)
        os.kill(os.getpid(), -result.returncode)
    sys.exit(result.returncode)


if __name__ == '__main__':
    main()
