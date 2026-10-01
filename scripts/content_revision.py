"""Local, immutable revision snapshots. Never restores job state or publication receipts."""
import base64
import copy
import hashlib
import html
import json
import shutil
import uuid
from pathlib import Path

EXCLUDED = {'job.json', 'revision.json', 'error.json', 'receipt.json', 'publish-attempt.json'}


def artifact(path):
    return path.name not in EXCLUDED and not path.name.endswith('.tmp') and path.is_file()


def backup_path(folder, identifier):
    if not isinstance(identifier, str):
        raise ValueError('Invalid revision backup identifier')
    if str(uuid.UUID(identifier)) != identifier:
        raise ValueError('Invalid revision backup identifier')
    base = folder / 'revision-backups'
    target = base / identifier
    if base.is_symlink() or target.is_symlink():
        raise ValueError('Revision backup symlink is forbidden')
    return target


def snapshot(folder, identifier):
    target = backup_path(folder, identifier)
    if target.exists():
        raise ValueError('Revision already started; recover before retrying')
    target.parent.mkdir(exist_ok=True)
    staging = target.with_name(identifier + '.pending')
    staging.mkdir()
    files = {}
    for source in folder.iterdir():
        if artifact(source):
            if source.is_symlink():
                raise ValueError('Revision artifact symlink is forbidden')
            shutil.copyfile(source, staging / source.name)
            files[source.name] = hashlib.sha256(source.read_bytes()).hexdigest()
    (staging / '_snapshot.json').write_text(json.dumps({'files': files}))
    staging.rename(target)
    return target


def checked_snapshot(folder, identifier):
    target = backup_path(folder, identifier)
    if (target / '_snapshot.json').is_symlink():
        raise ValueError('Revision snapshot metadata symlink is forbidden')
    record = json.loads((target / '_snapshot.json').read_text())
    for name, checksum in record['files'].items():
        if Path(name).name != name or name in EXCLUDED or name == '_snapshot.json':
            raise ValueError('Invalid snapshot artifact path')
        path = target / name
        if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
            raise ValueError('Revision snapshot integrity check failed')
    return target, record['files']


def recover(folder, job):
    identifier = job.get('revisionId')
    if not identifier:
        raise ValueError('Missing revision identifier; legacy revision requires manual recovery')
    target = backup_path(folder, identifier)
    if not target.exists():
        return  # Snapshot commits before any artifact mutation.
    target, files = checked_snapshot(folder, identifier)
    for current in folder.iterdir():
        if artifact(current) and current.name not in files:
            current.unlink()
    for name in files:
        destination = folder / name
        if destination.is_symlink():
            destination.unlink()
        temporary = folder / (name + '.tmp')
        if temporary.is_symlink():
            raise ValueError('Revision restore temporary symlink is forbidden')
        shutil.copyfile(target / name, temporary)
        temporary.replace(destination)


def restore_panels(folder, identifier, plan, panels):
    source, files = checked_snapshot(folder, identifier)
    old = json.loads((source / 'production-plan.json').read_text())
    if len(old['panels']) != len(plan['panels']):
        raise ValueError('Revision backup panel count differs')
    if 'draft.json' in files:
        draft = json.loads((source / 'draft.json').read_text())
        failures = draft.get('failed_panels')
        # A global failure has no safe per-panel approval boundary.
        if (not isinstance(failures, list) or not failures
                or any(not isinstance(failure, dict) or type(failure.get('index')) is not int
                       or not 0 <= failure['index'] < len(old['panels'])
                       or failure['index'] in panels for failure in failures)):
            raise ValueError('Cannot restore an unapproved panel from a failed draft')
    # Validate every destination before the first copy, including dangling symlinks.
    for index in panels:
        for name in (f'art-{index}.png', f'accepted-art-{index}.json'):
            if (folder / name).is_symlink():
                raise ValueError('Revision restore destination symlink is forbidden')
    for index in panels:
        name = f'art-{index}.png'
        if name not in files:
            raise ValueError('Revision backup has no source artwork')
        shutil.copyfile(source / name, folder / name)
        accepted = f'accepted-art-{index}.json'
        if accepted in files:
            shutil.copyfile(source / accepted, folder / accepted)
        else:
            (folder / accepted).unlink(missing_ok=True)
        plan['panels'][index] = copy.deepcopy(old['panels'][index])
        if 'presentation' in plan:
            plan['presentation']['panels'][index] = copy.deepcopy(old['presentation']['panels'][index])


def verify_scope(folder, before, panels):
    old = json.loads((before / 'production-plan.json').read_text())
    new = json.loads((folder / 'production-plan.json').read_text())
    for index in panels:
        new['panels'][index] = copy.deepcopy(old['panels'][index])
        if 'presentation' in old:
            new['presentation']['panels'][index] = copy.deepcopy(old['presentation']['panels'][index])
    if old != new:
        raise ValueError('Revision changed unselected story or presentation')
    names = ['cover.jpg', 'cover-art.png', 'cast.png']
    for index in range(len(old['panels'])):
        if index not in panels:
            names += [f'art-{index}.png', f'card-{index}.jpg']
    for name in names:
        original, current = before / name, folder / name
        if original.exists() != current.exists() or (original.exists() and original.read_bytes() != current.read_bytes()):
            raise ValueError('Revision changed an unselected panel: ' + name)


def comparison(folder, before, request):
    def picture(path):
        if not path.is_file():
            return '<p>미리보기 없음</p>'
        return '<img src="data:image/jpeg;base64,' + base64.b64encode(path.read_bytes()).decode() + '">'
    parts = ['<!doctype html><meta charset="utf-8"><title>수정 전후 비교</title>',
             '<style>body{font-family:sans-serif}section{display:flex;gap:16px}figure{margin:0;width:48%}img{width:100%}</style>',
             '<h1>선택한 컷 수정 전후</h1><p>' + html.escape(request.get('instruction', '원복')) + '</p>']
    for index in request['panels']:
        parts += [f'<h2>{index + 1}컷</h2><section><figure><figcaption>이전</figcaption>',
                  picture(before / f'card-{index}.jpg'), '</figure><figure><figcaption>이후</figcaption>',
                  picture(folder / f'card-{index}.jpg'), '</figure></section>']
    (folder / 'comparison.html').write_text(''.join(parts))


def transact(folder, job, execute):
    request = json.loads((folder / 'revision.json').read_text())
    before = snapshot(folder, job.get('revisionId'))
    try:
        execute(folder, job)
        verify_scope(folder, before, request['panels'])
        comparison(folder, before, request)
        result = {'backupId': job['revisionId'], 'panels': request['panels'],
                  'operation': request.get('operation', 'revise')}
        (folder / 'revision-result.json').write_text(json.dumps(result))
    except BaseException:
        recover(folder, job)
        raise
