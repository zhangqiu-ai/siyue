#!/usr/bin/python3
"""Offline local tool verification; does not launch an Xcode build."""
import importlib.util
import json
from pathlib import Path
import subprocess
import threading

root = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('probe_wrapper', root / 'wrapper.py')
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)
sdk = subprocess.check_output(['/usr/bin/xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'], text=True).strip()
rows = []
for name in ['clang', 'clang++']:
    real = wrapper.find_tool(name)
    for language in ['c', 'objective-c', 'c++', 'objective-c++']:
        args = ['-v', '-E', '-dM', '-arch', 'arm64', '-isysroot', sdk, '-x', language, '-c', '/dev/null']
        expected = subprocess.run([real, *args], capture_output=True, timeout=15)
        actual = subprocess.Popen([str(root / name), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        timer = threading.Timer(15, actual.kill)
        timer.start()
        try:
            # Deliberately drain streams sequentially to exercise the EOF behavior.
            stdout = actual.stdout.read()
            stderr = actual.stderr.read()
            code = actual.wait()
        finally:
            timer.cancel()
            actual.stdout.close()
            actual.stderr.close()
        assert (code, stdout, stderr) == (expected.returncode, expected.stdout, expected.stderr), (name, language)
        assert code == 0, (name, language, code)
        rows.append({'driver': name, 'language': language, 'exit': code, 'streams_identical': True, 'sequential_reader': True})
    expected = subprocess.run([real, '--version'], capture_output=True, timeout=15)
    actual = subprocess.run([str(root / name), '--version'], capture_output=True, timeout=15)
    assert (actual.returncode, actual.stdout, actual.stderr) == (expected.returncode, expected.stdout, expected.stderr)
for args in [['-version'], ['-list'], ['-create-xcframework', '-output', 'test.xcframework']]:
    assert wrapper.build_args(args, root) == args
assert wrapper.build_args(['build'], root) == ['build', 'CC=' + str(root / 'clang'), 'CXX=' + str(root / 'clang++')]
assert wrapper.build_args(['build', 'CC=/custom/clang'], root)[1] == 'CC=/custom/clang'
expected = subprocess.run([wrapper.find_tool('xcodebuild'), '-version'], capture_output=True, timeout=15)
actual = subprocess.run([str(root / 'xcodebuild'), '-version'], capture_output=True, timeout=15)
assert (actual.returncode, actual.stdout, actual.stderr) == (expected.returncode, expected.stdout, expected.stderr)
print(json.dumps({'probes': rows, 'version_passthrough': True, 'shim_argument_checks': True}, indent=2))
