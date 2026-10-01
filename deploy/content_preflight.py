"""Offline runtime checks before replacing the running bot. No model or publish calls."""
import importlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    for module in ('PIL', 'google.genai', 'boto3'):
        importlib.import_module(module)
    for command in ('ffmpeg', 'ffprobe', 'node', 'npm'):
        if not shutil.which(command):
            raise RuntimeError(f'Missing runtime tool: {command}')
    video = Path(os.environ['WAENYAMYEON_ROOT'])
    toon = Path(os.environ['INSTATOON_ROOT'])
    for root, files in (
        (video, ('episodes/ep001.json', 'public/anchor/anchor.png', 'public/fonts/IBMPlexSansKR-Regular.ttf', 'public/fonts/IBMPlexSansKR-Bold.ttf', 'public/fonts/IBMPlexMono-Regular.ttf', 'scripts/build_audio.py', 'scripts/check_episode.py', 'scripts/auto_episode.py', 'src/fonts.ts',
                 'public/fonts/IBMPlexSansKR-Regular.ttf', 'public/fonts/IBMPlexSansKR-Bold.ttf',
                 'public/fonts/IBMPlexMono-Regular.ttf', 'node_modules/@remotion/renderer/package.json')),
        (toon, ('bible/sheets/core-cast-turnaround-v1.png', 'scripts/render_episode.py', 'fonts/BMKIRANGHAERANG-OTF.otf', 'fonts/Pretendard-SemiBold.ttf')),
    ):
        for name in files:
            if not (root / name).is_file():
                raise RuntimeError(f'Missing content asset: {root / name}')
        for name in ('', 'episodes', 'public', 'assets') if root == video else ('',):
            target = root / name
            target.mkdir(exist_ok=True)
            with tempfile.TemporaryFile(dir=target):
                pass
    subprocess.run(['node', '-e', "require('@remotion/renderer')"], cwd=video, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    browser = os.environ['REMOTION_BROWSER_EXECUTABLE']
    with tempfile.TemporaryDirectory() as profile:
        subprocess.run([browser, '--headless', '--no-sandbox', '--disable-gpu',
                        f'--user-data-dir={profile}', '--dump-dom', 'about:blank'],
                       timeout=30, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run([sys.executable, str(Path(__file__).with_name('instatoon_preflight.py')),
                    '--root', str(toon), '--pipeline', str(Path(__file__).resolve().parents[1] / 'scripts/content_pipeline.py')],
                   timeout=120, check=True)
    print('Content runtime preflight passed (assets, permissions, Python, Remotion, Chromium).')


if __name__ == '__main__':
    main()
