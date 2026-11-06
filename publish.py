#!/usr/bin/env python3
"""
Публикация сайта в публичный репозиторий GitHub (GitHub Pages).

Копирует ТОЛЬКО файлы сайта (без ref/, config.local.json, data/, .claude/)
во временную папку .publish/ — отдельный git-клон публичного репозитория —
и пушит изменения. Локальная история проекта не публикуется.

Нужен авторизованный GitHub CLI (gh auth login).

    python publish.py                      # репозиторий по умолчанию
    python publish.py owner/repo           # другой репозиторий
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = sys.argv[1] if len(sys.argv) > 1 else 'stayson454/cryptoterminal'
OUT = os.path.join(ROOT, '.publish')
SITE_FILES = [
    'index.html', 'styles.css',
    'storage-db.js', 'data-engine.js', 'chart-renderer.js', 'indicators.js', 'margin-page.js', 'app.js',
    'server.py', 'publish.py', 'README.md', '.gitignore', '.nojekyll',
]


def run(*cmd, cwd=None, check=True):
    print('$', ' '.join(cmd))
    return subprocess.run(cmd, cwd=cwd, check=check, text=True)


def main():
    if not os.path.isdir(os.path.join(OUT, '.git')):
        if os.path.exists(OUT):
            shutil.rmtree(OUT)
        run('gh', 'repo', 'clone', REPO, OUT)
    else:
        run('git', 'pull', '--ff-only', cwd=OUT)
    for name in SITE_FILES:
        src = os.path.join(ROOT, name)
        if not os.path.exists(src):
            print('нет файла:', name)
            continue
        shutil.copy2(src, os.path.join(OUT, name))
    run('git', 'add', '-A', cwd=OUT)
    if subprocess.run(['git', 'diff', '--cached', '--quiet'], cwd=OUT).returncode == 0:
        print('Изменений нет — публиковать нечего.')
        return
    run('git', 'commit', '-m', 'Обновление сайта', cwd=OUT)
    run('git', 'push', cwd=OUT)
    owner, name = REPO.split('/')
    print('Готово. Сайт обновится через 1–2 минуты: https://%s.github.io/%s/' % (owner.lower(), name))


if __name__ == '__main__':
    main()
