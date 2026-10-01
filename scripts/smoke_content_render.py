#!/usr/bin/env python3
"""Paid-API-free integration smoke for content_pipeline.render (run explicitly).

python3 scripts/smoke_content_render.py --source-root /path/to/waenyamyeon \
    --work-dir /tmp/content-render-smoke [--node-modules /path/to/linux/node_modules]

The work directory must not exist unless --resume-work explicitly reuses a prior
scratch repo/job. Copies renderer inputs/dependencies into a fresh workspace;
never modifies the source repository. Run in a Python environment with Pillow,
ffmpeg/ffprobe, Node, and compatible Remotion dependencies. Set
REMOTION_BROWSER_EXECUTABLE and REMOTION_CONCURRENCY as needed. Produces real
final.mp4, preview.mp4, five review frames and smoke-result.json under work-dir.
The old macOS 'say' WAV fixture proves wiring/cache behavior, not Gemini quality.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
from unittest.mock import patch

import content_pipeline as pipeline


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--work-dir', required=True, type=Path)
    parser.add_argument('--node-modules', type=Path, help='Compatible installed dependencies; copied, never modified')
    parser.add_argument('--resume-work', action='store_true', help='Resume an existing isolated repo/job without copying or replacing inputs')
    args = parser.parse_args()
    source = args.source_root.resolve()
    work = args.work_dir.resolve()
    if work.is_relative_to(source) or source.is_relative_to(work):
        parser.error('work-dir must be outside the source repository')
    root = work / 'repo'
    folder = work / 'job'
    if args.resume_work:
        if not root.is_dir() or not folder.is_dir() or root.is_symlink() or folder.is_symlink():
            parser.error('--resume-work requires existing real work-dir/repo and work-dir/job directories')
        if not (root / 'episodes/auto-smoke-offline.orig.json').is_file():
            parser.error('--resume-work requires the prior smoke episode')
    elif work.exists():
        parser.error('work-dir already exists; use a new path or explicitly --resume-work')
    dependencies = (root / 'node_modules' if args.resume_work else
                    args.node_modules or source / 'node_modules').resolve()
    if not (dependencies / '.bin/remotion').is_file():
        parser.error('installed platform-compatible Remotion dependencies are required')
    fixtures = source / 'assets/tts/ep001f-quality-preview'
    indices = (0, 3, 4, 8, 9)
    lines = []
    for index in indices:
        wav = fixtures / f'line_{index:02d}.wav'
        metadata = json.loads(wav.with_suffix('.json').read_text())
        if metadata['sha256'] != sha256(wav):
            parser.error(f'fixture checksum mismatch: {wav.name}')
        lines.append((metadata['speech']['text'], wav))
    art = [source / 'public/ep001' / f'{name}.png' for name in ('hook', 'lattice', 'lattice', 'tip', 'spoon')]
    for path in art:
        if not path.is_file():
            parser.error(f'missing artwork fixture: {path}')
    if not args.resume_work:
        work.mkdir(parents=True)
        root.mkdir()
        # Do not copy .env, git metadata, or unrelated generated media.
        for name in ('src', 'scripts', 'public/fonts', 'public/sfx'):
            shutil.copytree(source / name, root / name, ignore=shutil.ignore_patterns('__pycache__', '.env*'))
        for name in ('package.json', 'package-lock.json', 'tsconfig.json', 'remotion.config.ts'):
            shutil.copyfile(source / name, root / name)
        print('Copying installed dependencies into isolated workspace...', flush=True)
        shutil.copytree(dependencies, root / 'node_modules', symlinks=True,
                        ignore=shutil.ignore_patterns('.cache'))
        (root / 'episodes').mkdir()
        # Root.tsx imports this default at bundle time; --props selects the smoke episode.
        shutil.copyfile(source / 'episodes/ep001.json', root / 'episodes/ep001.json')
        folder.mkdir()
        for index, path in enumerate(art):
            shutil.copyfile(path, folder / f'art-{index}.png')
    sys.path.insert(0, str(root / 'scripts'))
    fixture = pipeline.module(root / 'scripts/test_auto_episode.py')
    audio = pipeline.module(root / 'scripts/build_audio.py')
    plan = {'caption': '로컬 렌더 배선 검증 — 게시하지 않는 테스트', 'panels': [
        {'text': text, 'visual': 'Scientific illustration matching the recorded narration.',
         'framing': ('wide', 'medium', 'close-up')[i % 3]} for i, (text, _) in enumerate(lines)]}
    saved_plan = folder / 'smoke-plan.json'
    if args.resume_work and saved_plan.exists():
        plan = json.loads(saved_plan.read_text())
    elif not args.resume_work:
        pipeline.dump(saved_plan, plan)
    # Older smoke runs have no saved plan; their deterministic fixture is unchanged.
    saved_direction = folder / 'direction.json'
    shots = (json.loads(saved_direction.read_text()) if args.resume_work and saved_direction.exists()
             else fixture.direction())
    job = {'id': 'smoke-offline', 'kind': 'waenyamyeon', 'topic': '전자레인지와 금속'}
    counts = {'tts': 0, 'audio_build': 0, 'render': 0, 'direction': 0}
    by_text = dict(lines)

    class FixtureTTS:
        def __init__(self, *args, **kwargs):
            pass

        def synth(self, text, out, style=None):
            if text not in by_text:
                raise AssertionError('Unexpected speech text; refusing any API fallback')
            shutil.copyfile(by_text[text], out)
            counts['tts'] += 1

    real_run = pipeline.run

    def isolated_run(command, cwd=None):
        command = [str(value) for value in command]
        script = Path(command[1]).name if len(command) > 1 else ''
        if script == 'build_audio.py':
            counts['audio_build'] += 1
            with patch.object(audio, 'GeminiTTS', FixtureTTS), patch.object(sys, 'argv', command[1:]):
                audio.main()
            return
        if script == 'check_episode.py':
            counts['render'] += 1
        elif Path(command[0]).name != 'ffmpeg':
            raise AssertionError('Unexpected subprocess; refusing paid API fallback')
        real_run(command, cwd)

    def direction(*args, **kwargs):
        counts['direction'] += 1
        return copy.deepcopy(shots)

    original_environment = dict(os.environ)
    isolated_environment = {key: value for key, value in original_environment.items()
                            if key not in ('CONTENT_VIDEO_MODEL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY')}
    isolated_environment['PYTHONDONTWRITEBYTECODE'] = '1'
    with patch.dict(os.environ, isolated_environment, clear=True), \
         patch.object(pipeline, 'gemini', side_effect=direction), \
         patch.object(pipeline, 'request', side_effect=AssertionError('Network APIs disabled in smoke')), \
         patch.object(pipeline, 'run', side_effect=isolated_run):
        print('First render: fixture speech, actual timeline/mix/Remotion/preview...', flush=True)
        media, previews = pipeline.render(folder, root, job, plan)
        first_counts = counts.copy()
        final = folder / 'final.mp4'
        first_hash = sha256(final)
        first_mtime = final.stat().st_mtime_ns
        if not args.resume_work and (counts['tts'], counts['audio_build'], counts['render']) != (5, 1, 1):
            raise AssertionError(f'Unexpected first-run counts: {counts}')
        print('Second render: asserting speech and full render reuse...', flush=True)
        pipeline.render(folder, root, job, plan)
        if any(counts[key] != first_counts[key] for key in ('tts', 'audio_build', 'render')):
            raise AssertionError(f'Cache reuse failed: {first_counts} -> {counts}')
        if sha256(final) != first_hash or final.stat().st_mtime_ns != first_mtime:
            raise AssertionError('Cached final video was rewritten')
    frames = sorted(folder.glob('review-frame-*.jpg'))
    if len(frames) != 5 or not all(path.stat().st_size for path in frames):
        raise AssertionError('Expected five real full-resolution review frames')
    result = {'status': 'passed', 'resumed': args.resume_work, 'counts': counts, 'media': media, 'previews': previews,
              'review_frames': [path.name for path in frames], 'final_sha256': first_hash,
              'fixture_voice': 'existing say/Yuna audio; Gemini quality is not evaluated',
              'paid_api_calls': 0, 'published': False}
    pipeline.dump(work / 'smoke-result.json', result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f'Artifacts: {folder}')


if __name__ == '__main__':
    main()
